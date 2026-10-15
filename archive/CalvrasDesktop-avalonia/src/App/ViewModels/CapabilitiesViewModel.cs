using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Calvras.App.ViewModels;

public record CapabilityCard(string Title, string Description, string Badge, string IconText);

public partial class CapabilitiesViewModel : ViewModelBase
{
    [ObservableProperty]
    private ObservableCollection<CapabilityCard> _capabilities = new();

    public CapabilitiesViewModel()
    {
        Capabilities = new ObservableCollection<CapabilityCard>
        {
            new("Terminal Command Execution", "Runs build tools, package managers, and automated test suites with live stdout/stderr capture and exit code checks.", "Execution", ">_"),
            new("Code Patching & Diff Inspection", "Inspects codebase context, generates surgical diffs with line-level context, and validates syntax before writing.", "Code", "</>"),
            new("AST & Schema Parsing", "Parses code symbols, types, imports, and exports to understand complete dependency trees across multi-file projects.", "Analysis", "{}"),
            new("Local Filesystem Bridge", "Direct access to read, create, list, and modify files in your chosen local workspace folders with path isolation.", "Files", "📁"),
            new("Web & Standards Search", "Queries external docs, API specifications, and CVE security advisories to select proven implementation patterns.", "Search", "🔍"),
            new("Self-Healing Iteration Loop", "Analyzes runtime stack traces and compiler errors, iterating continuously until regression suites pass cleanly.", "Autonomous", "⚡")
        };
    }
}
