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
            vm.IsInputExpanded = true;
            PromptTextBox.Focus();
        }
    }

    private void OnTextBoxGotFocus(object? sender, GotFocusEventArgs e)
    {
        if (DataContext is WorkspaceViewModel vm)
        {
            vm.IsInputExpanded = true;
        }
    }

    private void OnTextBoxLostFocus(object? sender, RoutedEventArgs e)
    {
        if (DataContext is WorkspaceViewModel vm)
        {
            // Only collapse if there is no text, no attachments, and agent is not busy/recording
            if (string.IsNullOrWhiteSpace(vm.PromptText) && vm.AttachedFiles.Count == 0 && !vm.IsBusy && !vm.IsRecording)
            {
                vm.IsInputExpanded = false;
            }
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
            vm.IsInputExpanded = true;
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
