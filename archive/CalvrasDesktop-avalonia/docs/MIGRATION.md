# Calvras Desktop — Migration Checklist

> Track every feature as it moves from the web app (`centering-chat-companion`) to the native
> Avalonia / C# / .NET 8 desktop application.  
> Tick a box by changing `[ ]` → `[x]` when the item is fully implemented, tested, and
> building without errors or warnings.

---

## Pages / Routes

- [ ] `/` (index) — main chat page (single-page app; all state lives here)
- [ ] Landing / welcome state (shown when `messages.length === 0`; logo + tagline + tagline text)
- [ ] Settings / API key management (currently inline in `gemini.ts` key helpers; needs a dedicated SettingsView)

---

## UI Components

- [ ] **CalvrasSidebar** — slide-over drawer (250 px), toggle button, backdrop, Projects section
  (collapsible, folder icon, task count badge, expand/collapse sub-tasks), Recents section
  (orphan chats only), 3-dot context menu (Rename / Delete) for both projects and chat items,
  inline rename input (Enter to commit, Escape to cancel), View Usage popover (QuotaBanner),
  user-profile footer (avatar, Free-plan badge), Search + Bell icon buttons in header.
- [ ] **ChatView** — scrollable message list (`chat-scroll-area`, `scrollbar-width: none`),
  auto-scroll on new message and while AI is streaming, `scroll-mt-8` anchors per message,
  welcome state slot, spacer div above composer, `aria-live="polite"` region.
- [ ] **UserMessageBubble** — collapses at 60 chars / multiline by default (`max-h-[100px]`
  + gradient fade), expands on click, collapses on outside click; copy-to-clipboard button
  (opacity-0 → group-hover:opacity-100, shows CheckCheck icon for 2 s after copy).
- [ ] **AttachmentPreview** — image (`<img>` with `max-h-56`), PDF with `<iframe>` embed when
  data-URL available, generic file card with coloured extension badge
  (PDF red, DOCX/DOC blue, CSV green, others grey).
- [ ] **AgentWorkflow / AgentResponseControl** — receives `phases: AgentPhase[]`,
  `tools`, `isComplete`, `workingLabel`; renders live trace while loading and final phases
  when done; exposes `CUSTOM_TOOLS` constant.
- [ ] **TraceNodeControl** — per-node rendering:
  - `reasoning` — italic sentences with animated duration
  - `tool` — icon + monospace path, optional diff rows (add/del colouring), status badge
  - `terminal` — card with command, exit-code chip, scrollable output, duration label
  - `step` — badge with primary/secondary text ("Changes applied" / agent name)
- [ ] **PlanPanel** (slide-out right drawer, max-w 520 px) — parses markdown plan into
  `## Phase N` sections, renders each as a card with phase badge (colour-cycled),
  dot-connected item list (SVG connector lines), inline `code` spans, preamble block;
  footer has "Proceed" button that auto-submits a follow-up prompt.
- [ ] **ChapterScrubber** — right-edge vertical scrubber; one dot per completed message;
  hover tooltip shows message title + description + `#N` meta; click scrolls to that message.
- [ ] **PromptInput** — multiline textarea, send on Enter (Shift+Enter for newline),
  file drag-and-drop (images, PDFs, generic), attachment preview chips before send,
  thinking/stop state toggle; placeholder `"Describe a task or /command..."`.
- [ ] **DiffViewer** — inline within TraceNodeControl `tool` nodes; renders `DiffRow[]`
  with `add` (green) / `del` (red) lines, old/new line numbers.
- [ ] **SettingsView** — API key fields for HuggingFace, Gemini, OpenRouter with show/hide
  toggle; theme toggle (dark / light); reads from / writes to Windows Credential Manager.
- [ ] **WelcomeView** — `calvras-logo.png` (h-14 w-14 rounded-xl), `h1` "What should
  Calvras build?", subtitle paragraph; shown when message list is empty.
