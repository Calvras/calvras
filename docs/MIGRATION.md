# Calvras Desktop Migration Inventory & Progress Tracker

> **UI Framework Decision**: Selected **Avalonia (C# / .NET 8)** because it provides direct native GPU-accelerated rendering on Windows, macOS, and Linux without any web wrappers, integrates cleanly with `CommunityToolkit.Mvvm`, and provides native OS credential store and shell integration.

---

## 1. Web Codebase Audit & Feature Inventory

### 1.1 Pages & Routes
- [x] **Home / Autonomous Agent Workspace** (`/`)
  - [x] Multi-turn chat message timeline with user bubbles & agent activity
  - [x] Real-time `AgentActivity` trace viewer (`ThinkingState`, `TracePillRow`, `NestedReasoningBlock`)
  - [x] Interactive `TerminalCommand` output viewer ($ command, status, exit code, execution time, stdout copy)
  - [x] Embedded `FileDiff` viewer (line gutters, +add/-del counters, inline additions/deletions)
  - [x] Floating chat prompt input with file attachments, multi-line editor, submit/stop controls
  - [x] Quick-starter action prompts ("Build a React app", "Audit security", etc.)
  - [x] Response feedback & status indicators
- [x] **Landing Page** (`/landing`)
  - [x] Hero banner with dynamic call-to-actions ("Launch Native Workspace")
  - [x] Capabilities & tech badges marquee
  - [x] Features grid & architecture showcase
  - [x] Feature overview cards (Autonomous Coding, Surgical File Diff, Native Terminal, OS Credential Vault)
- [x] **Capabilities Page** (`/capabilities`)
  - [x] Tool demos (Autonomous Task Engine, Safe Terminal Runner, File Diff Engine, Fast SQLite Cache)
  - [x] Core advantages & architecture benchmarks
- [x] **Pricing Page** (`/pricing`)
  - [x] Plan tiers: Starter, Pro, Enterprise
  - [x] Monthly / Yearly billing toggle with 20% discount badge
  - [x] Full feature comparison matrix
  - [x] Plan selection CTA triggers
- [x] **Sign In / Auth Page** (`/signin`)
  - [x] Modern tabbed layout (Sign In vs Sign Up)
  - [x] Email & password input with validation
  - [x] Social auth provider buttons (Google / GitHub)
  - [x] Token storage in OS Credential Store (Windows DPAPI)

### 1.2 Layout & Global Components
- [x] **Calvras Sidebar / Navigation Bar**
  - [x] Workspace project switcher & folder selector
  - [x] Recent projects list with open actions
  - [x] New project creator dialog
  - [x] Navigation links: Workspace, Landing, Capabilities, Pricing, Account/Sign In
  - [x] Dark/Light theme toggle
- [x] **Project Management & Local Filesystem Bridge**
  - [x] Native folder picker dialog (`StorageProvider.OpenFolderPickerAsync`)
  - [x] Local directory inspection
  - [x] File creation, write, surgical edit, and deletion
  - [x] Native terminal process execution with captured stdout/stderr

### 1.3 Backend & API Endpoints
- [x] `POST /api/v1/chat/completions` (OpenAI-compatible AI agent inference)
- [x] Local filesystem operations (`read_file`, `write_file`, `edit_file_chunk`, `list_dir`)
- [x] Direct native shell process execution (`run_command`) with exit code, stdout/stderr, and duration tracking
- [x] `CalvrasApiClient` connecting to `https://calvras.com` & fallback endpoint

### 1.4 Data Models & State Contracts
- [x] `AgentPhase`: `trace: TraceNode[]`, `message?: string`
- [x] `TraceNode`: `id, type, toolName, primary, secondary, status, command, output, exitCode, durationMs, diffRows...`
- [x] `DiffRow`: `old?: int, cur?: int, type: ("add"|"del"|"ctx"), text: string`
- [x] `ChatMessageModel`: `id, role, text, phases, done, status, error, startedAt, endedAt, attachments`
- [x] `ProjectModel`: `id, name, path, lastOpened, fileCount`
- [x] `AppSettings`: Theme, WindowBounds (Width, Height, X, Y), UserEmail

---

## 2. Desktop Architecture

- [x] **Calvras.Core**:
  - [x] `Models/AppModels.cs`: Strongly-typed records for Chat, AgentTraces, Projects, API Contracts
  - [x] `Services/`:
    - [x] `ICalvrasApiClient`: Talks to `https://calvras.com`
    - [x] `IAgentRunner`: Local autonomous execution loop with real tool dispatch
    - [x] `IProcessRunner`: Native process execution (PowerShell / cmd / bash) with timeout & streaming output
    - [x] `IFilesystemService`: Local disk file read/write/edit/tree operations
    - [x] `ICredentialService`: Windows DPAPI (`ProtectedData`) credential vault
- [x] **Calvras.Data**:
  - [x] SQLite database via `Microsoft.Data.Sqlite` for local chat history, recent projects, offline caches, settings
- [x] **Calvras.App**:
  - [x] MVVM via `CommunityToolkit.Mvvm`
  - [x] Native views: `MainWindow`, `WorkspaceView`, `LandingView`, `CapabilitiesView`, `PricingView`, `SignInView`
  - [x] Native controls: `AgentActivityControl`, `TerminalViewerControl`, `FileDiffControl`, `PixelDotsLoaderControl`
  - [x] Desktop features:
    - [x] Native menu bar (File, View, Help)
    - [x] System tray icon with context menu
    - [x] Keyboard shortcuts (`Ctrl+N`, `Ctrl+O`, `Ctrl+T`, `Alt+F4`)
    - [x] File and folder drag-and-drop
    - [x] Window dimensions & position persistence in SQLite
    - [x] Dark / Light theme switching
    - [x] Toast notification system

---

## 3. Build & Packaging

- [x] Compile all .NET 8 projects (`Calvras.Core`, `Calvras.Data`, `Calvras.App`) with 0 errors
- [x] Self-contained single-file publish (`win-x64`)
  - Target: `CalvrasDesktop/publish/win-x64/Calvras.App.exe` (79.5MB standalone binary)
- [x] Windows installer:
  - [x] Velopack setup installer (`Calvras-win-Setup.exe`)
  - [x] Inno Setup script (`CalvrasDesktop/installer/CalvrasSetup.iss`)
- [x] Documentation & Release Guides:
  - [x] `CalvrasDesktop/README.md`
  - [x] `docs/MIGRATION.md`
