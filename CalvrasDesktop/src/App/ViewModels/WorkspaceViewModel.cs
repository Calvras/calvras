using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Calvras.Core.Models;
using Calvras.Core.Services;
using Calvras.Data;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Calvras.App.ViewModels;

public partial class WorkspaceViewModel : ViewModelBase
{
    private readonly IAgentRunner _agentRunner;
    private readonly IFilesystemService _fs;
    private readonly LocalDatabase _db;
    private CancellationTokenSource? _cts;

    [ObservableProperty]
    private ProjectModel? _activeProject;

    [ObservableProperty]
    private ObservableCollection<ChatMessageModel> _messages = new();

    [ObservableProperty]
    private string _promptText = string.Empty;

    [ObservableProperty]
    private bool _isBusy = false;

    [ObservableProperty]
    private string _workingStatus = "Thinking…";

    [ObservableProperty]
    private int _elapsedSeconds = 0;

    [ObservableProperty]
    private ImplementationPlanModel? _activePlan;

    [ObservableProperty]
    private bool _isPlanOpen = false;

    [ObservableProperty]
    private ObservableCollection<string> _attachedFiles = new();

    [ObservableProperty]
    private string _approvalMode = "Full speed";

    [ObservableProperty]
    private bool _isApprovalPickerOpen = false;

    [ObservableProperty]
    private string _effortLevel = "Medium";

    public WorkspaceViewModel(IAgentRunner agentRunner, IFilesystemService fs, LocalDatabase db)
    {
        _agentRunner = agentRunner;
        _fs = fs;
        _db = db;
    }

    public async Task InitializeProjectAsync(ProjectModel project)
    {
        ActiveProject = project;
        Messages.Clear();
        ActivePlan = null;
        IsPlanOpen = false;

        await _db.UpsertProjectAsync(project.Id, project.Name, project.Path, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), project.FileCount);
    }

    [RelayCommand]
    public void ToggleApprovalPicker()
    {
        IsApprovalPickerOpen = !IsApprovalPickerOpen;
    }

    [RelayCommand]
    public void SelectApprovalMode(string mode)
    {
        ApprovalMode = mode;
        IsApprovalPickerOpen = false;
    }

    [RelayCommand]
    public void CycleEffort()
    {
        EffortLevel = EffortLevel switch
        {
            "Low" => "Medium",
            "Medium" => "Max Effort",
            _ => "Low"
        };
    }

    [RelayCommand]
    public async Task SendAsync()
    {
        var text = PromptText.Trim();
        if (string.IsNullOrWhiteSpace(text) || IsBusy) return;

        IsApprovalPickerOpen = false;

        if (ActiveProject == null)
        {
            // Auto create an active project if none selected
            var proj = await _fs.CreateProjectAsync("workspace");
            await InitializeProjectAsync(proj);
        }

        PromptText = string.Empty;
        var attachments = AttachedFiles.ToList();
        AttachedFiles.Clear();

        // 1. User Message (Right-aligned bubble)
        var userMsg = new ChatMessageModel
        {
            Role = "user",
            Text = text,
            AttachedFiles = attachments.Count > 0 ? attachments : null,
            Done = true
        };
        Messages.Add(userMsg);

        // 2. Assistant Message placeholder with initial Thinking state (Left-aligned)
        var assistantMsg = new ChatMessageModel
        {
            Role = "assistant",
            Text = string.Empty,
            Phases = new List<AgentPhaseModel>(),
            Done = false,
            StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };
        Messages.Add(assistantMsg);

        IsBusy = true;
        WorkingStatus = "Thinking…";
        ElapsedSeconds = 0;
        _cts = new CancellationTokenSource();

        using var timerCts = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            while (!timerCts.Token.IsCancellationRequested)
            {
                await Task.Delay(1000);
                if (IsBusy) ElapsedSeconds++;
            }
        });

        try
        {
            var outcome = await _agentRunner.RunAsync(
                text,
                ActiveProject!.Path,
                onPhaseAdded: phase =>
                {
                    Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                    {
                        var last = Messages.LastOrDefault(m => m.Id == assistantMsg.Id);
                        if (last != null)
                        {
                            var updatedPhases = new List<AgentPhaseModel>(last.Phases) { phase };
                            var idx = Messages.IndexOf(last);
                            Messages[idx] = last with { Phases = updatedPhases };
                        }
                    });
                },
                onPhaseUpdated: updatedPhase =>
                {
                    Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                    {
                        var last = Messages.LastOrDefault(m => m.Id == assistantMsg.Id);
                        if (last != null && last.Phases.Count > 0)
                        {
                            var list = new List<AgentPhaseModel>(last.Phases);
                            list[list.Count - 1] = updatedPhase;
                            var idx = Messages.IndexOf(last);
                            Messages[idx] = last with { Phases = list };
                        }
                    });
                },
                _cts.Token
            );

            timerCts.Cancel();

            // Typing animation for the assistant reply
            var fullMessage = outcome.Message ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(fullMessage))
            {
                int currentLength = 0;
                int chunkSize = Math.Max(2, fullMessage.Length / 35);

                while (currentLength < fullMessage.Length && !_cts.Token.IsCancellationRequested)
                {
                    currentLength = Math.Min(fullMessage.Length, currentLength + chunkSize);
                    var partial = fullMessage.Substring(0, currentLength);

                    var current = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
                    if (current != null)
                    {
                        var idx = Messages.IndexOf(current);
                        Messages[idx] = current with { Text = partial };
                    }
                    await Task.Delay(20);
                }
            }

            // Finalize message state
            var finalMsg = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
            if (finalMsg != null)
            {
                var idx = Messages.IndexOf(finalMsg);
                Messages[idx] = finalMsg with
                {
                    Done = true,
                    Text = fullMessage,
                    Status = outcome.Status,
                    Error = outcome.Error,
                    EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };
            }

            if (!string.IsNullOrWhiteSpace(outcome.Plan))
            {
                ActivePlan = new ImplementationPlanModel
                {
                    Title = "Implementation Plan",
                    Content = outcome.Plan,
                    MessageId = assistantMsg.Id
                };
                // Do not auto-force drawer open
                IsPlanOpen = false;
            }
        }
        catch (OperationCanceledException)
        {
            var finalMsg = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
            if (finalMsg != null)
            {
                var idx = Messages.IndexOf(finalMsg);
                Messages[idx] = finalMsg with { Done = true, Status = "stopped", Error = "Stopped by user.", EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            }
        }
        catch (Exception ex)
        {
            var finalMsg = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
            if (finalMsg != null)
            {
                var idx = Messages.IndexOf(finalMsg);
                Messages[idx] = finalMsg with { Done = true, Status = "failed", Error = ex.Message, EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            }
        }
        finally
        {
            timerCts.Cancel();
            IsBusy = false;
            WorkingStatus = "Thinking…";
            _cts = null;
        }
    }

    [RelayCommand]
    public void Stop()
    {
        _cts?.Cancel();
    }

    [RelayCommand]
    public void QuickPrompt(string prompt)
    {
        PromptText = prompt;
        _ = SendAsync();
    }

    [RelayCommand]
    public void TogglePlan()
    {
        IsPlanOpen = !IsPlanOpen;
    }

    [RelayCommand]
    public void AddAttachment(string filePath)
    {
        if (File.Exists(filePath) && !AttachedFiles.Contains(filePath))
        {
            AttachedFiles.Add(filePath);
        }
    }

    [RelayCommand]
    public void RemoveAttachment(string filePath)
    {
        AttachedFiles.Remove(filePath);
    }
}
