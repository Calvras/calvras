using System;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Calvras.App.ViewModels;

public partial class LandingViewModel : ViewModelBase
{
    private readonly Action _onGetStarted;

    [ObservableProperty]
    private string _headline = "Your Autonomous Coding Agent.";

    [ObservableProperty]
    private string _subheadline = "Calvras writes code, runs terminal commands, inspects ASTs, and verifies output natively on your machine.";

    public LandingViewModel(Action onGetStarted)
    {
        _onGetStarted = onGetStarted;
    }

    [RelayCommand]
    private void GetStarted() => _onGetStarted();
}
