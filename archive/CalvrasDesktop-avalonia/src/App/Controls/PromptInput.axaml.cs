using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
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
            // If empty when clicking away, return to small size
            if (string.IsNullOrWhiteSpace(vm.PromptText) && vm.AttachedFiles.Count == 0)
            {
                vm.CollapseInput();
            }
        }
    }

    private async void OnTextBoxKeyDown(object? sender, KeyEventArgs e)
    {
        if (DataContext is not WorkspaceViewModel vm) return;

        // Clipboard Paste: Ctrl+V for images or PDFs
        if (e.Key == Key.V && e.KeyModifiers.HasFlag(KeyModifiers.Control))
        {
            var handled = await TryHandleClipboardPasteAsync(vm);
            if (handled)
            {
                e.Handled = true;
                return;
            }
        }

        if (e.Key == Key.Enter)
        {
            if (e.KeyModifiers.HasFlag(KeyModifiers.Shift))
            {
                // Shift+Enter: insert newline manually
                if (sender is TextBox tb)
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
                // Enter alone: send prompt
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

    private async Task<bool> TryHandleClipboardPasteAsync(WorkspaceViewModel vm)
    {
        try
        {
            bool handled = false;
            var thread = new System.Threading.Thread(() =>
            {
                try
                {
                    if (System.Windows.Forms.Clipboard.ContainsImage())
                    {
                        var img = System.Windows.Forms.Clipboard.GetImage();
                        if (img != null)
                        {
                            var tempDir = Path.Combine(Path.GetTempPath(), "CalvrasAttachments");
                            Directory.CreateDirectory(tempDir);
                            var filePath = Path.Combine(tempDir, $"pasted_image_{DateTime.Now:yyyyMMdd_HHmmss}_{Guid.NewGuid():N}.png");
                            img.Save(filePath, System.Drawing.Imaging.ImageFormat.Png);
                            img.Dispose();

                            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                            {
                                vm.AddAttachment(filePath);
                                vm.ExpandInput();
                            });
                            handled = true;
                            return;
                        }
                    }

                    if (System.Windows.Forms.Clipboard.ContainsFileDropList())
                    {
                        var files = System.Windows.Forms.Clipboard.GetFileDropList();
                        if (files != null && files.Count > 0)
                        {
                            var fileList = new System.Collections.Generic.List<string>();
                            for (int fi = 0; fi < files.Count; fi++)
                            {
                                var f = files[fi];
                                if (!string.IsNullOrEmpty(f) && File.Exists(f))
                                    fileList.Add(f);
                            }

                            if (fileList.Count > 0)
                            {
                                var capture = fileList;
                                Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                                {
                                    foreach (var f in capture) vm.AddAttachment(f);
                                    vm.ExpandInput();
                                });
                                handled = true;
                                return;
                            }
                        }
                    }

                    if (System.Windows.Forms.Clipboard.ContainsText())
                    {
                        var text = System.Windows.Forms.Clipboard.GetText()?.Trim().Trim('"', '\'');
                        if (!string.IsNullOrWhiteSpace(text) && File.Exists(text))
                        {
                            var ext = Path.GetExtension(text).ToLowerInvariant();
                            if (ext is ".pdf" or ".png" or ".jpg" or ".jpeg" or ".webp" or ".gif" or ".ts" or ".tsx" or ".js" or ".jsx" or ".py" or ".cs" or ".json" or ".md" or ".txt")
                            {
                                Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                                {
                                    vm.AddAttachment(text);
                                    vm.ExpandInput();
                                });
                                handled = true;
                                return;
                            }
                        }
                    }
                }
                catch { }
            });
            thread.SetApartmentState(System.Threading.ApartmentState.STA);
            thread.Start();
            thread.Join(1500);

            if (handled) return true;
        }
        catch { }

        // Also check Avalonia clipboard text as fallback
        try
        {
            var topLevel = TopLevel.GetTopLevel(this);
            var clipboard = topLevel?.Clipboard;
            if (clipboard != null)
            {
                var text = await clipboard.GetTextAsync();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    var clean = text.Trim().Trim('"', '\'');
                    if (File.Exists(clean))
                    {
                        var ext = Path.GetExtension(clean).ToLowerInvariant();
                        if (ext is ".pdf" or ".png" or ".jpg" or ".jpeg" or ".webp" or ".gif" or ".ts" or ".tsx" or ".js" or ".jsx" or ".py" or ".cs" or ".json" or ".md" or ".txt")
                        {
                            vm.AddAttachment(clean);
                            vm.ExpandInput();
                            return true;
                        }
                    }
                }
            }
        }
        catch { }

        return false;
    }

    private async void OnAddAttachmentClick(object? sender, RoutedEventArgs e)
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null) return;

        var files = await topLevel.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Attach Files or Images to Calvras",
            AllowMultiple = true,
            FileTypeFilter = new[]
            {
                new FilePickerFileType("All Supported Files")
                {
                    Patterns = new[] { "*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif", "*.pdf", "*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.cs", "*.json", "*.md", "*.txt" }
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
