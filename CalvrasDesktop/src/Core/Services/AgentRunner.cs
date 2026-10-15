using System;
using System.Collections.Generic;
using System.IO;
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
        CancellationToken cancellationToken = default);
}

public class AgentRunner : IAgentRunner
{
    private readonly ICalvrasApiClient _apiClient;
    private readonly IFilesystemService _fs;
    private readonly IProcessRunner _process;

    public AgentRunner(ICalvrasApiClient apiClient, IFilesystemService fs, IProcessRunner process)
    {
        _apiClient = apiClient;
        _fs = fs;
        _process = process;
    }

    public async Task<AgentRunOutcome> RunAsync(
        string prompt,
        string projectPath,
        Action<AgentPhaseModel> onPhaseAdded,
        Action<AgentPhaseModel> onPhaseUpdated,
        Action<string> onToken,
        CancellationToken cancellationToken = default)
    {
        var history = new List<string>();
        int invalidReplies = 0;
        int executedActions = 0;
        string? activePlan = null;

        for (int step = 0; step < 24; step++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            string projectSnapshot = string.Empty;
            try
            {
                var tree = await _fs.GetTreeAsync(projectPath);
                projectSnapshot = $"Files in workspace:\n{string.Join("\n", tree.Take(40))}";
            }
            catch { }

            var fullPrompt = history.Count > 0 ? $"{prompt}\n\n{string.Join("\n\n", history)}" : prompt;
            string rawInference;
            try
            {
                rawInference = await _apiClient.CallAgentInferenceAsync(fullPrompt, projectSnapshot, cancellationToken);
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

                // Stream reply.Message token by token — no second API call needed.
                // The model already returned the conversational reply in the message field.
                var message = reply.Message ?? string.Empty;
                if (!string.IsNullOrWhiteSpace(message))
                {
                    // Simulate natural streaming: emit in small chunks so the UI types it in
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
                    Type = action.Type == "run_command" ? "terminal" : "tool",
                    ToolName = action.Type,
                    Primary = GetActionLabel(action.Type),
                    Secondary = action.Command ?? action.Path ?? ".",
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

            // Execute each action in sequence
            var toolResults = new List<object>();
            for (int i = 0; i < reply.Actions.Count; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var action = reply.Actions[i];
                var node = traceNodes[i];

                try
                {
                    if (action.Type == "run_command" && !string.IsNullOrWhiteSpace(action.Command))
                    {
                        var result = await _process.ExecuteCommandAsync(action.Command, projectPath, cancellationToken);
                        traceNodes[i] = node with
                        {
                            Status = result.ExitCode == 0 ? "completed" : "failed",
                            Output = result.Output,
                            ExitCode = result.ExitCode,
                            DurationMs = (int)result.DurationMs
                        };
                        toolResults.Add(new { action = action.Type, command = action.Command, ok = result.ExitCode == 0, output = result.Output, exitCode = result.ExitCode });
                    }
                    else if ((action.Type == "create_file" || action.Type == "write_file") && !string.IsNullOrWhiteSpace(action.Path))
                    {
                        var diff = await _fs.WriteFileAsync(projectPath, action.Path, action.Content ?? "");
                        traceNodes[i] = node with
                        {
                            Status = "completed",
                            DiffFile = action.Path,
                            DiffRows = diff,
                            Add = diff.Count(d => d.Type == "add"),
                            Del = diff.Count(d => d.Type == "del")
                        };
                        toolResults.Add(new { action = action.Type, path = action.Path, ok = true });
                    }
                    else if (action.Type == "edit_file" && !string.IsNullOrWhiteSpace(action.Path))
                    {
                        var diff = await _fs.EditFileAsync(projectPath, action.Path, action.LineStart ?? 1, action.LineEnd ?? 1, action.NewContent ?? "");
                        traceNodes[i] = node with
                        {
                            Status = "completed",
                            DiffFile = action.Path,
                            DiffRows = diff,
                            Add = diff.Count(d => d.Type == "add"),
                            Del = diff.Count(d => d.Type == "del")
                        };
                        toolResults.Add(new { action = action.Type, path = action.Path, ok = true });
                    }
                    else if (action.Type == "read_file" && !string.IsNullOrWhiteSpace(action.Path))
                    {
                        var text = await _fs.ReadFileAsync(projectPath, action.Path);
                        traceNodes[i] = node with
                        {
                            Status = "completed",
                            Output = text.Length > 800 ? text.Substring(0, 800) + "..." : text
                        };
                        toolResults.Add(new { action = action.Type, path = action.Path, ok = true, lines = text.Split('\n').Length });
                    }
                    else if (action.Type == "list_dir")
                    {
                        var entries = await _fs.ListDirAsync(projectPath, action.Path);
                        traceNodes[i] = node with
                        {
                            Status = "completed",
                            Output = string.Join("\n", entries)
                        };
                        toolResults.Add(new { action = action.Type, path = action.Path, ok = true, count = entries.Count });
                    }
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

    private static string GetActionLabel(string type) => type switch
    {
        "create_file" => "Create file",
        "write_file" => "Write file",
        "edit_file" => "Patch file",
        "read_file" => "Read file",
        "list_dir" => "Inspect folder",
        "run_command" => "Run command",
        _ => "Execute tool"
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
