using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Calvras.Core.Models;

namespace Calvras.Core.Services;

public interface IFilesystemService
{
    string ProjectsRootDirectory { get; }
    Task<ProjectModel> CreateProjectAsync(string name);
    Task<string> ReadFileAsync(string projectPath, string relativePath);
    Task<List<DiffRowModel>> WriteFileAsync(string projectPath, string relativePath, string content);
    Task<List<DiffRowModel>> EditFileAsync(string projectPath, string relativePath, int lineStart, int lineEnd, string newContent);
    Task<List<string>> ListDirAsync(string projectPath, string? relativePath);
    Task<List<string>> GetTreeAsync(string projectPath);
    Task DeleteProjectAsync(string projectPath);
}

public class FilesystemService : IFilesystemService
{
    public string ProjectsRootDirectory { get; }

    public FilesystemService(string? rootDir = null)
    {
        if (string.IsNullOrWhiteSpace(rootDir))
        {
            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            rootDir = Path.Combine(userProfile, "CalvrasProjects");
        }
        ProjectsRootDirectory = rootDir;
        Directory.CreateDirectory(ProjectsRootDirectory);
    }

    private string ResolveSafePath(string projectPath, string? relativePath)
    {
        var basePath = Path.GetFullPath(projectPath);
        if (string.IsNullOrWhiteSpace(relativePath) || relativePath == "." || relativePath == "./")
            return basePath;

        var combined = Path.GetFullPath(Path.Combine(basePath, relativePath));
        if (!combined.StartsWith(basePath, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Path traversal outside project root is not permitted.");

        return combined;
    }

    public Task<ProjectModel> CreateProjectAsync(string name)
    {
        var safeName = string.Join("-", name.Split(Path.GetInvalidFileNameChars())).Trim();
        if (string.IsNullOrWhiteSpace(safeName)) safeName = "calvras-project";

        var targetPath = Path.Combine(ProjectsRootDirectory, safeName);
        int counter = 1;
        while (Directory.Exists(targetPath))
        {
            targetPath = Path.Combine(ProjectsRootDirectory, $"{safeName}-{counter++}");
        }

        Directory.CreateDirectory(targetPath);
        var proj = new ProjectModel
        {
            Name = Path.GetFileName(targetPath),
            Path = targetPath,
            LastOpened = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            FileCount = 0
        };
        return Task.FromResult(proj);
    }

    public async Task<string> ReadFileAsync(string projectPath, string relativePath)
    {
        var fullPath = ResolveSafePath(projectPath, relativePath);
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"File not found: {relativePath}");

        return await File.ReadAllTextAsync(fullPath);
    }

    public async Task<List<DiffRowModel>> WriteFileAsync(string projectPath, string relativePath, string content)
    {
        var fullPath = ResolveSafePath(projectPath, relativePath);
        var dir = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var oldLines = File.Exists(fullPath) ? await File.ReadAllLinesAsync(fullPath) : Array.Empty<string>();
        await File.WriteAllTextAsync(fullPath, content);
        var newLines = content.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);

        var diff = new List<DiffRowModel>();
        int max = Math.Max(oldLines.Length, newLines.Length);
        int previewCount = Math.Min(max, 12);

        for (int i = 0; i < previewCount; i++)
        {
            if (i < newLines.Length && (i >= oldLines.Length || oldLines[i] != newLines[i]))
            {
                if (i < oldLines.Length)
                {
                    diff.Add(new DiffRowModel { Old = i + 1, Cur = null, Type = "del", Text = oldLines[i] });
                }
                diff.Add(new DiffRowModel { Old = null, Cur = i + 1, Type = "add", Text = newLines[i] });
            }
            else if (i < newLines.Length)
            {
                diff.Add(new DiffRowModel { Old = i + 1, Cur = i + 1, Type = "ctx", Text = newLines[i] });
            }
        }
        return diff;
    }

    public async Task<List<DiffRowModel>> EditFileAsync(string projectPath, string relativePath, int lineStart, int lineEnd, string newContent)
    {
        var fullPath = ResolveSafePath(projectPath, relativePath);
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"File not found: {relativePath}");

        var lines = (await File.ReadAllLinesAsync(fullPath)).ToList();
        var replacementLines = newContent.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);

        int startIdx = Math.Max(0, lineStart - 1);
        int endIdx = Math.Min(lines.Count, lineEnd);
        int countToRemove = Math.Max(0, endIdx - startIdx);

        var diff = new List<DiffRowModel>();
        for (int i = startIdx; i < startIdx + countToRemove && i < lines.Count; i++)
        {
            diff.Add(new DiffRowModel { Old = i + 1, Cur = null, Type = "del", Text = lines[i] });
        }

        lines.RemoveRange(startIdx, countToRemove);
        lines.InsertRange(startIdx, replacementLines);

        for (int i = 0; i < replacementLines.Length; i++)
        {
            diff.Add(new DiffRowModel { Old = null, Cur = startIdx + i + 1, Type = "add", Text = replacementLines[i] });
        }

        await File.WriteAllLinesAsync(fullPath, lines);
        return diff;
    }

    public Task<List<string>> ListDirAsync(string projectPath, string? relativePath)
    {
        var fullPath = ResolveSafePath(projectPath, relativePath);
        if (!Directory.Exists(fullPath))
            return Task.FromResult(new List<string>());

        var entries = Directory.GetFileSystemEntries(fullPath)
            .Select(p => Path.GetFileName(p) + (Directory.Exists(p) ? "/" : ""))
            .Where(name => !name.StartsWith(".") && name != "node_modules/" && name != "bin/" && name != "obj/")
            .OrderBy(n => n)
            .ToList();

        return Task.FromResult(entries);
    }

    public Task<List<string>> GetTreeAsync(string projectPath)
    {
        var basePath = Path.GetFullPath(projectPath);
        if (!Directory.Exists(basePath))
            return Task.FromResult(new List<string>());

        var files = Directory.EnumerateFiles(basePath, "*", SearchOption.AllDirectories)
            .Where(f => !f.Contains("\\.") && !f.Contains("/.") &&
                        !f.Contains("\\node_modules\\") && !f.Contains("/node_modules/") &&
                        !f.Contains("\\bin\\") && !f.Contains("\\obj\\"))
            .Select(f => Path.GetRelativePath(basePath, f).Replace('\\', '/'))
            .OrderBy(f => f)
            .ToList();

        return Task.FromResult(files);
    }

    public Task DeleteProjectAsync(string projectPath)
    {
        if (Directory.Exists(projectPath))
        {
            Directory.Delete(projectPath, recursive: true);
        }
        return Task.CompletedTask;
    }
}
