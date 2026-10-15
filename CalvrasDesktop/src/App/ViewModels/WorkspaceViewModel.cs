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
    private System.Speech.Recognition.SpeechRecognitionEngine? _recognizer;
    private readonly List<(string role, string content)> _conversationHistory = new();

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

    [ObservableProperty]
    private string _selectedModel = "GPT 5.5";

    [ObservableProperty]
    private bool _isModelPickerOpen = false;

    [ObservableProperty]
    private bool _isRecording = false;

    [ObservableProperty]
    private bool _isInputExpanded = true;

    public event Action? ScrollToBottom;

    public bool HasTextToSend => !string.IsNullOrWhiteSpace(PromptText) || AttachedFiles.Count > 0;
    public bool ShowMicButton => !HasTextToSend && !IsBusy && !IsRecording;

    partial void OnPromptTextChanged(string value)
    {
        OnPropertyChanged(nameof(HasTextToSend));
        OnPropertyChanged(nameof(ShowMicButton));
    }

    partial void OnIsBusyChanged(bool value)
    {
        OnPropertyChanged(nameof(ShowMicButton));
    }

    partial void OnIsRecordingChanged(bool value)
    {
        OnPropertyChanged(nameof(ShowMicButton));
    }

    public WorkspaceViewModel(IAgentRunner agentRunner, IFilesystemService fs, LocalDatabase db)
    {
        _agentRunner = agentRunner;
        _fs = fs;
        _db = db;
        AttachedFiles.CollectionChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(HasTextToSend));
            OnPropertyChanged(nameof(ShowMicButton));
        };
    }

    public async Task InitializeProjectAsync(ProjectModel project, bool clearMessages = true)
    {
        ActiveProject = project;
        if (clearMessages)
        {
            Messages.Clear();
            ActivePlan = null;
            IsPlanOpen = false;
        }

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
        IsModelPickerOpen = false;

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

        // Cap history at 40 entries (20 turns), then add current user message
        if (_conversationHistory.Count >= 40)
            _conversationHistory.RemoveRange(0, 2);
        _conversationHistory.Add(("user", text));
        // 2. Assistant Message placeholder
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

        var timer = new Avalonia.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        timer.Tick += (_, _) =>
        {
            if (IsBusy) ElapsedSeconds++;
            else timer.Stop();
        };
        timer.Start();

        try
        {
            // Ensure a project exists — inside try so any IO failure shows as error, not crash
            if (ActiveProject == null)
            {
                var proj = await _fs.CreateProjectAsync("project");
                await InitializeProjectAsync(proj, clearMessages: false);
            }

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
                            if (idx >= 0 && idx < Messages.Count)
                                Messages[idx] = last with { Phases = updatedPhases };
                            ScrollToBottom?.Invoke();
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
                            if (idx >= 0 && idx < Messages.Count)
                                Messages[idx] = last with { Phases = list };
                            ScrollToBottom?.Invoke();
                        }
                    });
                },
                onToken: chunk =>
                {
                    Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                    {
                        var current = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
                        if (current != null)
                        {
                            var idx = Messages.IndexOf(current);
                            if (idx >= 0 && idx < Messages.Count)
                                Messages[idx] = current with { Text = current.Text + chunk };
                        }
                        ScrollToBottom?.Invoke();
                    });
                },
                conversationHistory: _conversationHistory,
                attachedImages: attachments,
                cancellationToken: _cts.Token
            );

            timer.Stop();

            // The final message text was already streamed token-by-token via onToken.
            // Keep fullMessage for the final Done=true update below.
            var fullMessage = outcome.Message ?? string.Empty;

            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                var finalMsg = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
                if (finalMsg != null)
                {
                    var idx = Messages.IndexOf(finalMsg);
                    if (idx >= 0 && idx < Messages.Count)
                    {
                        Messages[idx] = finalMsg with
                        {
                            Done = true,
                            Text = fullMessage,
                            Status = outcome.Status,
                            Error = outcome.Error,
                            EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                        };
                    }
                }

                if (!string.IsNullOrWhiteSpace(outcome.Plan))
                {
                    ActivePlan = new ImplementationPlanModel
                    {
                        Title = "Implementation Plan",
                        Content = outcome.Plan,
                        MessageId = assistantMsg.Id
                    };
                    IsPlanOpen = false;
                }
            });

            // Record assistant reply in conversation history
            if (!string.IsNullOrWhiteSpace(fullMessage))
                _conversationHistory.Add(("assistant", fullMessage));
        }
        catch (OperationCanceledException)
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                var finalMsg = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
                if (finalMsg != null)
                {
                    var idx = Messages.IndexOf(finalMsg);
                    if (idx >= 0 && idx < Messages.Count)
                        Messages[idx] = finalMsg with { Done = true, Status = "stopped", Error = "Stopped by user.", EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                }
            });
        }
        catch (Exception ex)
        {
            // Any failure (network, filesystem, etc.) shows as an error in the chat — never crashes the app
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                var finalMsg = Messages.FirstOrDefault(m => m.Id == assistantMsg.Id);
                if (finalMsg != null)
                {
                    var idx = Messages.IndexOf(finalMsg);
                    if (idx >= 0 && idx < Messages.Count)
                        Messages[idx] = finalMsg with { Done = true, Status = "failed", Error = ex.Message, EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                }
            });
        }
        finally
        {
            timer.Stop();
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
    public void ToggleModelPicker()
    {
        IsModelPickerOpen = !IsModelPickerOpen;
    }

    [RelayCommand]
    public void ExpandInput()
    {
        IsInputExpanded = true;
    }

    [RelayCommand]
    public void CollapseInput()
    {
        // Input is always expanded — no-op.
    }

    [RelayCommand]
    public void SelectModel(string model)
    {
        SelectedModel = model;
        IsModelPickerOpen = false;
    }

    [RelayCommand]
    public void ToggleVoiceRecording()
    {
        if (IsRecording)
        {
            StopVoiceRecording();
        }
        else
        {
            StartVoiceRecording();
        }
    }

    private void StartVoiceRecording()
    {
        try
        {
            _recognizer = new System.Speech.Recognition.SpeechRecognitionEngine();
            _recognizer.SetInputToDefaultAudioDevice();
            _recognizer.LoadGrammar(new System.Speech.Recognition.DictationGrammar());
            _recognizer.SpeechRecognized += (s, e) =>
            {
                if (e.Result != null && !string.IsNullOrWhiteSpace(e.Result.Text))
                {
                    Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                    {
                        PromptText = string.IsNullOrWhiteSpace(PromptText) ? e.Result.Text : $"{PromptText} {e.Result.Text}";
                    });
                }
            };
            _recognizer.RecognizeAsync(System.Speech.Recognition.RecognizeMode.Multiple);
            IsRecording = true;
        }
        catch
        {
            IsRecording = false;
        }
    }

    private void StopVoiceRecording()
    {
        try
        {
            _recognizer?.RecognizeAsyncStop();
            _recognizer?.Dispose();
            _recognizer = null;
        }
        catch { }
        finally
        {
            IsRecording = false;
        }
    }

    [RelayCommand]
    public async Task CopyMessageAsync(string? text)
    {
        if (string.IsNullOrEmpty(text)) return;
        try
        {
            if (Avalonia.Application.Current?.ApplicationLifetime is Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime desktop &&
                desktop.MainWindow?.Clipboard != null)
            {
                await desktop.MainWindow.Clipboard.SetTextAsync(text);
            }
        }
        catch { }
    }

    [RelayCommand]
    public void FeedbackUp(ChatMessageModel? msg)
    {
        // Visual acknowledgment or metric
    }

    [RelayCommand]
    public void FeedbackDown(ChatMessageModel? msg)
    {
        // Visual acknowledgment or metric
    }

    [RelayCommand]
    public void AddAttachment(string filePath)
    {
        if (File.Exists(filePath) && !AttachedFiles.Contains(filePath))
        {
            AttachedFiles.Add(filePath);
            OnPropertyChanged(nameof(HasTextToSend));
            OnPropertyChanged(nameof(ShowMicButton));
        }
    }

    [RelayCommand]
    public void RemoveAttachment(string filePath)
    {
        AttachedFiles.Remove(filePath);
        OnPropertyChanged(nameof(HasTextToSend));
        OnPropertyChanged(nameof(ShowMicButton));
    }
}
