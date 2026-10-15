using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Calvras.Core.Models;

namespace Calvras.Core.Services;

public record AgentRunOutcome(string Status, string? Message, string? Error, string? Plan);

public interface IAgentRunner
{
    Task<AgentRunOutcome> RunAsync(
        string prompt,
        string projectPath,
        Action<AgentPhaseModel> onPhaseAdded,
        Action<AgentPhaseModel> onPhaseUpdated,
        Action<string> onToken,
        IReadOnlyList<(string role, string content)>? conversationHistory = null,
        IReadOnlyList<string>? attachedImages = null,
        CancellationToken cancellationToken = default);
}

public class AgentRunner : IAgentRunner
{
    private readonly ICalvrasApiClient _apiClient;
    private readonly IFilesystemService _fs;
    private readonly IProcessRunner _process;
    private readonly IAgentToolService _toolService;

    public AgentRunner(
        ICalvrasApiClient apiClient,
        IFilesystemService fs,
        IProcessRunner process,
        IAgentToolService? toolService = null)
    {
        _apiClient = apiClient;
        _fs = fs;
        _process = process;
        _toolService = toolService ?? new AgentToolService(process);
    }

    public async Task<AgentRunOutcome> RunAsync(
        string prompt,
        string projectPath,
        Action<AgentPhaseModel> onPhaseAdded,
        Action<AgentPhaseModel> onPhaseUpdated,
        Action<string> onToken,
        IReadOnlyList<(string role, string content)>? conversationHistory = null,
        IReadOnlyList<string>? attachedImages = null,
        CancellationToken cancellationToken = default)
    {
        var history = new List<string>();
        int invalidReplies = 0;
        int executedActions = 0;
        string? activePlan = null;
        string? detectedLocalhostUrl = null;

        // Pre-scan and understand folder context before first prompt
        string workspaceOverview = await _toolService.BuildWorkspaceOverviewAsync(projectPath);

        for (int step = 0; step < 25; step++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var fullPrompt = history.Count > 0 ? $"{prompt}\n\n{string.Join("\n\n", history)}" : prompt;
            string rawInference;
            try
            {
                rawInference = await _apiClient.CallAgentInferenceAsync(
                    fullPrompt,
                    workspaceOverview,
                    step == 0 ? conversationHistory : null,
                    step == 0 ? attachedImages : null,
                    cancellationToken);
            }
            catch (Exception ex)
            {
                return new AgentRunOutcome("blocked", null, ex.Message, activePlan);
            }

            AgentReplyModel reply;
            try
            {
                reply = ParseReply(rawInference);
            }
            catch
            {
                if (++invalidReplies >= 2)
                    return new AgentRunOutcome("blocked", null, "Failed to parse agent JSON reply.", activePlan);

                history.Add("[RESPONSE FORMAT ERROR] Return valid JSON with message, actions, and status.");
                continue;
            }
            invalidReplies = 0;

            if (!string.IsNullOrWhiteSpace(reply.Plan))
            {
                activePlan = reply.Plan;
            }

            // If no actions: finished or blocked
            if (reply.Actions == null || reply.Actions.Count == 0)
            {
                if (reply.Status == "blocked")
                    return new AgentRunOutcome("blocked", reply.Message, null, activePlan);

                var message = reply.Message ?? string.Empty;

                // Ensure localhost link is prominently displayed if a dev server was started
                if (!string.IsNullOrWhiteSpace(detectedLocalhostUrl) && !message.Contains(detectedLocalhostUrl))
                {
                    message = message.TrimEnd() + $"\n\n🔗 **Local Dev Server**: [{detectedLocalhostUrl}]({detectedLocalhostUrl})";
                }

                if (!string.IsNullOrWhiteSpace(message))
                {
                    int chunkSize = 4;
                    for (int i = 0; i < message.Length; i += chunkSize)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var chunk = message.Substring(i, Math.Min(chunkSize, message.Length - i));
                        onToken(chunk);
                        await Task.Delay(12, cancellationToken);
                    }
                }
                return new AgentRunOutcome("finished", message, null, activePlan);
            }

            // Create phase with initial running trace nodes
            var traceNodes = new List<TraceNodeModel>();
            foreach (var action in reply.Actions)
            {
                traceNodes.Add(new TraceNodeModel
                {
                    Type = action.Type == "run_command" || action.Type == "run_terminal" ? "terminal" : "tool",
                    ToolName = action.Type,
                    Primary = GetActionLabel(action.Type),
                    Icon = GetActionIcon(action.Type),
                    Secondary = action.Command ?? action.Path ?? action.Query ?? action.Url ?? ".",
                    Status = "running",
                    Command = action.Command
                });
            }

            var phase = new AgentPhaseModel
            {
                Trace = traceNodes,
                Message = !string.IsNullOrWhiteSpace(reply.Message) ? reply.Message : null
            };
            onPhaseAdded(phase);

            // Execute each action in sequence using AgentToolService
            var toolResults = new List<object>();
            for (int i = 0; i < reply.Actions.Count; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var action = reply.Actions[i];
                var node = traceNodes[i];

                try
                {
                    var result = await _toolService.ExecuteToolAsync(action, projectPath, cancellationToken);

                    if (!string.IsNullOrEmpty(result.LocalhostUrl))
                    {
                        detectedLocalhostUrl = result.LocalhostUrl;
                    }

                    traceNodes[i] = node with
                    {
                        Status = result.Ok ? "completed" : "failed",
                        Output = result.Output.Length > 1000 ? result.Output.Substring(0, 1000) + "..." : result.Output,
                        LocalhostUrl = result.LocalhostUrl,
                        ExitCode = result.ExitCode,
                        DiffFile = result.DiffFile,
                        DiffRows = result.DiffRows,
                        Add = result.Add,
                        Del = result.Del
                    };

                    toolResults.Add(new
                    {
                        action = action.Type,
                        ok = result.Ok,
                        output = result.Output,
                        localhostUrl = result.LocalhostUrl,
                        exitCode = result.ExitCode
                    });
                }
                catch (Exception ex)
                {
                    traceNodes[i] = node with
                    {
                        Status = "failed",
                        Output = ex.Message
                    };
                    toolResults.Add(new { action = action.Type, ok = false, error = ex.Message });
                }

                executedActions++;
                onPhaseUpdated(phase with { Trace = new List<TraceNodeModel>(traceNodes) });
            }

            history.Add($"[AGENT UPDATE]\n{reply.Message}\n[ACTUAL TOOL RESULTS]\n{JsonSerializer.Serialize(toolResults)}");
        }

