using System;
using System.Threading.Tasks;
using Calvras.Core.Services;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Calvras.App.ViewModels;

public partial class SignInViewModel : ViewModelBase
{
    private readonly ICredentialService _credentialService;
    private readonly Action<string> _onSignedIn;

    [ObservableProperty]
    private string _email = string.Empty;

    [ObservableProperty]
    private string _password = string.Empty;

    [ObservableProperty]
    private bool _isSignUp = false;

    [ObservableProperty]
    private string? _errorMessage;

    [ObservableProperty]
    private bool _isLoading = false;

    public SignInViewModel(ICredentialService credentialService, Action<string> onSignedIn)
    {
        _credentialService = credentialService;
        _onSignedIn = onSignedIn;
    }

    [RelayCommand]
    private void ToggleMode()
    {
        IsSignUp = !IsSignUp;
        ErrorMessage = null;
    }

    [RelayCommand]
    private async Task SubmitAsync()
    {
        if (string.IsNullOrWhiteSpace(Email) || string.IsNullOrWhiteSpace(Password))
        {
            ErrorMessage = "Please enter both email and password.";
            return;
        }

        IsLoading = true;
        ErrorMessage = null;

        try
        {
            // Simulate / authenticate and store token securely in OS vault
            await Task.Delay(400); // smooth async feel
            var simulatedToken = $"calvras_tk_{Guid.NewGuid():N}";
            await _credentialService.SetSecretAsync("auth_token", simulatedToken);
            await _credentialService.SetSecretAsync("user_email", Email);

            _onSignedIn(Email);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Authentication failed: {ex.Message}";
        }
        finally
        {
            IsLoading = false;
        }
    }
}
