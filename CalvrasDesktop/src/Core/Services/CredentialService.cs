using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace Calvras.Core.Services;

public interface ICredentialService
{
    Task SetSecretAsync(string key, string secret);
    Task<string?> GetSecretAsync(string key);
    Task DeleteSecretAsync(string key);
}

public class WindowsCredentialService : ICredentialService
{
    private readonly string _storageDir;

    public WindowsCredentialService()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _storageDir = Path.Combine(localAppData, "Calvras", "Vault");
        Directory.CreateDirectory(_storageDir);
    }

    private string GetFilePath(string key)
    {
        var safeKey = Convert.ToBase64String(Encoding.UTF8.GetBytes(key))
            .Replace('/', '_')
            .Replace('+', '-');
        return Path.Combine(_storageDir, $"{safeKey}.bin");
    }

    public Task SetSecretAsync(string key, string secret)
    {
        var path = GetFilePath(key);
        var rawBytes = Encoding.UTF8.GetBytes(secret);

        byte[] encryptedBytes;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            encryptedBytes = ProtectedData.Protect(rawBytes, null, DataProtectionScope.CurrentUser);
        }
        else
        {
            encryptedBytes = rawBytes;
        }

        File.WriteAllBytes(path, encryptedBytes);
        return Task.CompletedTask;
    }

    public Task<string?> GetSecretAsync(string key)
    {
        var path = GetFilePath(key);
        if (!File.Exists(path))
            return Task.FromResult<string?>(null);

        try
        {
            var encryptedBytes = File.ReadAllBytes(path);
            byte[] rawBytes;
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                rawBytes = ProtectedData.Unprotect(encryptedBytes, null, DataProtectionScope.CurrentUser);
            }
            else
            {
                rawBytes = encryptedBytes;
            }
            return Task.FromResult<string?>(Encoding.UTF8.GetString(rawBytes));
        }
        catch
        {
            return Task.FromResult<string?>(null);
        }
    }

    public Task DeleteSecretAsync(string key)
    {
        var path = GetFilePath(key);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        return Task.CompletedTask;
    }
}
