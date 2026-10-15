using System;
using System.IO;
using System.Linq;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using Calvras.App.ViewModels;

namespace Calvras.App.Controls;

public partial class PromptInput : UserControl
{
    public PromptInput()
    {
        InitializeComponent();
    }

    private void OnComposerPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (DataContext is WorkspaceViewModel vm)
        {
            vm.ExpandInput();
            var tb = this.FindControl<TextBox>("PromptTextBox");
            tb?.Focus();
        }
    }

    private void OnTextBoxGotFocus(object? sender, GotFocusEventArgs e)
    {
        if (DataContext is WorkspaceViewModel vm)
        {
            vm.ExpandInput();
        }
    }

    private void OnTextBoxLostFocus(object? sender, RoutedEventArgs e)
    {
        if (DataContext is WorkspaceViewModel vm)
        {
            vm.CollapseInput();
        }
    }

    private void OnTextBoxKeyDown(object? sender, KeyEventArgs e)
    {
        if (DataContext is not WorkspaceViewModel vm) return;

        if (e.Key == Key.Enter)
        {
            if (e.KeyModifiers.HasFlag(KeyModifiers.Shift))
            {
                // Shift+Enter: insert a newline manually
                var tb = sender as TextBox;
                if (tb != null)
                {
                    var pos = tb.CaretIndex;
                    var text = tb.Text ?? string.Empty;
                    tb.Text = text.Insert(pos, "\n");
                    tb.CaretIndex = pos + 1;
                }
                e.Handled = true;
            }
            else
            {
                // Enter alone: send the message
                e.Handled = true;
                if (vm.HasTextToSend && !vm.IsBusy)
                {
                    _ = vm.SendAsync();
                }
            }
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            vm.CollapseInput();
        }
    }

    private async void OnAddAttachmentClick(object? sender, RoutedEventArgs e)
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null) return;

        var files = await topLevel.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Attach Files to Calvras Prompt",
            AllowMultiple = true,
            FileTypeFilter = new[]
            {
                new FilePickerFileType("All Supported Files")
                {
                    Patterns = new[] { "*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif", "*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.cs", "*.json", "*.md", "*.txt", "*.pdf" }
                },
                FilePickerFileTypes.ImageAll,
                FilePickerFileTypes.TextPlain,
                FilePickerFileTypes.All
            }
        });

        if (files != null && files.Count > 0 && DataContext is WorkspaceViewModel vm)
        {
            foreach (var file in files.Take(6))
            {
                var localPath = file.Path.LocalPath;
                if (!string.IsNullOrEmpty(localPath) && File.Exists(localPath))
                {
                    vm.AddAttachment(localPath);
                }
            }
        }
    }
}
