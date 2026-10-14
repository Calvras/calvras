using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Calvras.Core.Models;

namespace Calvras.Core.Services;

public interface ICalvrasApiClient
{
    string BaseUrl { get; set; }
    void SetAuthToken(string token);
    Task<string> CallAgentInferenceAsync(string prompt, string? projectSnapshot, CancellationToken cancellationToken = default);
}

public class CalvrasApiClient : ICalvrasApiClient
{
    private readonly HttpClient _httpClient;
    private string _baseUrl = "https://calvras.com";

    public string BaseUrl
    {
        get => _baseUrl;
        set
        {
            _baseUrl = value.TrimEnd('/');
            _httpClient.BaseAddress = new Uri(_baseUrl);
        }
    }

    public CalvrasApiClient(HttpClient? httpClient = null)
    {
        _httpClient = httpClient ?? new HttpClient();
        _httpClient.BaseAddress = new Uri(_baseUrl);
        _httpClient.Timeout = TimeSpan.FromMinutes(3);
    }

    public void SetAuthToken(string token)
    {
        if (!string.IsNullOrWhiteSpace(token))
        {
            _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        else
        {
            _httpClient.DefaultRequestHeaders.Authorization = null;
        }
    }

    public async Task<string> CallAgentInferenceAsync(string prompt, string? projectSnapshot, CancellationToken cancellationToken = default)
    {
        var messages = new List<object>
        {
            new
            {
                role = "system",
                content = @"You are Calvras, an autonomous coding agent with full local terminal and filesystem execution.
CRITICAL RULES:
- NEVER introduce yourself ('Hello! I am Calvras...', 'I am an elite coding agent...'). Never give introductory preamble or canned conversational filler.
- Be immediate, concise, direct, and pragmatic.
- When the user asks you to build, create, run, or edit anything, immediately emit the concrete actions (create_file, write_file, run_command, etc.) to perform the task.
- Use an occasional, diverse emoji (🚀, ✨, 🛠️, 💡, ⚡) only when natural. Never overuse.

AVAILABLE ACTIONS:
- ""read_file"": Read a file before editing it.
- ""write_file"": Write/overwrite a file.
- ""create_file"": Create a new file.
- ""edit_file"": Surgical line-range edit.
- ""run_command"": Run shell commands (npm install, npm start, dotnet run, python app.py, etc.).
- ""list_dir"": List directory contents.

OUTPUT FORMAT — raw valid JSON only:
{
  ""status"": ""finished"",
  ""actions"": [
    { ""type"": ""run_command"", ""command"": ""npm test"" }
  ],
  ""message"": ""Direct concise answer or update."",
  ""plan"": ""Optional markdown plan.""
}"
            }
        };

        if (!string.IsNullOrWhiteSpace(projectSnapshot))
        {
            messages.Add(new
            {
                role = "system",
                content = $"[ACTIVE PROJECT CONTEXT]\n{projectSnapshot}"
            });
        }

        messages.Add(new
        {
            role = "user",
            content = prompt
        });

        var requestBody = new
        {
            model = "gemini-2.5-flash",
            messages,
            temperature = 0.2
        };

        var json = JsonSerializer.Serialize(requestBody);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        // Try primary /api/v1/chat/completions endpoint
        try
        {
            var response = await _httpClient.PostAsync("/api/v1/chat/completions", content, cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                var respJson = await response.Content.ReadAsStringAsync(cancellationToken);
                using var doc = JsonDocument.Parse(respJson);
                var root = doc.RootElement;
                if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0)
                {
                    var msg = choices[0].GetProperty("message");
                    return msg.GetProperty("content").GetString() ?? "{}";
                }
            }
        }
        catch when (!cancellationToken.IsCancellationRequested)
        {
            // Fallback to direct cloudflare worker URL if custom domain is unreachable
            if (!_baseUrl.Contains("workers.dev"))
            {
                var fallbackUrl = "https://calvras.zenithzone18.workers.dev/api/v1/chat/completions";
                var fallbackContent = new StringContent(json, Encoding.UTF8, "application/json");
                var fbResp = await _httpClient.PostAsync(fallbackUrl, fallbackContent, cancellationToken);
                if (fbResp.IsSuccessStatusCode)
                {
                    var respJson = await fbResp.Content.ReadAsStringAsync(cancellationToken);
                    using var doc = JsonDocument.Parse(respJson);
                    var choices = doc.RootElement.GetProperty("choices");
                    if (choices.GetArrayLength() > 0)
                    {
                        return choices[0].GetProperty("message").GetProperty("content").GetString() ?? "{}";
                    }
                }
            }
        }

        throw new HttpRequestException("Failed to receive a valid response from the Calvras AI engine.");
    }
}
