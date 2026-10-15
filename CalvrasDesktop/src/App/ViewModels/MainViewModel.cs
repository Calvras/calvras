using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Threading.Tasks;
using Calvras.Core.Models;
using Calvras.Core.Services;
using Calvras.Data;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

using Calvras.App.Services;

namespace Calvras.App.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly IFilesystemService _fs;
    private readonly ICredentialService _credentialService;
    private readonly ICalvrasApiClient _apiClient;
    private readonly LocalDatabase _db;
    private readonly IAppUpdateService _updateService;

    [ObservableProperty]
    private ViewModelBase _currentView;

    [ObservableProperty]
    private ProjectModel? _activeProject;

    public string FolderButtonText => ActiveProject != null && !string.IsNullOrWhiteSpace(ActiveProject.Name)
        ? ActiveProject.Name
        : "Upload a folder";

    partial void OnActiveProjectChanged(ProjectModel? value)
    {
        OnPropertyChanged(nameof(FolderButtonText));
    }

    [ObservableProperty]
    private ObservableCollection<ProjectModel> _recentProjects = new();

    [ObservableProperty]
    private bool _isDarkMode = true;

    [ObservableProperty]
    private bool _isSidebarOpen = false;

    [ObservableProperty]
    private string _clockTime = DateTime.Now.ToString("HH:mm:ss");

    [ObservableProperty]
    private bool _isCheckingUpdate;

    [ObservableProperty]
    private bool _hasUpdateAvailable;

    [ObservableProperty]
    private string _updateButtonText = "Check for Updates";

    [ObservableProperty]
    private string? _newVersion;

    [ObservableProperty]
    private string? _userEmail;

    [ObservableProperty]
    private string? _toastMessage;

    [ObservableProperty]
    private bool _isSettingsOpen;

    [RelayCommand]
    public void ToggleSettings()
    {
        IsSettingsOpen = !IsSettingsOpen;
    }

    [RelayCommand]
    public void CloseSettings()
    {
        IsSettingsOpen = false;
    }

    public WorkspaceViewModel WorkspaceVm { get; }
    public LandingViewModel LandingVm { get; }
    public CapabilitiesViewModel CapabilitiesVm { get; }
    public PricingViewModel PricingVm { get; }
    public SignInViewModel SignInVm { get; }
    public LocalDatabase Database => _db;
    public IAppUpdateService UpdateService => _updateService;

    public MainViewModel()
    {
        // Parameterless constructor for design-time / default instantiation
        _db = new LocalDatabase();
        _credentialService = new WindowsCredentialService();
        _apiClient = new CalvrasApiClient();
        _fs = new FilesystemService();
        var process = new ProcessRunner();
        var agent = new AgentRunner(_apiClient, _fs, process);
        _updateService = new AppUpdateService();

        WorkspaceVm = new WorkspaceViewModel(agent, _fs, _db);
        LandingVm = new LandingViewModel(() => NavigateTo("Workspace"));
        CapabilitiesVm = new CapabilitiesViewModel();
        PricingVm = new PricingViewModel(plan => ShowToast($"Selected plan: {plan}"));
        SignInVm = new SignInViewModel(_credentialService, email =>
        {
            UserEmail = email;
            ShowToast($"Signed in as {email}");
            NavigateTo("Workspace");
        });

        _currentView = WorkspaceVm;

        var timer = new Avalonia.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        timer.Tick += (_, _) => ClockTime = DateTime.Now.ToString("HH:mm:ss");
        timer.Start();

        _ = InitializeAsync();
    }

    public async Task InitializeAsync()
    {
        await _db.InitializeAsync();
        await LoadRecentProjectsAsync();

        var savedEmail = await _credentialService.GetSecretAsync("user_email");
        if (!string.IsNullOrWhiteSpace(savedEmail))
        {
            UserEmail = savedEmail;
        }
        else
        {
            // After installation taken to sign up page
            CurrentView = SignInVm;
        }

        var savedToken = await _credentialService.GetSecretAsync("auth_token");
        if (!string.IsNullOrWhiteSpace(savedToken))
        {
            _apiClient.SetAuthToken(savedToken);
        }

        // Check for updates in the background silently and every 10 minutes
        _ = CheckForUpdatesSilentlyAsync();
        var updateTimer = new Avalonia.Threading.DispatcherTimer { Interval = TimeSpan.FromMinutes(10) };
        updateTimer.Tick += async (_, _) => await CheckForUpdatesSilentlyAsync();
        updateTimer.Start();
    }

    private async Task LoadRecentProjectsAsync()
    {
        RecentProjects.Clear();
        var records = await _db.GetRecentProjectsAsync();
        foreach (var r in records)
        {
            RecentProjects.Add(new ProjectModel
            {
                Id = r["Id"].ToString()!,
                Name = r["Name"].ToString()!,
                Path = r["Path"].ToString()!,
                LastOpened = (long)r["LastOpened"],
                FileCount = Convert.ToInt32(r["FileCount"])
            });
        }
    }

    [RelayCommand]
    public void NavigateTo(string viewName)
    {
        CurrentView = viewName switch
        {
            "Workspace" => WorkspaceVm,
            "Landing" => LandingVm,
            "Capabilities" => CapabilitiesVm,
            "Pricing" => PricingVm,
            "SignIn" => SignInVm,
            _ => WorkspaceVm
        };
    }

    [RelayCommand]
    public async Task SelectProjectAsync(ProjectModel project)
    {
        ActiveProject = project;
        await WorkspaceVm.InitializeProjectAsync(project);
        await LoadRecentProjectsAsync();
        CurrentView = WorkspaceVm;
    }

    [RelayCommand]
    public async Task CreateNewProjectAsync()
    {
        var proj = await _fs.CreateProjectAsync("workspace");
        await SelectProjectAsync(proj);
    }

    [RelayCommand]
    public async Task OpenFolderAsync(string folderPath)
    {
        if (Directory.Exists(folderPath))
        {
            var cleanPath = folderPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var dirInfo = new DirectoryInfo(cleanPath);
            var name = dirInfo.Name;
            if (string.IsNullOrWhiteSpace(name)) name = Path.GetFileName(cleanPath);
            if (string.IsNullOrWhiteSpace(name)) name = "project";

            var files = await _fs.GetTreeAsync(cleanPath);
            var proj = new ProjectModel
            {
                Name = name,
                Path = cleanPath,
                LastOpened = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                FileCount = files.Count
            };

            await SelectProjectAsync(proj);
            ShowToast($"Opened {name}");
        }
    }

    [RelayCommand]
    public void ToggleSidebar()
    {
        IsSidebarOpen = !IsSidebarOpen;
    }

    [RelayCommand]
    public async Task CheckForUpdatesAsync()
    {
        if (IsCheckingUpdate) return;
        IsCheckingUpdate = true;
        UpdateButtonText = "Checking...";

        var (hasUpdate, newVer, msg) = await _updateService.CheckForUpdatesAsync();
        IsCheckingUpdate = false;

        if (hasUpdate && !string.IsNullOrWhiteSpace(newVer))
        {
            HasUpdateAvailable = true;
            NewVersion = newVer;
            UpdateButtonText = $"Install v{newVer}";
            ShowToast($"Update v{newVer} is ready to install!");
        }
        else
        {
            HasUpdateAvailable = false;
            UpdateButtonText = "Check for Updates";
            ShowToast(msg);
        }
    }

    [RelayCommand]
    public async Task ApplyUpdateAsync()
    {
        if (HasUpdateAvailable)
        {
            ShowToast("Downloading update & restarting...");
            UpdateButtonText = "Downloading...";
            var success = await _updateService.DownloadAndInstallUpdateAsync(progress =>
            {
                UpdateButtonText = $"Downloading {progress}%";
            });
            if (!success)
            {
                ShowToast("Update failed. Please retry.");
                UpdateButtonText = "Retry Update";
            }
        }
        else
        {
            await CheckForUpdatesAsync();
        }
    }

    private async Task CheckForUpdatesSilentlyAsync()
    {
        try
        {
            var (hasUpdate, newVer, _) = await _updateService.CheckForUpdatesAsync();
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                HasUpdateAvailable = hasUpdate && !string.IsNullOrWhiteSpace(newVer);
                if (HasUpdateAvailable)
                {
                    NewVersion = newVer;
                    UpdateButtonText = "Update";
                }
            });
        }
        catch { }
    }

    [RelayCommand]
    public void ToggleTheme()
    {
        IsDarkMode = !IsDarkMode;
    }

    public void ShowToast(string message)
    {
        ToastMessage = message;
        _ = Task.Run(async () =>
        {
            await Task.Delay(3500);
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                if (ToastMessage == message) ToastMessage = null;
            });
        });
    }
}
