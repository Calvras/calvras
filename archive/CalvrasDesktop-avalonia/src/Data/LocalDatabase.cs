using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;

namespace Calvras.Data;

public class LocalDatabase
{
    private readonly string _connectionString;

    public LocalDatabase(string? dbPath = null)
    {
        if (string.IsNullOrWhiteSpace(dbPath))
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var dir = Path.Combine(appData, "Calvras");
            Directory.CreateDirectory(dir);
            dbPath = Path.Combine(dir, "calvras.db");
        }

        _connectionString = $"Data Source={dbPath}";
    }

    public async Task InitializeAsync()
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        var sql = @"
            CREATE TABLE IF NOT EXISTS Projects (
                Id TEXT PRIMARY KEY,
                Name TEXT NOT NULL,
                Path TEXT NOT NULL,
                LastOpened INTEGER NOT NULL,
                FileCount INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS ChatSessions (
                Id TEXT PRIMARY KEY,
                Title TEXT NOT NULL,
                ProjectId TEXT,
                CreatedAt INTEGER NOT NULL,
                UpdatedAt INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ChatMessages (
                Id TEXT PRIMARY KEY,
                SessionId TEXT NOT NULL,
                Role TEXT NOT NULL,
                Text TEXT NOT NULL,
                PhasesJson TEXT,
                Done INTEGER NOT NULL DEFAULT 1,
                Status TEXT,
                Error TEXT,
                StartedAt INTEGER,
                EndedAt INTEGER,
                AttachmentsJson TEXT
            );

            CREATE TABLE IF NOT EXISTS LocalSettings (
                Key TEXT PRIMARY KEY,
                Value TEXT NOT NULL
            );
        ";

        await using var cmd = new SqliteCommand(sql, connection);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<List<Dictionary<string, object>>> GetRecentProjectsAsync()
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        var sql = "SELECT Id, Name, Path, LastOpened, FileCount FROM Projects ORDER BY LastOpened DESC LIMIT 20;";
        await using var cmd = new SqliteCommand(sql, connection);
        await using var reader = await cmd.ExecuteReaderAsync();

        var list = new List<Dictionary<string, object>>();
        while (await reader.ReadAsync())
        {
            list.Add(new Dictionary<string, object>
            {
                ["Id"] = reader.GetString(0),
                ["Name"] = reader.GetString(1),
                ["Path"] = reader.GetString(2),
                ["LastOpened"] = reader.GetInt64(3),
                ["FileCount"] = reader.GetInt32(4)
            });
        }
        return list;
    }

    public async Task UpsertProjectAsync(string id, string name, string path, long lastOpened, int fileCount)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        var sql = @"
            INSERT INTO Projects (Id, Name, Path, LastOpened, FileCount)
            VALUES (@id, @name, @path, @lastOpened, @fileCount)
            ON CONFLICT(Id) DO UPDATE SET
                Name = @name,
                Path = @path,
                LastOpened = @lastOpened,
                FileCount = @fileCount;
        ";

        await using var cmd = new SqliteCommand(sql, connection);
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@name", name);
        cmd.Parameters.AddWithValue("@path", path);
        cmd.Parameters.AddWithValue("@lastOpened", lastOpened);
        cmd.Parameters.AddWithValue("@fileCount", fileCount);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task DeleteProjectAsync(string id)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        var sql = "DELETE FROM Projects WHERE Id = @id;";
        await using var cmd = new SqliteCommand(sql, connection);
        cmd.Parameters.AddWithValue("@id", id);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<string?> GetSettingAsync(string key)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        var sql = "SELECT Value FROM LocalSettings WHERE Key = @key LIMIT 1;";
        await using var cmd = new SqliteCommand(sql, connection);
        cmd.Parameters.AddWithValue("@key", key);
        var result = await cmd.ExecuteScalarAsync();
        return result?.ToString();
    }

    public async Task SetSettingAsync(string key, string value)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        var sql = @"
            INSERT INTO LocalSettings (Key, Value)
            VALUES (@key, @value)
            ON CONFLICT(Key) DO UPDATE SET Value = @value;
        ";
        await using var cmd = new SqliteCommand(sql, connection);
        cmd.Parameters.AddWithValue("@key", key);
        cmd.Parameters.AddWithValue("@value", value);
        await cmd.ExecuteNonQueryAsync();
    }
}
