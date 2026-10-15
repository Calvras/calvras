using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using Calvras.App.ViewModels;

namespace Calvras.App.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        AddHandler(DragDrop.DropEvent, OnWindowDrop);
        AddHandler(DragDrop.DragOverEvent, OnWindowDragOver);

        Opened += OnWindowOpened;
        Closing += OnWindowClosing;
    }

    private async void OnWindowOpened(object? sender, EventArgs e)
    {
        try
        {
            if (DataContext is MainViewModel vm)
            {
                var wStr = await vm.Database.GetSettingAsync("Window_Width");
                var hStr = await vm.Database.GetSettingAsync("Window_Height");
                var xStr = await vm.Database.GetSettingAsync("Window_X");
                var yStr = await vm.Database.GetSettingAsync("Window_Y");

                if (double.TryParse(wStr, out var w) && w >= MinWidth) Width = w;
                if (double.TryParse(hStr, out var h) && h >= MinHeight) Height = h;
                if (int.TryParse(xStr, out var x) && int.TryParse(yStr, out var y))
                {
                    if (x >= 0 && y >= 0)
                    {
                        Position = new Avalonia.PixelPoint(x, y);
                    }
                }
            }
        }
        catch { }
    }

    private async void OnWindowClosing(object? sender, WindowClosingEventArgs e)
    {
        try
        {
            if (DataContext is MainViewModel vm && WindowState == WindowState.Normal)
            {
                await vm.Database.SetSettingAsync("Window_Width", Width.ToString());
                await vm.Database.SetSettingAsync("Window_Height", Height.ToString());
                await vm.Database.SetSettingAsync("Window_X", Position.X.ToString());
                await vm.Database.SetSettingAsync("Window_Y", Position.Y.ToString());
            }
        }
        catch { }
    }

    private void OnWindowDragOver(object? sender, DragEventArgs e)
    {
        if (e.Data.Contains(DataFormats.Files))
        {
            e.DragEffects = DragDropEffects.Copy;
        }
        else
        {
            e.DragEffects = DragDropEffects.None;
        }
    }

    private async void OnWindowDrop(object? sender, DragEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;

        var files = e.Data.GetFiles()?.ToList();
        if (files == null || files.Count == 0) return;

        var first = files[0].Path.LocalPath;
        if (Directory.Exists(first))
        {
            await vm.OpenFolderAsync(first);
        }
        else if (File.Exists(first))
        {
            vm.WorkspaceVm.AddAttachment(first);
            vm.ShowToast($"Attached file: {Path.GetFileName(first)}");
        }
    }

    private async void OnOpenFolderClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;

        var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Select Project Workspace Folder",
            AllowMultiple = false
        });

        if (folders.Count > 0)
        {
            var path = folders[0].Path.LocalPath;
            await vm.OpenFolderAsync(path);
        }
    }

    private void OnMinimizeClick(object? sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void OnExitClick(object? sender, RoutedEventArgs e)
    {
        Close();
    }

    private void OnOpenWebsiteClick(object? sender, RoutedEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "https://calvras.com",
                UseShellExecute = true
            });
        }
        catch { }
    }

    private async void OnProjectItemClick(object? sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: Calvras.Core.Models.ProjectModel p } && DataContext is MainViewModel vm)
        {
            await vm.SelectProjectAsync(p);
        }
    }
}