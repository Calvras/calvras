using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Threading;

namespace Calvras.App.Controls;

public partial class PixelDotsLoaderControl : UserControl
{
    private DispatcherTimer? _timer;
    private readonly Ellipse?[] _dots = new Ellipse?[9];
    private static readonly int[] ChevronDelays = new int[9];
    private DateTime _startTime;

    static PixelDotsLoaderControl()
    {
        for (int i = 0; i < 9; i++)
        {
            int r = i / 3;
            int c = i % 3;
            ChevronDelays[i] = (c + Math.Abs(r - 1)) * 70;
        }
    }

    public PixelDotsLoaderControl()
    {
        InitializeComponent();

        _dots[0] = this.FindControl<Ellipse>("Dot0");
        _dots[1] = this.FindControl<Ellipse>("Dot1");
        _dots[2] = this.FindControl<Ellipse>("Dot2");
        _dots[3] = this.FindControl<Ellipse>("Dot3");
        _dots[4] = this.FindControl<Ellipse>("Dot4");
        _dots[5] = this.FindControl<Ellipse>("Dot5");
        _dots[6] = this.FindControl<Ellipse>("Dot6");
        _dots[7] = this.FindControl<Ellipse>("Dot7");
        _dots[8] = this.FindControl<Ellipse>("Dot8");

        AttachedToVisualTree += (_, _) => StartAnimation();
        DetachedFromVisualTree += (_, _) => StopAnimation();
    }

    private void StartAnimation()
    {
        _startTime = DateTime.UtcNow;
        _timer ??= new DispatcherTimer(TimeSpan.FromMilliseconds(33), DispatcherPriority.Render, (s, e) =>
        {
            double elapsedMs = (DateTime.UtcNow - _startTime).TotalMilliseconds;
            const double cycleMs = 1600.0;

            for (int i = 0; i < 9; i++)
            {
                if (_dots[i] == null) continue;

                double offset = (elapsedMs - ChevronDelays[i]) % cycleMs;
                if (offset < 0) offset += cycleMs;

                // Sine wave pulse: 0.2 to 0.95
                double phase = (offset / cycleMs) * Math.PI * 2;
                double val = 0.2 + 0.75 * Math.Max(0, Math.Sin(phase));
                _dots[i]!.Opacity = Math.Clamp(val, 0.2, 0.95);
            }
        });
        _timer.Start();
    }

    private void StopAnimation()
    {
        _timer?.Stop();
        _timer = null;
    }
}
