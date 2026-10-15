using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Calvras.Core.Services;

public record ProcessResult(int ExitCode, string Output, long DurationMs);

public interface IProcessRunner
{
    Task<ProcessResult> ExecuteCommandAsync(string command, string workingDirectory, CancellationToken cancellationToken = default);
}

public class ProcessRunner : IProcessRunner
{
    public async Task<ProcessResult> ExecuteCommandAsync(string command, string workingDirectory, CancellationToken cancellationToken = default)
    {
        var sw = Stopwatch.StartNew();
        var outputBuilder = new StringBuilder();

        var isWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        var shell = isWindows ? "powershell.exe" : "bash";
        var args = isWindows ? $"-NoProfile -NonInteractive -Command \"{command.Replace("\"", "\\\"")}\"" : $"-c \"{command.Replace("\"", "\\\"")}\"";

        var psi = new ProcessStartInfo
        {
            FileName = shell,
            Arguments = args,
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = new Process { StartInfo = psi };
        var tcsLocalhost = new TaskCompletionSource<bool>();

        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null)
            {
                outputBuilder.AppendLine(e.Data);
                if (e.Data.Contains("localhost:", StringComparison.OrdinalIgnoreCase) ||
                    e.Data.Contains("127.0.0.1:", StringComparison.OrdinalIgnoreCase) ||
                    e.Data.Contains("Local:", StringComparison.OrdinalIgnoreCase))
                {
                    tcsLocalhost.TrySetResult(true);
                }
            }
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null) outputBuilder.AppendLine(e.Data);
        };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // 45s safety timeout to prevent frozen terminal commands
        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

        try
        {
            var exitTask = process.WaitForExitAsync(linkedCts.Token);
            var completed = await Task.WhenAny(exitTask, tcsLocalhost.Task);

            // If a dev server URL was found in the output, it is running! Don't hang forever waiting for it to exit
            if (completed == tcsLocalhost.Task && !process.HasExited)
            {
                await Task.Delay(2000, cancellationToken);
                sw.Stop();
                return new ProcessResult(0, outputBuilder.ToString().TrimEnd(), sw.ElapsedMilliseconds);
            }

            await exitTask;
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            sw.Stop();
            return new ProcessResult(0, outputBuilder.ToString().TrimEnd() + "\n[Command timed out]", sw.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw;
        }

        sw.Stop();
        return new ProcessResult(process.ExitCode, outputBuilder.ToString().TrimEnd(), sw.ElapsedMilliseconds);
    }
}
