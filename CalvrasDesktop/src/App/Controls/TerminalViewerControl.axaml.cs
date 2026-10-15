using System;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Media;
using Calvras.Core.Models;

namespace Calvras.App.Controls;

public partial class TerminalViewerControl : UserControl
{
    private static readonly FontFamily MonoFont = new FontFamily("Consolas, Monaco, Monospace");

    private static readonly IBrush EmeraldBrush = new SolidColorBrush(Color.Parse("#10B981"));
    private static readonly IBrush RoseBrush = new SolidColorBrush(Color.Parse("#F43F5E"));
    private static readonly IBrush AmberBrush = new SolidColorBrush(Color.Parse("#F59E0B"));
    private static readonly IBrush MutedBrush = new SolidColorBrush(Color.Parse("#8E8E93"));

    public TerminalViewerControl()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        ApplyExitCodeStyle();
        PopulateLines();
    }

    private void ApplyExitCodeStyle()
    {
        if (DataContext is TraceNodeModel node && ExitBadge != null && ExitText != null)
        {
            if (node.Status == "running")
            {
                ExitBadge.Background = new SolidColorBrush(Color.Parse("#26174A"));
                ExitBadge.BorderBrush = new SolidColorBrush(Color.Parse("#8B5CF6"));
                ExitBadge.BorderThickness = new Thickness(1);
                ExitText.Foreground = new SolidColorBrush(Color.Parse("#C4B5FD"));
                ExitText.Text = "running";
            }
            else if (node.ExitCode == 0)
            {
                ExitBadge.Background = new SolidColorBrush(Color.Parse("#06281E"));
                ExitBadge.BorderBrush = new SolidColorBrush(Color.Parse("#10B981"));
                ExitBadge.BorderThickness = new Thickness(1);
                ExitText.Foreground = EmeraldBrush;
                ExitText.Text = "exit 0";
            }
            else if (node.ExitCode.HasValue)
            {
                ExitBadge.Background = new SolidColorBrush(Color.Parse("#2B0F15"));
                ExitBadge.BorderBrush = new SolidColorBrush(Color.Parse("#F43F5E"));
                ExitBadge.BorderThickness = new Thickness(1);
                ExitText.Foreground = RoseBrush;
                ExitText.Text = $"exit {node.ExitCode.Value}";
            }
            else
            {
                ExitBadge.Background = new SolidColorBrush(Color.Parse("#1A1A1E"));
                ExitBadge.BorderThickness = new Thickness(0);
                ExitText.Foreground = MutedBrush;
                ExitText.Text = "completed";
            }
        }
    }

    private void PopulateLines()
    {
        if (OutputLinesPanel == null) return;
        OutputLinesPanel.Children.Clear();

        if (DataContext is not TraceNodeModel node || string.IsNullOrEmpty(node.Output)) return;

        var lines = node.Output.Split('\n');
        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd('\r');
            bool isPass = line.Contains("✓") || line.Contains("PASS") || line.Contains("passed");
            bool isFail = line.Contains("FAIL") || line.Contains("Error") || line.Contains("failed");
            bool isWarn = line.Contains("WARN") || line.Contains("warning");

            var brush = isPass ? EmeraldBrush : isFail ? RoseBrush : isWarn ? AmberBrush : MutedBrush;

            var tb = new SelectableTextBlock
            {
                Text = line,
                FontFamily = MonoFont,
                FontSize = 11,
                Foreground = brush,
                LineHeight = 17,
                FontWeight = (isPass || isFail) ? FontWeight.SemiBold : FontWeight.Normal,
                TextWrapping = TextWrapping.NoWrap
            };
            OutputLinesPanel.Children.Add(tb);
        }
    }

    private async void OnCopyClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not TraceNodeModel node) return;

        var text = string.IsNullOrEmpty(node.Output)
            ? $"$ {node.Command}"
            : $"$ {node.Command}\n\n{node.Output}";

        var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
        if (clipboard != null)
        {
            await clipboard.SetTextAsync(text);
        }

        if (CopyIcon != null && CopiedIcon != null)
        {
            CopyIcon.IsVisible = false;
            CopiedIcon.IsVisible = true;
            await Task.Delay(1800);
            CopiedIcon.IsVisible = false;
            CopyIcon.IsVisible = true;
        }
    }
}
