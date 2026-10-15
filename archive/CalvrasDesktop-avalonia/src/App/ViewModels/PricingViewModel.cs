using System;
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Calvras.App.ViewModels;

public record PricingTier(string Name, string PriceMonthly, string PriceYearly, string Description, string[] Features, bool IsPopular);

public partial class PricingViewModel : ViewModelBase
{
    private readonly Action<string> _onSelectPlan;

    [ObservableProperty]
    private bool _isAnnual = true;

    [ObservableProperty]
    private ObservableCollection<PricingTier> _tiers = new();

    public PricingViewModel(Action<string> onSelectPlan)
    {
        _onSelectPlan = onSelectPlan;
        Tiers = new ObservableCollection<PricingTier>
        {
            new("Hobby", "$0", "$0", "For personal experiments and local prototyping.",
                new[] { "Local filesystem execution", "Standard tool access", "Community support" }, false),
            new("Pro", "$29", "$24", "For developers building and shipping production apps.",
                new[] { "Unlimited autonomous steps", "Full multi-turn tool loops", "Priority model inference", "Implementation plan exports" }, true),
            new("Team", "$99", "$79", "For teams collaborating on complex codebases.",
                new[] { "Shared workspace policies", "Centralized credential storage", "Canary test staging", "Dedicated support" }, false)
        };
    }

    [RelayCommand]
    private void SelectPlan(string planName) => _onSelectPlan(planName);
}
