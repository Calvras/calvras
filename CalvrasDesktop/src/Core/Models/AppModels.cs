using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Calvras.Core.Models;

public record ProjectModel
{
    public string Id { get; init; } = Guid.NewGuid().ToString();
    public string Name { get; init; } = string.Empty;
    public string Path { get; init; } = string.Empty;
    public long LastOpened { get; init; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public int FileCount { get; init; } = 0;
}

public record DiffRowModel
{
    [JsonPropertyName("old")]
    public int? Old { get; init; }

    [JsonPropertyName("cur")]
    public int? Cur { get; init; }

    [JsonPropertyName("type")]
    public string Type { get; init; } = "ctx"; // "add" | "del" | "ctx"

    [JsonPropertyName("text")]
    public string Text { get; init; } = string.Empty;
}

public record DetailLineModel
{
    [JsonPropertyName("text")]
    public string Text { get; init; } = string.Empty;

    [JsonPropertyName("tone")]
    public string? Tone { get; init; } // "add" | "del" | "ctx" | "muted" | "error"
}

public record TraceSourceModel
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;

    [JsonPropertyName("url")]
    public string? Url { get; init; }
}

public record TraceNodeModel
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = Guid.NewGuid().ToString();

    [JsonPropertyName("type")]
    public string Type { get; init; } = "tool"; // "reasoning" | "tool" | "terminal" | "search" | "step"

    [JsonPropertyName("toolName")]
    public string? ToolName { get; init; }

    [JsonPropertyName("primary")]
    public string? Primary { get; init; }

    [JsonPropertyName("secondary")]
    public string? Secondary { get; init; }

    [JsonPropertyName("mono")]
    public bool Mono { get; init; }

    [JsonPropertyName("status")]
    public string Status { get; init; } = "completed"; // "pending" | "running" | "completed" | "failed"

    [JsonPropertyName("command")]
    public string? Command { get; init; }

    [JsonPropertyName("output")]
    public string? Output { get; init; }

    [JsonPropertyName("exitCode")]
    public int? ExitCode { get; init; }

    [JsonPropertyName("durationMs")]
    public int? DurationMs { get; init; }

    [JsonPropertyName("sentences")]
    public List<string>? Sentences { get; init; }

    [JsonPropertyName("durationSeconds")]
    public double? DurationSeconds { get; init; }

    [JsonPropertyName("add")]
    public int? Add { get; init; }

    [JsonPropertyName("del")]
    public int? Del { get; init; }

    [JsonPropertyName("diffFile")]
    public string? DiffFile { get; init; }

    [JsonPropertyName("diffRows")]
    public List<DiffRowModel>? DiffRows { get; init; }

    [JsonPropertyName("details")]
    public List<DetailLineModel>? Details { get; init; }

    [JsonPropertyName("sources")]
    public List<TraceSourceModel>? Sources { get; init; }
}

public record AgentPhaseModel
{
    [JsonPropertyName("trace")]
    public List<TraceNodeModel> Trace { get; init; } = new();

    [JsonPropertyName("message")]
    public string? Message { get; init; }
}

public record ChatMessageModel
{
    public string Id { get; init; } = Guid.NewGuid().ToString();
    public string Role { get; init; } = "assistant"; // "user" | "assistant"
    public string Text { get; init; } = string.Empty;
    public List<AgentPhaseModel> Phases { get; init; } = new();
    public bool Done { get; init; } = true;
    public string? Status { get; init; }
    public string? Error { get; init; }
    public long? StartedAt { get; init; }
    public long? EndedAt { get; init; }
    public List<string>? AttachedFiles { get; init; }

    public bool IsUser => Role == "user";
    public bool IsAssistant => Role == "assistant";
    public bool HasText => !string.IsNullOrWhiteSpace(Text);
    public bool HasAttachedFiles => AttachedFiles != null && AttachedFiles.Count > 0;
}

public record ImplementationPlanModel
{
    public string Title { get; init; } = "Implementation Plan";
    public string Content { get; init; } = string.Empty;
    public string MessageId { get; init; } = string.Empty;
}

public record AgentActionModel
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;

    [JsonPropertyName("path")]
    public string? Path { get; init; }

    [JsonPropertyName("command")]
    public string? Command { get; init; }

    [JsonPropertyName("content")]
    public string? Content { get; init; }

    [JsonPropertyName("newContent")]
    public string? NewContent { get; init; }

    [JsonPropertyName("lineStart")]
    public int? LineStart { get; init; }

    [JsonPropertyName("lineEnd")]
    public int? LineEnd { get; init; }
}

public record AgentReplyModel
{
    [JsonPropertyName("actions")]
    public List<AgentActionModel> Actions { get; init; } = new();

    [JsonPropertyName("message")]
    public string Message { get; init; } = string.Empty;

    [JsonPropertyName("status")]
    public string? Status { get; init; }

    [JsonPropertyName("plan")]
    public string? Plan { get; init; }
}
