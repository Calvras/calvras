using System;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Styling;
using Calvras.App.ViewModels;
using Calvras.App.Views;

namespace Calvras.App;

public partial class App : Application
{
    private MainViewModel? _mainVm;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            _mainVm = new MainViewModel();
            _mainVm.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(MainViewModel.IsDarkMode))
                {
                    RequestedThemeVariant = _mainVm.IsDarkMode ? ThemeVariant.Dark : ThemeVariant.Light;
                }
            };

            desktop.MainWindow = new MainWindow
            {
                DataContext = _mainVm,
            };
        }

        base.OnFrameworkInitializationCompleted();
    }

    private void OnTrayShowClick(object? sender, EventArgs e)
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop && desktop.MainWindow != null)
        {
            desktop.MainWindow.Show();
            desktop.MainWindow.WindowState = Avalonia.Controls.WindowState.Normal;
            desktop.MainWindow.Activate();
        }
    }

    private void OnTrayExitClick(object? sender, EventArgs e)
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.Shutdown();
        }
    }
}