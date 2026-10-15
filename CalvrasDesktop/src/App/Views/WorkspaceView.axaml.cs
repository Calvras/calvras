using System;
using System.Collections.Specialized;
using System.Diagnostics;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Calvras.App.ViewModels;

namespace Calvras.App.Views;

public partial class WorkspaceView : UserControl
{
    private ScrollViewer? _scroll;
    private Button? _scrollBottomBtn;
    private bool _userScrolledUp = false;

    public WorkspaceView()
    {
        InitializeComponent();

        TemplateApplied += (_, _) => SetupScroll();
        DataContextChanged += OnDataContextChanged;
    }

    private void SetupScroll()
    {
        _scroll = this.FindControl<ScrollViewer>("TimelineScroll");
        _scrollBottomBtn = this.FindControl<Button>("ScrollBottomBtn");

        if (_scroll != null)
        {
            _scroll.ScrollChanged += OnScrollChanged;
        }
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (DataContext is WorkspaceViewModel vm)
        {
            vm.Messages.CollectionChanged += OnMessagesChanged;
            vm.ScrollToBottom += () =>
            {
                if (!_userScrolledUp)
                {
                    Dispatcher.UIThread.Post(() => _scroll?.ScrollToEnd(), DispatcherPriority.Loaded);
                }
            };
        }
    }

    private void OnScrollChanged(object? sender, ScrollChangedEventArgs e)
    {
        if (_scroll == null) return;

        var distanceFromBottom = _scroll.Extent.Height - _scroll.Offset.Y - _scroll.Viewport.Height;
        _userScrolledUp = distanceFromBottom > 90;

        if (_scrollBottomBtn != null)
        {
            _scrollBottomBtn.IsVisible = _userScrolledUp;
        }
    }

    private void OnMessagesChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (_userScrolledUp) return;

        Dispatcher.UIThread.Post(() =>
        {
            _scroll ??= this.FindControl<ScrollViewer>("TimelineScroll");
            _scroll?.ScrollToEnd();
        }, DispatcherPriority.Loaded);
    }

    public void OnBackgroundPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (DataContext is WorkspaceViewModel vm)
        {
            // If prompt is empty or whitespace and no files attached, collapse to small size on click outside
            if (string.IsNullOrWhiteSpace(vm.PromptText) && vm.AttachedFiles.Count == 0)
            {
                vm.CollapseInput();
            }
        }
    }

    public void OnScrollToBottomClick(object? sender, RoutedEventArgs e)
    {
        _userScrolledUp = false;
        if (_scrollBottomBtn != null) _scrollBottomBtn.IsVisible = false;
        _scroll?.ScrollToEnd();
    }

    public void OnOpenWebPreviewClick(object? sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.CommandParameter is string url && !string.IsNullOrWhiteSpace(url))
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
            catch { }
        }
    }
}