- [ ] **ProjectBadge / Switcher** — top-right fixed badge showing active project name
  (truncated 160 px), folder icon; dropdown (Open project folder / Don't work in a project);
  locked (cursor-default) while chat has messages.
- [ ] **LiveClock** — top-center, monospace, `HH:MM:SS`, pointer-events none.
- [ ] **ImplementationPlanCard** — compact peek card below an assistant message when a plan
  exists; `max-h-[100px]` + gradient fade + "Click to expand →" hint.
- [ ] **EffortLevelSelector** — Low / Medium / Max Effort toggle that adjusts reasoning
  animation duration (1.0 s / 2.0 s / 3.5 s).
- [ ] **QuotaBanner** — popover panel showing monthly agent usage (used / limit / resets-at),
  Upgrade button, close button.

---

## API Actions (server.ts → C# FileSystemService)

All HTTP routes below are currently served by `server.ts`; in the desktop app they become
direct in-process C# method calls in `FileSystemService`.

- [ ] `create_file` — `POST /api/fs/create` — creates file + parent dirs; path-traversal guard
- [ ] `write_file` — `POST /api/fs/write-file` — overwrites file + creates parent dirs; returns line count
- [ ] `edit_file` — `POST /api/fs/edit` — surgical line-range splice (lineStart/lineEnd/newContent);
  returns `oldLines[]` + `newLines[]` for diff display
- [ ] `read_file` — `POST /api/fs/read-file` — reads UTF-8 file; returns content + line count
- [ ] `list_dir` — `POST /api/fs/list-dir` — lists entries (name, type `file`/`dir`, size);
  skips dotfiles, `node_modules`, `dist`, `.output`
- [ ] `run_command` — `POST /api/fs/command` — `child_process.execSync` with 60 s timeout,
  4 MB output buffer, cwd = projectPath; returns ok, output, exitCode
- [ ] `create-project` — `POST /api/fs/create-project` — `mkdir` on Desktop, sanitises name
  to `[a-zA-Z0-9_-]`, max 50 chars
- [ ] `delete_project` — `POST /api/fs/delete-project` — `rm -rf` with Desktop-only guard;
  approval prompt before executing in desktop app
- [ ] `tree` — `GET /api/fs/tree` — recursive walk (max 60 files), skips hidden/node_modules/dist;
  returns numbered content samples (first 120 lines each) for AI context
- [ ] Path-traversal guard (`safeProjectPath`) — `path.resolve` then prefix-check against
  project root; must be ported to C# `Path.GetFullPath` equivalent

---

## AI Cascade Engines (server.ts `callInferenceCascade` → C# `AiCascadeService`)

- [ ] **Engine 1 — HuggingFace Router** `SHIKARI2/Malvos-32B-Merged` via
  `https://router.huggingface.co/hf-inference/v1/chat/completions`; 8 s timeout;
  uses `HF_TOKEN` / `HUGGINGFACE_API_KEY`
- [ ] **Engine 2a — HF Serverless fallback** `Qwen/Qwen2.5-Coder-32B-Instruct`; 8 s timeout
- [ ] **Engine 2b — HF Serverless fallback** `meta-llama/Llama-3.3-70B-Instruct`; 8 s timeout
- [ ] **Engine 2c — HF Serverless fallback** `mistralai/Mistral-7B-Instruct-v0.3`; 8 s timeout
- [ ] **Engine 3 — Gemini Native API** (tried in order, 12 s each per model):
  `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-flash-latest`,
  `gemini-3-flash-preview`, `gemini-2.5-flash`
  — endpoint `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  — sends `systemInstruction`, `generationConfig` (`temperature`, `maxOutputTokens`,
    `responseMimeType: "application/json"`)
- [ ] **Engine 4 — OpenRouter Free Pool** (tried in order, 12 s each):
  `openrouter/free`, `nvidia/nemotron-3-super-120b-a12b:free`,
  `nvidia/nemotron-3-ultra-550b-a55b:free`, `cohere/north-mini-code:free`,
  `liquid/lfm-2.5-2.6b:free`, `apodex/apodex-1.1-mini:free`
  — endpoint `https://openrouter.ai/api/v1/chat/completions`
  — headers: `HTTP-Referer: https://calvras.app`, `X-Title: Calvras AI`
- [ ] **Engine 5 — Emergency Direct Gemini** `gemini-3.5-flash`, 12 s; extracts last user
  message only; used when all other engines fail
- [ ] **Offline fallback JSON** — when all 5 engines fail, return a valid Calvras JSON payload
  with an error message (no exception thrown to caller)
- [ ] **Image/vision routing** — when `mediaAttachments` present, skip HF engines and go
  directly to Gemini (Engine 3), then OpenRouter (Engine 4); `inlineData` base64 format
- [ ] **Streaming SSE** — `POST /api/v1/chat/completions` with `stream: true` emits
  `data: {chunk}\n\n` + `data: [DONE]\n\n`; desktop app uses `HttpClient` chunked reads
- [ ] **System-prompt injection** — if messages[0] is not `system`, prepend `CALVRAS_SYSTEM_PROMPT`;
  if it is `system` but doesn't contain "Calvras", prefix it
- [ ] **`requestedModel` passthrough** — caller may specify a model string; used for Engine 1

---

## System Prompt Rules

- [ ] Output raw JSON only — no markdown fences (```` ``` ````)
- [ ] Required fields: `thought` (string), `reasoning[]` (string array), `actions[]`, `message` (string)
- [ ] Optional field: `plan` (markdown string; only for large multi-file tasks)
- [ ] Action types: `create_file`, `write_file`, `edit_file`, `read_file`, `list_dir`, `run_command`
- [ ] Agent loop: max **8 iterations** (`MAX_AGENT_STEPS = 8`)
- [ ] Reasoning style: natural human speech — "Hmm…", "Uhm…", "Oh wait —", "Actually…",
  "Right so…"; self-corrections encouraged; 2–4 sentences
- [ ] Conversational mode: if user sends greeting/vague message, respond conversationally
  (1–2 sentences) without jumping to code
- [ ] Never reveal underlying AI providers — agent identity is "Calvras"
- [ ] `systemPrefix` injected on every message: includes `[CURRENT TIME]` in
  `en-US` locale long format
- [ ] `edit_file` action fields: `path`, `lineStart`, `lineEnd`, `newContent`
- [ ] `run_command` action field: `command`
- [ ] `create_file` / `write_file` action fields: `path`, `content`
- [ ] `read_file` / `list_dir` action field: `path`

---

## Key Management

- [ ] **HuggingFace key** — env `HUGGINGFACE_API_KEY` → `HF_TOKEN` → embedded base64 fragments
  (`aGZf…`) decoded at runtime
- [ ] **Gemini key** — env `VITE_GEMINI_API_KEY` → `GEMINI_API_KEY` → embedded base64 fragments
  (`QVEuQWI4Uk42S2…`) decoded at runtime; also stored in `localStorage("user_gemini_api_key")`
  on the client side
- [ ] **OpenRouter key** — env `VITE_OPENROUTER_API_KEY` → `OPENROUTER_API_KEY` → embedded
  base64 fragments (`c2stb3ItdjEt…`) decoded at runtime; also stored in
  `localStorage("user_openrouter_api_key")`
- [ ] **Desktop: all three keys stored in Windows Credential Manager** (`PasswordVault`)
  — target names: `Calvras/HuggingFace`, `Calvras/Gemini`, `Calvras/OpenRouter`
- [ ] **Desktop: fall back to embedded base64 keys** if not found in Credential Manager
- [ ] `setGeminiKey(key)` / `setOpenRouterKey(key)` runtime overrides (globalThis slots in web;
  in-memory singletons in desktop)

---

## Data Persistence (localStorage → SQLite)

All `localStorage` keys below map to SQLite tables at `%APPDATA%\Calvras\calvras.db`.

| localStorage key | SQLite table / column |
|---|---|
| `calvras_chat_messages` | `messages` table |
| `calvras_active_plan` | `messages.trace_json` or `sessions` metadata |
| `calvras_projects` | `projects` table |
| `calvras_recents` | `messages` / `sessions` join |
| `calvras_active_project` | `settings` key `active_project` |
| `user_gemini_api_key` | Windows Credential Manager (not DB) |
| `user_openrouter_api_key` | Windows Credential Manager (not DB) |

- [ ] **`sessions` table** — `id TEXT PK`, `title TEXT`, `created_at INTEGER`, `updated_at INTEGER`
- [ ] **`messages` table** — `id TEXT PK`, `session_id TEXT FK`, `role TEXT` (`user`/`assistant`),
  `text TEXT`, `trace_json TEXT` (serialised `AgentPhase[]`), `is_done INTEGER`, `created_at INTEGER`
- [ ] **`projects` table** — `id TEXT PK`, `name TEXT`, `path TEXT UNIQUE`, `last_opened INTEGER`
- [ ] **`settings` table** — `key TEXT PK`, `value TEXT`
- [ ] **DB location** — `%APPDATA%\Calvras\calvras.db`
- [ ] Attachment data-URLs stripped before persistence (only metadata stored — name, type, no blob)
- [ ] Max 30 recent chats per project (enforced at insert time)

---

## Desktop-Native Features

- [ ] Resizable window — minimum **900 × 600**, default **1280 × 800**
- [ ] Remember window size and position across sessions (stored in `settings` table)
- [ ] System tray icon — right-click menu: Open, New Chat, Quit
- [ ] Keyboard shortcuts:
  - `Ctrl+N` — new chat
  - `Ctrl+,` — open Settings
  - `Escape` — stop current AI call / close open panel
  - `Shift+Enter` — insert newline in PromptInput
- [ ] Native menus — File (New Chat, Open Project, Quit), Edit (Copy, Paste), View (Theme,
  Toggle Sidebar), Help (About, Check for Updates)
- [ ] Drag-and-drop files onto the chat input (images, PDFs, generic)
- [ ] Native file / folder open dialogs (`StorageProvider` in Avalonia)
- [ ] OS toast notifications (task completed, build error, update available)
- [ ] Dark / light theme — follows OS accent by default, manually overridable; persisted in `settings`
- [ ] Auto-update — **Velopack** (`VelopackApp.Build().Run()` in Program.cs); delta updates;
  checks on launch and shows non-intrusive update badge

---

## Packaging

- [ ] Single-file self-contained exe (win-x64):
  ```
  dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
  ```
- [ ] Inno Setup installer (`.iss` script) — app icon, Start Menu shortcut, Desktop shortcut
  (optional), uninstaller entry in Add/Remove Programs
- [ ] `README.md` — build instructions, run instructions, release / packaging instructions,
  environment variable reference

---

## Progress Summary

> Update this table as stages complete.

| Stage | Status | Notes |
|---|---|---|
| 1 — Audit & MIGRATION.md | ✅ Done | This file |
| 2 — Core (FS tools, AI client, agent loop) | ⬜ Not started | |
| 3 — Avalonia shell (window, sidebar, chat, streaming) | ⬜ Not started | |
| 4 — Agent trace viewer, diff, editor, terminal | ⬜ Not started | |
| 5 — Sessions (SQLite), settings, tray, shortcuts, auto-update | ⬜ Not started | |
| 6 — Package (single-file exe + Inno Setup + README) | ⬜ Not started | |
