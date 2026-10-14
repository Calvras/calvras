using System.Collections;
using Avalonia;
using Avalonia.Controls;

namespace Calvras.App.Controls;

public partial class AgentActivityControl : UserControl
{
    public static readonly StyledProperty<IEnumerable?> PhasesProperty =
        AvaloniaProperty.Register<AgentActivityControl, IEnumerable?>(nameof(Phases));

    public IEnumerable? Phases
    {
        get => GetValue(PhasesProperty);
        set => SetValue(PhasesProperty, value);
    }

    public AgentActivityControl()
    {
        InitializeComponent();
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == PhasesProperty)
        {
            PhasesList.ItemsSource = change.GetNewValue<IEnumerable?>();
        }
    }
}
