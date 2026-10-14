using System.Collections.Specialized;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Calvras.App.ViewModels;

namespace Calvras.App.Views;

public partial class WorkspaceView : UserControl
{
    private ScrollViewer? _scroll;
    private bool _userScrolledUp = false;

    public WorkspaceView()
    {
        InitializeComponent();

        // Wire up after template is applied
        TemplateApplied += (_, _) => SetupScroll();
        DataContextChanged += OnDataContextChanged;
    }

    private void SetupScroll()
    {
        _scroll = this.FindControl<ScrollViewer>("TimelineScroll");
        if (_scroll != null)
        {
            _scroll.ScrollChanged += OnScrollChanged;
        }
    }

    private void OnDataContextChanged(object? sender, System.EventArgs e)
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

        // If the user scrolled up (offset decreased or scroll not at bottom), mark it
        var distanceFromBottom = _scroll.Extent.Height - _scroll.Offset.Y - _scroll.Viewport.Height;
        _userScrolledUp = distanceFromBottom > 80;
    }

    private void OnMessagesChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (_userScrolledUp) return;

        // Defer until layout is complete
        Dispatcher.UIThread.Post(() =>
        {
            _scroll ??= this.FindControl<ScrollViewer>("TimelineScroll");
            _scroll?.ScrollToEnd();
        }, DispatcherPriority.Loaded);
    }
}
