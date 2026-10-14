using Avalonia;
using System;
using Velopack;

namespace Calvras.App;

sealed class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        var logPath = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Calvras", "startup.log");
        try
        {
            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(logPath)!);
            System.IO.File.WriteAllText(logPath, $"Starting at {DateTime.Now}\n");

            try
            {
                VelopackApp.Build().Run();
                System.IO.File.AppendAllText(logPath, "Velopack passed\n");
            }
            catch (Exception ex)
            {
                System.IO.File.AppendAllText(logPath, $"Velopack ignored: {ex.Message}\n");
            }

            System.IO.File.AppendAllText(logPath, "Starting Avalonia App...\n");
            BuildAvaloniaApp()
                .StartWithClassicDesktopLifetime(args);
            System.IO.File.AppendAllText(logPath, "Avalonia App exited cleanly\n");
        }
        catch (Exception ex)
        {
            System.IO.File.AppendAllText(logPath, $"FATAL CRASH: {ex}\n");
        }
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
