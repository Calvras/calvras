using System;
using System.IO;
using System.Linq;
using Avalonia.Controls;
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
