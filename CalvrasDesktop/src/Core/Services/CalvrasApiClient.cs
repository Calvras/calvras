using System;
using System.Collections.Generic;
using System.IO;
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
    Task StreamAgentInferenceAsync(string prompt, string? projectSnapshot, Action<string> onToken, CancellationToken ct = default);
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

    private static readonly string SystemPromptContent = LoadSystemPrompt();

    private static string LoadSystemPrompt()
    {
        try
        {
            var asm = typeof(CalvrasApiClient).Assembly;
            using var stream = asm.GetManifestResourceStream("Calvras.Core.Prompts.SystemPrompt.md");
            if (stream != null)
            {
                using var reader = new StreamReader(stream, Encoding.UTF8);
                return reader.ReadToEnd();
            }
        }
        catch { }

        // Fallback if resource stream cannot be located
        var diskPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Prompts", "SystemPrompt.md");
        if (File.Exists(diskPath))
        {
            try { return File.ReadAllText(diskPath); } catch { }
        }

        return "You are Calvras, a senior engineer sitting next to the user. Talk naturally, be helpful, warm and direct.";
    }

    public async Task<string> CallAgentInferenceAsync(string prompt, string? projectSnapshot, CancellationToken cancellationToken = default)
    {
        var messages = new List<object>
        {
            new
            {
                role = "system",
                content = SystemPromptContent
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

    public async Task StreamAgentInferenceAsync(string prompt, string? projectSnapshot, Action<string> onToken, CancellationToken ct = default)
    {
        var messages = new List<object>
        {
            new
            {
                role = "system",
                content = SystemPromptContent
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
            temperature = 0.2,
            stream = true
        };

        var json = JsonSerializer.Serialize(requestBody);

        async Task StreamFromUrl(string url)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };

            using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();

            using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream, Encoding.UTF8);

            while (!reader.EndOfStream)
            {
                ct.ThrowIfCancellationRequested();
                var line = await reader.ReadLineAsync();
                if (string.IsNullOrWhiteSpace(line)) continue;
                if (!line.StartsWith("data: ")) continue;

                var data = line.Substring(6).Trim();
                if (data == "[DONE]") break;

                try
                {
                    using var doc = JsonDocument.Parse(data);
                    var root = doc.RootElement;
                    if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0)
                    {
                        var delta = choices[0].GetProperty("delta");
                        if (delta.TryGetProperty("content", out var contentProp))
                        {
                            var chunk = contentProp.GetString();
                            if (!string.IsNullOrEmpty(chunk))
                                onToken(chunk);
                        }
                    }
                }
                catch (JsonException)
                {
                    // Malformed chunk — skip it
                }
            }
        }

        try
        {
            await StreamFromUrl("/api/v1/chat/completions");
        }
        catch when (!ct.IsCancellationRequested && !_baseUrl.Contains("workers.dev"))
        {
            await StreamFromUrl("https://calvras.zenithzone18.workers.dev/api/v1/chat/completions");
        }
    }
}
