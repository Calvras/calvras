using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace Calvras.App.Controls;

public partial class TerminalViewerControl : UserControl
{
    public TerminalViewerControl()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
    }

    private void OnDataContextChanged(object? sender, System.EventArgs e)
    {
        ApplyExitCodeStyle();
    }

    private void ApplyExitCodeStyle()
    {
        if (DataContext is Calvras.Core.Models.TraceNodeModel node && ExitBadge != null && ExitText != null)
        {
            if (node.ExitCode == 0)
            {
                ExitBadge.Background = new SolidColorBrush(Color.Parse("#0D2818"));
                ExitBadge.BorderBrush = new SolidColorBrush(Color.Parse("#1A4A2E"));
                ExitBadge.BorderThickness = new Thickness(1);
                ExitText.Foreground = new SolidColorBrush(Color.Parse("#4ADE80"));
            }
            else if (node.ExitCode.HasValue)
            {
                ExitBadge.Background = new SolidColorBrush(Color.Parse("#2A0D0D"));
                ExitBadge.BorderBrush = new SolidColorBrush(Color.Parse("#4A1A1A"));
                ExitBadge.BorderThickness = new Thickness(1);
                ExitText.Foreground = new SolidColorBrush(Color.Parse("#F87171"));
            }
            else
            {
                ExitBadge.Background = new SolidColorBrush(Color.Parse("#1A1A1E"));
                ExitBadge.BorderThickness = new Thickness(0);
                ExitText.Foreground = new SolidColorBrush(Color.Parse("#555560"));
            }
        }
    }
}
