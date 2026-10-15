using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Calvras.Core.Models;
using Calvras.Core.Services;
using Xunit;

namespace Calvras.Core.Tests;

public class ToolEngineTests : IDisposable
{
    private readonly string _testWorkspace;
    private readonly AgentToolService _toolService;

    public ToolEngineTests()
    {
        _testWorkspace = Path.Combine(Path.GetTempPath(), "CalvrasTest_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_testWorkspace);
        _toolService = new AgentToolService(new ProcessRunner());

        // Prepare dummy project structure
        Directory.CreateDirectory(Path.Combine(_testWorkspace, "src"));
        File.WriteAllText(Path.Combine(_testWorkspace, "package.json"), "{\n  \"name\": \"test-app\",\n  \"dependencies\": {\n    \"react\": \"^18.2.0\"\n  }\n}");
        File.WriteAllText(Path.Combine(_testWorkspace, "src", "App.tsx"), "import React from 'react';\n\nexport class MainService {\n  run() {}\n}\n\nexport function App() {\n  return <div>App</div>;\n}\n");
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_testWorkspace)) Directory.Delete(_testWorkspace, recursive: true);
        }
        catch { }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. File Operations Tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_FileOperations_Write_Read_Create_List_Rename_Copy_Info_Tree()
    {
        // create_file
        var createRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "create_file",
            Path = "notes.txt",
            Content = "Hello Calvras"
        }, _testWorkspace);
        Assert.True(createRes.Ok);
        Assert.True(File.Exists(Path.Combine(_testWorkspace, "notes.txt")));

        // read_file
        var readRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "read_file",
            Path = "notes.txt"
        }, _testWorkspace);
        Assert.True(readRes.Ok);
        Assert.Contains("Hello Calvras", readRes.Output);

        // write_file
        var writeRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "write_file",
            Path = "notes.txt",
            Content = "Updated Line 1\nLine 2"
        }, _testWorkspace);
        Assert.True(writeRes.Ok);
        Assert.NotNull(writeRes.DiffRows);

        // list_files
        var listRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "list_files",
            Recursive = true
        }, _testWorkspace);
        Assert.True(listRes.Ok);
        Assert.Contains("notes.txt", listRes.Output);

        // copy_file
        var copyRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "copy_file",
            Path = "notes.txt",
            Destination = "notes_copy.txt"
        }, _testWorkspace);
        Assert.True(copyRes.Ok);
        Assert.True(File.Exists(Path.Combine(_testWorkspace, "notes_copy.txt")));

        // rename_file
        var renameRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "rename_file",
            Path = "notes_copy.txt",
            TargetPath = "notes_renamed.txt"
        }, _testWorkspace);
        Assert.True(renameRes.Ok);
        Assert.True(File.Exists(Path.Combine(_testWorkspace, "notes_renamed.txt")));

        // move_file
        var moveRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "move_file",
            Path = "notes_renamed.txt",
            Destination = "src/notes_moved.txt"
        }, _testWorkspace);
        Assert.True(moveRes.Ok);
        Assert.True(File.Exists(Path.Combine(_testWorkspace, "src", "notes_moved.txt")));

        // get_file_info
        var infoRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "get_file_info",
            Path = "notes.txt"
        }, _testWorkspace);
        Assert.True(infoRes.Ok);
        Assert.Contains("sizeBytes", infoRes.Output);

        // directory_tree
        var treeRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "directory_tree"
        }, _testWorkspace);
        Assert.True(treeRes.Ok);
        Assert.Contains("src/", treeRes.Output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Search & Code Navigation Tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_SearchAndNavigation_Grep_Find_Symbols_Def_Refs_Hover_Diagnostics()
    {
        // grep_search
        var grepRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "grep_search",
            Query = "MainService"
        }, _testWorkspace);
        Assert.True(grepRes.Ok);
        Assert.Contains("MainService", grepRes.Output);

        // find_files
        var findRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "find_files",
            Pattern = "*.tsx"
        }, _testWorkspace);
        Assert.True(findRes.Ok);
        Assert.Contains("App.tsx", findRes.Output);

        // search_symbols
        var symRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "search_symbols",
            Symbol = "MainService"
        }, _testWorkspace);
        Assert.True(symRes.Ok);
        Assert.Contains("MainService", symRes.Output);

        // go_to_definition
        var defRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "go_to_definition",
            Symbol = "MainService"
        }, _testWorkspace);
        Assert.True(defRes.Ok);

        // find_references
        var refRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "find_references",
            Symbol = "App"
        }, _testWorkspace);
        Assert.True(refRes.Ok);

        // get_hover_info
        var hoverRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "get_hover_info",
            Symbol = "MainService"
        }, _testWorkspace);
        Assert.True(hoverRes.Ok);

        // list_symbols
        var listSymRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "list_symbols",
            Path = "src/App.tsx"
        }, _testWorkspace);
        Assert.True(listSymRes.Ok);
        Assert.Contains("MainService", listSymRes.Output);

        // read_diagnostics
        var diagRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "read_diagnostics"
        }, _testWorkspace);
        Assert.NotNull(diagRes);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Code Editing Tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_CodeEditing_SearchReplace_MultiReplace_Insert_Delete_Undo_Patch_Format()
    {
        var filePath = "src/App.tsx";

        // search_replace
        var repRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "search_replace",
            Path = filePath,
            Search = "<div>App</div>",
            Replace = "<div>App Updated</div>"
        }, _testWorkspace);
        Assert.True(repRes.Ok);

        // multi_replace
        var mRepRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "multi_replace",
            Path = filePath,
            Replacements = new List<ReplacementPair>
            {
                new() { Search = "App Updated", Replace = "Calvras Main" }
            }
        }, _testWorkspace);
        Assert.True(mRepRes.Ok);

        // insert_code
        var insRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "insert_code",
            Path = filePath,
            LineStart = 1,
            Content = "// Banner Header"
        }, _testWorkspace);
        Assert.True(insRes.Ok);

        // delete_lines
        var delRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "delete_lines",
            Path = filePath,
            LineStart = 1,
            LineEnd = 1
        }, _testWorkspace);
        Assert.True(delRes.Ok);

        // undo_edit
        var undoRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "undo_edit",
            Path = filePath
        }, _testWorkspace);
        Assert.True(undoRes.Ok);

        // format_code
        var fmtCodeRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "format_code",
            Content = "function test() {   \n  return 1;\n}"
        }, _testWorkspace);
        Assert.True(fmtCodeRes.Ok);

        // format_file
        var fmtFileRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "format_file",
            Path = filePath
        }, _testWorkspace);
        Assert.True(fmtFileRes.Ok);

        // organize_imports
        var orgRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "organize_imports",
            Path = filePath
        }, _testWorkspace);
        Assert.True(orgRes.Ok);

        // apply_patch
        var patchRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "apply_patch",
            Path = filePath,
            Patch = "+// Added via patch\n export const V = 1;"
        }, _testWorkspace);
        Assert.True(patchRes.Ok);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Terminal & Execution Tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_Terminal_RunCommand_RunCode_DevServer()
    {
        // run_command
        var cmdRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "run_command",
            Command = "echo CalvrasSuccess"
        }, _testWorkspace);
        Assert.True(cmdRes.Ok);
        Assert.Contains("CalvrasSuccess", cmdRes.Output);

        // run_code (node or echo)
        var codeRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "run_code",
            Content = "console.log('CodeRunnerOK');",
            Language = "node"
        }, _testWorkspace);
        Assert.NotNull(codeRes);

        // install_dependencies check
        var instRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "install_dependencies"
        }, _testWorkspace);
        Assert.NotNull(instRes);

        // get_terminal_output
        var outRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "get_terminal_output"
        }, _testWorkspace);
        Assert.True(outRes.Ok);

        // stop_dev_server
        var stopRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "stop_dev_server"
        }, _testWorkspace);
        Assert.True(stopRes.Ok);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Debugging & Testing Tools
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_DebuggingAndTesting_Tools()
    {
        // get_errors
        var errRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "get_errors"
        }, _testWorkspace);
        Assert.NotNull(errRes);

        // get_stack_trace
        var stackRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "get_stack_trace",
            Content = "Error: Invalid argument\n   at System.IO.FileStream"
        }, _testWorkspace);
        Assert.True(stackRes.Ok);

        // debug_code
        var debugRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "debug_code"
        }, _testWorkspace);
        Assert.NotNull(debugRes);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Git & Version Control Tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_Git_Tools()
    {
        // git_status
        var statusRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "git_status" }, _testWorkspace);
        Assert.NotNull(statusRes);

        // git_diff
        var diffRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "git_diff" }, _testWorkspace);
        Assert.NotNull(diffRes);

        // git_branch
        var branchRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "git_branch" }, _testWorkspace);
        Assert.NotNull(branchRes);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Project Understanding Tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_ProjectUnderstanding_Tools()
    {
        // analyze_project
        var anaRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "analyze_project" }, _testWorkspace);
        Assert.True(anaRes.Ok);
        Assert.Contains("WORKSPACE OVERVIEW", anaRes.Output);

        // detect_framework
        var detRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "detect_framework" }, _testWorkspace);
        Assert.True(detRes.Ok);
        Assert.Contains("React", detRes.Output);

        // read_package_json
        var pkgRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "read_package_json" }, _testWorkspace);
        Assert.True(pkgRes.Ok);
        Assert.Contains("test-app", pkgRes.Output);

        // find_entry_point
        var entryRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "find_entry_point" }, _testWorkspace);
        Assert.True(entryRes.Ok);
        Assert.Contains("App.tsx", entryRes.Output);

        // map_dependencies
        var depRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "map_dependencies" }, _testWorkspace);
        Assert.True(depRes.Ok);
        Assert.Contains("react", depRes.Output);

        // analyze_codebase
        var codeRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "analyze_codebase" }, _testWorkspace);
        Assert.True(codeRes.Ok);

        // trace_function_calls
        var traceRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "trace_function_calls", Symbol = "App" }, _testWorkspace);
        Assert.True(traceRes.Ok);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Browser & UI Testing Tools
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_Browser_UI_Testing_Tools()
    {
        // click_element
        var clickRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "click_element", Selector = "#btn-submit" }, _testWorkspace);
        Assert.True(clickRes.Ok);

        // fill_input
        var fillRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "fill_input", Selector = "#username", Value = "calvras_user" }, _testWorkspace);
        Assert.True(fillRes.Ok);

        // inspect_element
        var inspRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "inspect_element", Path = "src/App.tsx", Selector = "MainService" }, _testWorkspace);
        Assert.True(inspRes.Ok);

        // test_responsive_layout
        var respRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "test_responsive_layout" }, _testWorkspace);
        Assert.True(respRes.Ok);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Agent Intelligence Tools
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_AgentIntelligence_Tools()
    {
        // plan_tasks
        var planRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "plan_tasks", Content = "Phase 1: Setup\nPhase 2: Build" }, _testWorkspace);
        Assert.True(planRes.Ok);

        // delegate_task
        var delRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "delegate_task", Subagent = "CodeArchitect", Content = "Design schema" }, _testWorkspace);
        Assert.True(delRes.Ok);

        // request_user_approval
        var appRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "request_user_approval", Message = "Delete old cache?" }, _testWorkspace);
        Assert.True(appRes.Ok);

        // track_progress
        var progRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "track_progress", Percent = 85, Message = "Compiling build" }, _testWorkspace);
        Assert.True(progRes.Ok);

        // ask_subagent
        var askRes = await _toolService.ExecuteToolAsync(new AgentActionModel { Type = "ask_subagent", Query = "Review security configuration" }, _testWorkspace);
        Assert.True(askRes.Ok);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. Advanced Features Tools
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Test_AdvancedFeatures_Tools()
    {
        // multi_file_edit
        var mEditRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "multi_file_edit",
            Files = new List<FileEditPair>
            {
                new() { Path = "src/FileA.ts", Content = "export const A = 1;" },
                new() { Path = "src/FileB.ts", Content = "export const B = 2;" }
            }
        }, _testWorkspace);
        Assert.True(mEditRes.Ok);
        Assert.True(File.Exists(Path.Combine(_testWorkspace, "src", "FileA.ts")));
        Assert.True(File.Exists(Path.Combine(_testWorkspace, "src", "FileB.ts")));

        // refactor_code
        var refRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "refactor_code",
            OldText = "export const A = 1;",
            NewText = "export const A_Refactored = 100;"
        }, _testWorkspace);
        Assert.True(refRes.Ok);
        var fileAContent = await File.ReadAllTextAsync(Path.Combine(_testWorkspace, "src", "FileA.ts"));
        Assert.Contains("A_Refactored", fileAContent);

        // generate_tests
        var genTestRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "generate_tests",
            Path = "src/App.tsx"
        }, _testWorkspace);
        Assert.True(genTestRes.Ok);

        // detect_security_issues
        var secRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "detect_security_issues"
        }, _testWorkspace);
        Assert.True(secRes.Ok);

        // explain_code
        var expRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "explain_code",
            Path = "src/App.tsx"
        }, _testWorkspace);
        Assert.True(expRes.Ok);

        // generate_documentation
        var docRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "generate_documentation",
            Path = "src/App.tsx"
        }, _testWorkspace);
        Assert.True(docRes.Ok);

        // manage_environment_variables
        var envRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "manage_environment_variables",
            Key = "PORT",
            Value = "3000"
        }, _testWorkspace);
        Assert.True(envRes.Ok);
        var envContent = await File.ReadAllTextAsync(Path.Combine(_testWorkspace, ".env"));
        Assert.Contains("PORT=3000", envContent);

        // inspect_dependencies
        var depRes = await _toolService.ExecuteToolAsync(new AgentActionModel
        {
            Type = "inspect_dependencies"
        }, _testWorkspace);
        Assert.True(depRes.Ok);
    }
}
