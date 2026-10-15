using System;
using System.Collections;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace Calvras.App.Controls;

public partial class AgentActivityControl : UserControl
{
    public static readonly StyledProperty<IEnumerable?> PhasesProperty =
        AvaloniaProperty.Register<AgentActivityControl, IEnumerable?>(nameof(Phases));

    public static readonly StyledProperty<bool> IsWorkingProperty =
        AvaloniaProperty.Register<AgentActivityControl, bool>(nameof(IsWorking), defaultValue: false);

    public static readonly StyledProperty<double> ElapsedSecondsProperty =
        AvaloniaProperty.Register<AgentActivityControl, double>(nameof(ElapsedSeconds), defaultValue: 0.0);

    public IEnumerable? Phases
    {
        get => GetValue(PhasesProperty);
        set => SetValue(PhasesProperty, value);
    }

    public bool IsWorking
    {
        get => GetValue(IsWorkingProperty);
        set => SetValue(IsWorkingProperty, value);
    }

    public double ElapsedSeconds
    {
        get => GetValue(ElapsedSecondsProperty);
        set => SetValue(ElapsedSecondsProperty, value);
    }

    private bool _collapsed = true;
    private bool _userToggled = false;

    public AgentActivityControl()
    {
        InitializeComponent();
    }

    public void ResetToggle()
    {
        _userToggled = false;
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);

        if (change.Property == PhasesProperty)
        {
            PhasesList.ItemsSource = change.GetNewValue<IEnumerable?>();
            UpdateVisibility();
        }
        else if (change.Property == IsWorkingProperty)
        {
            var working = change.GetNewValue<bool>();
            if (!_userToggled)
            {
                // Auto-expand while working, auto-collapse when finished
                SetCollapsed(!working);
            }
            UpdateVisibility();
        }
        else if (change.Property == ElapsedSecondsProperty)
        {
            var sec = change.GetNewValue<double>();
            if (ElapsedText != null)
            {
                ElapsedText.Text = sec < 1.0 ? $"{sec:F1}s" : $"{(int)Math.Round(sec)}s";
            }
        }
    }

    private void UpdateVisibility()
    {
        // Visible if actively working OR if we have phases to inspect
        bool hasPhases = PhasesList.ItemsSource is ICollection col && col.Count > 0;
        this.IsVisible = IsWorking || hasPhases;
    }

    private void OnMasterHeaderPressed(object? sender, PointerPressedEventArgs e)
    {
        _userToggled = true;
        SetCollapsed(!_collapsed);
    }

    private void SetCollapsed(bool collapsed)
    {
        _collapsed = collapsed;
        if (TraceBody != null) TraceBody.IsVisible = !collapsed;
        if (MasterChevron != null) MasterChevron.Text = collapsed ? "▸" : "▾";
    }

    private void OnPillPressed(object? sender, PointerPressedEventArgs e)
    {
        if (sender is Border pillBorder && pillBorder.Parent is StackPanel parent)
        {
            foreach (var child in parent.Children)
            {
                if (child is Border detail && detail.Name == "DetailPanel")
                {
                    detail.IsVisible = !detail.IsVisible;
                    break;
                }
            }
        }
    }
}