        return new AgentRunOutcome("limit", null, "Maximum step limit reached.", activePlan);
    }

    private static string GetActionLabel(string type) => type?.ToLowerInvariant() switch
    {
        // File Operations
        "read_file" => "Read file",
        "write_file" => "Write file",
        "create_file" => "Create file",
        "list_files" or "list_dir" => "List files",
        "rename_file" => "Rename file",
        "move_file" => "Move file",
        "copy_file" => "Copy file",
        "get_file_info" => "File info",
        "directory_tree" => "Directory tree",

        // Search & Code Navigation
        "grep_search" => "Grep search",
        "find_files" => "Find files",
        "search_symbols" => "Search symbols",
        "go_to_definition" => "Go to definition",
        "find_references" => "Find references",
        "get_hover_info" => "Hover info",
        "list_symbols" => "List symbols",
        "read_diagnostics" => "Read diagnostics",

        // Code Editing
        "search_replace" or "edit_file" => "Search & replace",
        "multi_replace" => "Multi replace",
        "insert_code" => "Insert code",
        "delete_lines" => "Delete lines",
        "undo_edit" => "Undo edit",
        "apply_patch" => "Apply patch",
        "format_file" => "Format file",
        "format_code" => "Format code",
        "organize_imports" => "Organize imports",

        // Terminal & Execution
        "run_command" or "run_terminal" => "Run command",
        "run_code" => "Run code",
        "install_dependencies" => "Install dependencies",
        "start_dev_server" => "Start dev server",
        "stop_dev_server" => "Stop dev server",
        "get_terminal_output" => "Terminal output",
        "run_background_process" => "Background process",

        // Debugging & Testing
        "run_tests" => "Run tests",
        "run_single_test" => "Run single test",
        "run_linter" => "Run linter",
        "run_typecheck" => "Typecheck",
        "run_build" => "Run build",
        "get_errors" => "Get errors",
        "get_stack_trace" => "Get stack trace",
        "debug_code" => "Debug code",

        // Git & Version Control
        "git_status" => "Git status",
        "git_diff" or "git_show_diff" => "Git diff",
        "git_log" => "Git log",
        "git_add" => "Git add",
        "git_commit" => "Git commit",
        "git_checkout" => "Git checkout",
        "git_branch" => "Git branch",
        "git_restore" => "Git restore",

        // Project Understanding
        "analyze_project" or "analyze_codebase" => "Analyze project",
        "detect_framework" => "Detect framework",
        "read_project_structure" => "Project structure",
        "read_package_json" => "Read package.json",
        "find_entry_point" => "Find entry point",
        "map_dependencies" or "inspect_dependencies" => "Map dependencies",
        "trace_function_calls" => "Trace calls",

        // Browser & UI Testing
        "open_browser" => "Open browser",
        "navigate_browser" => "Navigate browser",
        "take_screenshot" => "Take screenshot",
        "click_element" => "Click element",
        "fill_input" => "Fill input",
        "inspect_element" => "Inspect element",
        "check_console_errors" => "Check console",
        "test_responsive_layout" => "Test layout",

        // Agent Intelligence
        "plan_tasks" or "create_task_list" => "Plan tasks",
        "delegate_task" => "Delegate task",
        "request_user_approval" => "Request approval",
        "track_progress" => "Track progress",
        "summarize_changes" => "Summarize changes",
        "verify_changes" => "Verify changes",
        "ask_subagent" => "Ask subagent",

        // Advanced Features
        "apply_diff" => "Apply diff",
        "multi_file_edit" => "Multi-file edit",
        "refactor_code" => "Refactor code",
        "generate_tests" => "Generate tests",
        "resolve_imports" => "Resolve imports",
        "detect_security_issues" => "Security check",
        "explain_code" => "Explain code",
        "generate_documentation" => "Generate docs",
        "manage_environment_variables" => "Manage .env",
        "rollback_changes" => "Rollback changes",

        _ => "Execute tool"
    };

    private static string GetActionIcon(string type) => type?.ToLowerInvariant() switch
    {
        "read_file" or "write_file" or "create_file" or "rename_file" or "move_file" or "copy_file"
            or "search_replace" or "edit_file" or "multi_replace" or "insert_code" or "delete_lines"
            or "undo_edit" or "apply_patch" or "format_file" or "format_code" or "organize_imports"
            or "multi_file_edit" or "refactor_code" or "apply_diff" => "✏️",

        "open_browser" or "navigate_browser" or "take_screenshot" or "click_element"
            or "fill_input" or "inspect_element" or "check_console_errors" or "test_responsive_layout" => "🌐",

        "grep_search" or "find_files" or "search_symbols" or "find_references"
            or "get_hover_info" or "list_symbols" => "🔍",

        "git_status" or "git_diff" or "git_log" or "git_add" or "git_commit"
            or "git_checkout" or "git_branch" or "git_restore" or "git_show_diff" => "🌿",

        "run_tests" or "run_single_test" or "run_linter" or "run_typecheck" or "run_build" => "🧪",

        "run_command" or "run_terminal" or "run_code" or "install_dependencies"
            or "start_dev_server" or "stop_dev_server" or "get_terminal_output" or "run_background_process" => "⚡",

        _ => "🔧"
    };

    private static AgentReplyModel ParseReply(string raw)
    {
        var cleaned = raw.Trim();
        if (cleaned.StartsWith("```json")) cleaned = cleaned.Substring(7);
        else if (cleaned.StartsWith("```")) cleaned = cleaned.Substring(3);
        if (cleaned.EndsWith("```")) cleaned = cleaned.Substring(0, cleaned.Length - 3);
        cleaned = cleaned.Trim();

        var reply = JsonSerializer.Deserialize<AgentReplyModel>(cleaned, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (reply == null) throw new InvalidOperationException("Null reply");
        return reply;
    }
}
