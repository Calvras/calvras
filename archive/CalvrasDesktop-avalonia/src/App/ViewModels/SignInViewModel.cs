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
    private bool _isSignUp = true; // default to Sign Up page after fresh install

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
    private async Task GoogleSignInAsync()
    {
        IsLoading = true;
        ErrorMessage = null;
        try
        {
            await Task.Delay(200);
            var email = "user@gmail.com";
            var simulatedToken = $"calvras_goog_{Guid.NewGuid():N}";
            await _credentialService.SetSecretAsync("auth_token", simulatedToken);
            await _credentialService.SetSecretAsync("user_email", email);

            _onSignedIn(email);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Google sign in failed: {ex.Message}";
        }
        finally
        {
            IsLoading = false;
        }
    }

    [RelayCommand]
    private async Task GitHubSignInAsync()
    {
        IsLoading = true;
        ErrorMessage = null;
        try
        {
            await Task.Delay(200);
            var email = "developer@github.com";
            var simulatedToken = $"calvras_gh_{Guid.NewGuid():N}";
            await _credentialService.SetSecretAsync("auth_token", simulatedToken);
            await _credentialService.SetSecretAsync("user_email", email);

            _onSignedIn(email);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"GitHub sign in failed: {ex.Message}";
        }
        finally
        {
            IsLoading = false;
        }
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
            await Task.Delay(300);
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
