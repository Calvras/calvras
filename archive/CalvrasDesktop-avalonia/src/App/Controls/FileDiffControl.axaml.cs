using System;
using System.Text;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Media;
using Calvras.Core.Models;

namespace Calvras.App.Controls;

public partial class FileDiffControl : UserControl
{
    private static readonly FontFamily MonoFont = new FontFamily("Consolas, Monaco, Monospace");

    private static readonly IBrush EmeraldBrush = new SolidColorBrush(Color.Parse("#10B981"));
    private static readonly IBrush RoseBrush = new SolidColorBrush(Color.Parse("#F43F5E"));
    private static readonly IBrush MutedLineBrush = new SolidColorBrush(Color.Parse("#71717A"));
    private static readonly IBrush CodeTextBrush = new SolidColorBrush(Color.Parse("#E4E4E7"));
    private static readonly IBrush ContextCodeBrush = new SolidColorBrush(Color.Parse("#A1A1AA"));

    private static readonly IBrush AddBackground = new SolidColorBrush(Color.Parse("#10B98118"));
    private static readonly IBrush DelBackground = new SolidColorBrush(Color.Parse("#F43F5E18"));

    public FileDiffControl()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        PopulateDiffRows();
    }

    private void PopulateDiffRows()
    {
        if (DiffRowsPanel == null) return;
        DiffRowsPanel.Children.Clear();

        if (DataContext is not TraceNodeModel node || node.DiffRows == null) return;

        foreach (var row in node.DiffRows)
        {
            var isAdd = row.Type == "add";
            var isDel = row.Type == "del";

            var rowGrid = new Grid
            {
                ColumnDefinitions = new ColumnDefinitions("34,34,20,*"),
                Height = 21
            };

            // Old line number
            var oldText = new TextBlock
            {
                Text = row.Old?.ToString() ?? "",
                FontFamily = MonoFont,
                FontSize = 10.5,
                Foreground = isDel ? RoseBrush : MutedLineBrush,
                FontWeight = isDel ? FontWeight.SemiBold : FontWeight.Normal,
                TextAlignment = TextAlignment.Right,
                VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 6, 0)
            };
            Grid.SetColumn(oldText, 0);
            rowGrid.Children.Add(oldText);

            // Cur line number
            var curText = new TextBlock
            {
                Text = row.Cur?.ToString() ?? "",
                FontFamily = MonoFont,
                FontSize = 10.5,
                Foreground = isAdd ? EmeraldBrush : MutedLineBrush,
                FontWeight = isAdd ? FontWeight.SemiBold : FontWeight.Normal,
                TextAlignment = TextAlignment.Right,
                VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 6, 0)
            };
            Grid.SetColumn(curText, 1);
            rowGrid.Children.Add(curText);

            // Marker (+ / −)
            var marker = new TextBlock
            {
                Text = isAdd ? "+" : isDel ? "−" : "",
                FontFamily = MonoFont,
                FontSize = 11,
                FontWeight = FontWeight.Bold,
                Foreground = isAdd ? EmeraldBrush : isDel ? RoseBrush : MutedLineBrush,
                TextAlignment = TextAlignment.Center,
                VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center
            };
            Grid.SetColumn(marker, 2);
            rowGrid.Children.Add(marker);

            // Code text
            var codeText = new SelectableTextBlock
            {
                Text = row.Text,
                FontFamily = MonoFont,
                FontSize = 11.5,
                Foreground = isAdd ? CodeTextBrush : isDel ? RoseBrush : ContextCodeBrush,
                FontWeight = isAdd ? FontWeight.Medium : FontWeight.Normal,
                VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 8, 0)
            };
            Grid.SetColumn(codeText, 3);
            rowGrid.Children.Add(codeText);

            // Row container with background and left border indicator
            var rowBorder = new Border
            {
                Background = isAdd ? AddBackground : isDel ? DelBackground : Brushes.Transparent,
                BorderBrush = isAdd ? EmeraldBrush : isDel ? RoseBrush : Brushes.Transparent,
                BorderThickness = new Thickness(isAdd || isDel ? 3 : 0, 0, 0, 0),
                Child = rowGrid
            };

            DiffRowsPanel.Children.Add(rowBorder);
        }
    }

    private async void OnCopyDiffClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not TraceNodeModel node || node.DiffRows == null) return;

        var sb = new StringBuilder();
        foreach (var row in node.DiffRows)
        {
            var prefix = row.Type == "add" ? "+ " : row.Type == "del" ? "- " : "  ";
            sb.AppendLine(prefix + row.Text);
        }

        var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
        if (clipboard != null)
        {
            await clipboard.SetTextAsync(sb.ToString());
        }

        if (CopyDiffIcon != null && CopiedDiffIcon != null)
        {
            CopyDiffIcon.IsVisible = false;
            CopiedDiffIcon.IsVisible = true;
            await Task.Delay(1800);
            CopiedDiffIcon.IsVisible = false;
            CopyDiffIcon.IsVisible = true;
        }
    }
}
