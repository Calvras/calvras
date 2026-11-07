# Calvras

An autonomous AI coding agent that runs as a desktop application. Open a project folder, describe what you want to build or fix, and Calvras reads your files, writes code, runs commands, and iterates until it's done.

## What it does

- Reads, writes, creates, and edits files in your project folder
- Runs shell commands (npm, git, dotnet, pip, etc.) and returns real output
- Streams AI responses token by token with tool-call trace pills
- Supports image and PDF attachments in the chat input
- Voice input via Web Speech API (Chrome/Edge)
- Persists conversation across sessions via localStorage
- Works entirely locally — only AI inference calls go to the cloud

## Tech stack

- **Electron** (frameless window, system tray, single-instance, safeStorage)
- **TanStack Start** (React 19, Vite, file-based routing, SSR)
- **Nitro** server (node-server preset, all `/api/fs/*` routes)
- **Tailwind CSS v4** + **Radix UI** + **Framer Motion**
- **Gemini / OpenRouter / Hugging Face** AI cascade

## Dev setup

```bash
git clone https://github.com/SHIKARI-hey/Calvras.git
cd Calvras
npm install

# Web-only dev (Vite hot reload, no Electron)
npm run dev

# Electron dev (builds Nitro node-server, then opens Electron)
npm run electron:dev
```

## Build & package

```bash
# 1. Build Nitro in node-server mode + Vite frontend
npm run build:electron

# 2. Package as installer + zip (win-x64)
npm run electron:dist
# → electron-dist/Calvras-Setup-1.0.0.exe
# → electron-dist/Calvras-1.0.0-win.zip

# 3. (Optional) Build Inno Setup installer manually
# Requires Inno Setup 6 installed
ISCC installer\CalvrasSetup.iss
# → dist/installer/Calvras-Setup-win-x64.exe
```

## Project structure

```
electron/       Electron main + preload
src/
  routes/       Web pages (/, /app, /signin, marketing)
  lib/          AI cascade, agent loop, system prompt, project context
  components/   Chat UI, agent trace, Markdown renderer
  server.ts     Nitro SSR entry + /api/fs/* filesystem API
installer/      Inno Setup script + wizard images + app icon
docs/           MIGRATION.md
archive/        Archived Avalonia/.NET native app (not used)
```

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- Renderer only calls `http://127.0.0.1:<port>` — all Node runs in main process
- Path sandboxing: `/api/fs/*` routes resolve paths inside the project folder only
- API keys stored via Electron `safeStorage` (OS credential store)
- External links open in OS default browser, never in the BrowserWindow
