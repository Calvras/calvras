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

        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null) outputBuilder.AppendLine(e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null) outputBuilder.AppendLine(e.Data);
        };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        try
        {
            await process.WaitForExitAsync(cancellationToken);
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
