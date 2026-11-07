using Avalonia.Controls;
using Avalonia.Interactivity;
using Calvras.App.ViewModels;

namespace Calvras.App.Views;

public partial class PricingView : UserControl
{
    public PricingView()
    {
        InitializeComponent();
    }

    private void OnSelectPlanClick(object? sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string planName } && DataContext is PricingViewModel vm)
        {
            vm.SelectPlanCommand.Execute(planName);
        }
    }
}
