using System;
using System.IO;
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
    private UpdateInfo? _pendingUpdate;

    public string CurrentVersion
    {
        get
        {
            try
            {
                var mgr = GetOrCreateManager();
                return mgr.IsInstalled ? mgr.CurrentVersion?.ToString() ?? "1.0.0" : "1.0.0";
            }
            catch
            {
                return "1.0.0";
            }
        }
    }

    private UpdateManager GetOrCreateManager()
    {
        if (_updateManager != null) return _updateManager;

        // Try to locate update channel:
        // 1. Web release endpoint: https://calvras.com/releases
        // 2. Fallback to local installer folder if present
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
        try
        {
            var mgr = GetOrCreateManager();
            if (!mgr.IsInstalled)
            {
                return (false, null, $"Calvras v{CurrentVersion} (Portable / Dev)");
            }

            var updateInfo = await mgr.CheckForUpdatesAsync();
            if (updateInfo == null)
            {
                return (false, null, $"You are up to date! (v{CurrentVersion})");
            }

            _pendingUpdate = updateInfo;
            var ver = updateInfo.TargetFullRelease.Version.ToString();
            return (true, ver, $"New version v{ver} available!");
        }
        catch (Exception)
        {
            return (false, null, $"Update check: Up to date (v{CurrentVersion})");
        }
    }

    public async Task<bool> DownloadAndInstallUpdateAsync(Action<int>? onProgress = null)
    {
        try
        {
            if (_pendingUpdate == null)
            {
                var check = await CheckForUpdatesAsync();
                if (!check.hasUpdate || _pendingUpdate == null) return false;
            }

            var mgr = GetOrCreateManager();
            await mgr.DownloadUpdatesAsync(_pendingUpdate, onProgress);
            mgr.ApplyUpdatesAndRestart(_pendingUpdate);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
