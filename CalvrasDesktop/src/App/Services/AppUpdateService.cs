using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace Calvras.App.Services;

public interface IAppUpdateService
{
    string CurrentVersion { get; }
    Task<(bool hasUpdate, string? newVersion, string message)> CheckForUpdatesAsync();
    Task<bool> DownloadAndInstallUpdateAsync(Action<int>? onProgress = null);
}

public class AppUpdateService : IAppUpdateService
{
    private UpdateManager? _updateManager;
    private UpdateInfo? _pendingVelopackUpdate;
    private string? _pendingGitHubDownloadUrl;

    public string CurrentVersion
    {
        get
        {
            var asmVer = Assembly.GetExecutingAssembly().GetName().Version;
            if (asmVer != null)
            {
                return $"{asmVer.Major}.{asmVer.Minor}.{asmVer.Build}";
            }
            return "1.0.3";
        }
    }

    private UpdateManager GetOrCreateManager()
    {
        if (_updateManager != null) return _updateManager;

        var localDist = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..", "dist", "installer");
        if (Directory.Exists(localDist))
        {
            _updateManager = new UpdateManager(localDist);
        }
        else
        {
            _updateManager = new UpdateManager(new SimpleWebSource("https://calvras.com/releases"));
        }

        return _updateManager;
    }

    public async Task<(bool hasUpdate, string? newVersion, string message)> CheckForUpdatesAsync()
    {
        // 1. Try Velopack if installed
        try
        {
            var mgr = GetOrCreateManager();
            if (mgr.IsInstalled)
            {
                var updateInfo = await mgr.CheckForUpdatesAsync();
                if (updateInfo != null)
                {
                    _pendingVelopackUpdate = updateInfo;
                    var ver = updateInfo.TargetFullRelease.Version.ToString();
                    return (true, ver, $"New version v{ver} available!");
                }
            }
        }
        catch { }

        // 2. Direct GitHub Release Check (reliably detects when an update is pushed to GitHub)
        try
        {
            using var http = new HttpClient();
            http.DefaultRequestHeaders.UserAgent.ParseAdd("CalvrasDesktop");
            http.Timeout = TimeSpan.FromSeconds(8);

            var json = await http.GetStringAsync("https://api.github.com/repos/SHIKARI-hey/Calvras/releases/latest");
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (root.TryGetProperty("tag_name", out var tagProp))
            {
                var tag = tagProp.GetString()?.Trim().TrimStart('v') ?? "";
                if (Version.TryParse(tag, out var remoteVer) && Version.TryParse(CurrentVersion, out var localVer))
                {
                    if (remoteVer > localVer)
                    {
                        string? downloadUrl = null;
                        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var asset in assets.EnumerateArray())
                            {
                                var name = asset.GetProperty("name").GetString() ?? "";
                                if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                                {
                                    downloadUrl = asset.GetProperty("browser_download_url").GetString();
                                    break;
                                }
                            }
                        }

                        _pendingGitHubDownloadUrl = downloadUrl;
                        return (true, tag, $"Update v{tag} is available!");
                    }
                }
            }

            return (false, null, $"Calvras is up to date (v{CurrentVersion})");
        }
        catch
        {
            return (false, null, $"Up to date (v{CurrentVersion})");
        }
    }

    public async Task<bool> DownloadAndInstallUpdateAsync(Action<int>? onProgress = null)
    {
        // 1. If Velopack update is available
        if (_pendingVelopackUpdate != null)
        {
            try
            {
                var mgr = GetOrCreateManager();
                await mgr.DownloadUpdatesAsync(_pendingVelopackUpdate, onProgress);
                mgr.ApplyUpdatesAndRestart(_pendingVelopackUpdate);
                return true;
            }
            catch { }
        }

        // 2. If GitHub release installer is available
        if (!string.IsNullOrEmpty(_pendingGitHubDownloadUrl))
        {
            try
            {
                using var http = new HttpClient();
                http.DefaultRequestHeaders.UserAgent.ParseAdd("CalvrasDesktop");
                var tempFile = Path.Combine(Path.GetTempPath(), "Calvras-Setup.exe");

                using (var response = await http.GetAsync(_pendingGitHubDownloadUrl, HttpCompletionOption.ResponseHeadersRead))
                {
                    response.EnsureSuccessStatusCode();
                    var totalBytes = response.Content.Headers.ContentLength ?? -1L;
                    using var contentStream = await response.Content.ReadAsStreamAsync();
                    using var fileStream = new FileStream(tempFile, FileMode.Create, FileAccess.Write, FileShare.None, 8192, true);

                    var buffer = new byte[8192];
                    long totalRead = 0;
                    int bytesRead;

                    while ((bytesRead = await contentStream.ReadAsync(buffer, 0, buffer.Length)) > 0)
                    {
                        await fileStream.WriteAsync(buffer, 0, bytesRead);
                        totalRead += bytesRead;
                        if (totalBytes > 0 && onProgress != null)
                        {
                            var pct = (int)((totalRead * 100) / totalBytes);
                            onProgress(pct);
                        }
                    }
                }

                Process.Start(new ProcessStartInfo
                {
                    FileName = tempFile,
                    UseShellExecute = true
                });

                Environment.Exit(0);
                return true;
            }
            catch
            {
                return false;
            }
        }

        return false;
    }
}
