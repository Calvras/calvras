# Calvras Desktop — Native Windows & Cross-Platform Application

Calvras Desktop is a **100% native desktop application** for [Calvras](https://calvras.com) built with **Avalonia UI** and **.NET 8 (C#)**.

> **Constraint Compliance**: Strictly **NO** Electron, Tauri, NW.js, CEF, or WebView2. The entire user interface is rendered natively using Skia / DirectX / OpenGL with zero embedded web browsers.

---

## 🏗️ Architecture

```
CalvrasDesktop/
├── CalvrasDesktop.sln
├── src/
│   ├── App/          # Native Avalonia UI & MVVM Layer
│   │   ├── Assets/     # Icons and branding assets
│   │   ├── Controls/   # Reusable UI controls (TerminalViewer, FileDiff, PixelDotsLoader, Activity)
│   │   ├── ViewModels/ # Reactive ViewModels (Main, Workspace, Landing, Capabilities, Pricing, SignIn)
│   │   └── Views/      # Native AXAML Views (MainWindow, WorkspaceView, LandingView, etc.)
│   ├── Core/         # Domain Logic & Services
│   │   ├── Models/     # Strongly-typed data models (Projects, Chat, Trace, Diff, Plans)
│   │   └── Services/   # CalvrasApiClient, AgentRunner, FilesystemService, ProcessRunner, WindowsCredentialService
│   └── Data/         # Local Storage Layer
│       └── LocalDatabase.cs  # SQLite database for project history, session caching, and user settings
├── installer/        # Packaging & Inno Setup scripts
└── publish/          # Packaged binaries & releases
```

---

## ⚡ Native Desktop Features

- **Native UI Rendering**: Custom vector controls, real-time terminal output viewer with ANSI styling, unified code diff view, and animated pixel dot loader.
- **Direct Filesystem & CLI Execution**: Directly executes tools (`read_file`, `write_file`, `edit_file_chunk`, `run_command`, `list_dir`) on local workspace projects without browser sandboxing.
- **OS Credential Protection**: API keys and auth tokens are encrypted using **Windows DPAPI** (`ProtectedData`) and stored in the OS credential vault.
- **Offline / Local SQLite Cache**: Sessions, recent project workspaces, and settings persist locally in `%LocalAppData%\Calvras\calvras.db`.
- **Desktop Windowing**:
  - Resizable with strict minimum bounds (980x620).
  - Remembers window dimensions and screen coordinates across sessions.
  - Native Windows menu bar with accelerators (`Ctrl+N`, `Ctrl+O`, `Ctrl+T`, `Alt+F4`).
  - **Drag-and-Drop**: Drag a folder onto the window to open it as a workspace; drag files to attach them to prompts.
  - **System Tray Icon**: Minimizes and manages background status from the Windows taskbar tray.
  - Dark / Light Theme switching.

---

## 🚀 Getting Started

### Prerequisites
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (8.0.400+)
- Windows 10/11 x64 (or macOS / Linux)

### 1. Build the Solution
```powershell
dotnet build CalvrasDesktop.sln
```

### 2. Run the Desktop App
```powershell
dotnet run --project CalvrasDesktop/src/App/Calvras.App.csproj
```

---

## 📦 Packaging & Release (Self-Contained)

### Single-File Self-Contained Executable
Produce a standalone single-file binary that requires no pre-installed .NET runtime on the client machine:

```powershell
dotnet publish CalvrasDesktop/src/App/Calvras.App.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o CalvrasDesktop/publish/win-x64
```

The output executable is located at:
```
CalvrasDesktop/publish/win-x64/Calvras.App.exe
```

### Windows Installer (Inno Setup)
An Inno Setup script is provided at `CalvrasDesktop/installer/CalvrasSetup.iss`:
1. Download [Inno Setup 6](https://jrsoftware.org/isdl.php).
2. Run the compiler:
```powershell
iscc CalvrasDesktop/installer/CalvrasSetup.iss
```
This produces `CalvrasDesktop/installer/output/Calvras-Setup-win-x64.exe` with desktop shortcut, Start Menu entry, and uninstaller.

### Auto-Update Support
Calvras Desktop integrates **Velopack** for zero-friction background auto-updates.
```powershell
vpk pack -u Calvras -v 1.0.0 -p CalvrasDesktop/publish/win-x64 -e Calvras.App.exe
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + N` | New Project Workspace |
| `Ctrl + O` | Open Project Workspace Folder |
| `Ctrl + T` | Toggle Dark / Light Theme |
| `Enter` | Send prompt to AI Coding Agent |
| `Shift + Enter` | Insert newline in prompt editor |
| `Alt + F4` | Close / Exit Application |
