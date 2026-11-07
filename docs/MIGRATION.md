# Calvras — Migration Guide

## Current: Electron + TanStack Start Web App (v1.0 → present)

Calvras is now an **Electron desktop application** wrapping the original TanStack Start web application.

### Architecture

```
Calvras/
├── electron/
│   ├── main.js        — Electron main process (spawns Nitro, frameless window, IPC)
│   └── preload.js     — contextBridge: window controls, safeStorage, folder picker
├── src/               — TanStack Start / React 19 / Vite web app
│   ├── routes/        — Pages (/, /app, /signin, marketing pages)
│   ├── lib/
│   │   ├── gemini.ts        — Multi-engine AI cascade (Gemini / OpenRouter / HF)
│   │   ├── system-prompt.ts — Calvras agent system prompt (identity, voice, loop)
│   │   ├── agent-run.ts     — Agent execution loop with tool routing
│   │   └── project-context.tsx
│   ├── components/
│   │   ├── AgentActivity.tsx         — Trace viewer for agent actions
│   │   └── ui/
│   │       ├── ai-chat-input.tsx     — Expanding chat composer with voice/attachments
│   │       └── ai-agent-response.tsx — Trace pill rows, terminal viewer, diffs
│   └── server.ts      — Nitro SSR entry: /api/fs/* routes, agent cascade
├── installer/
│   ├── CalvrasSetup.iss   — Inno Setup installer script
│   ├── calvras-logo.ico   — App icon
│   ├── wizard_sidebar.bmp — Dark installer sidebar art
│   └── wizard_small.bmp   — Corner wizard image
└── archive/
    └── CalvrasDesktop-avalonia/   — Archived Avalonia/.NET native app (not used)
```

### Runtime

1. Electron main process finds a free port (default 3344).
2. Spawns `.output/server/index.mjs` (Nitro node-server preset) as a child process.
3. Polls `http://127.0.0.1:<port>` until it responds.
4. Shows a splash screen during boot, then opens a frameless `BrowserWindow`.
5. All `/api/fs/*` and AI cascade calls hit `127.0.0.1:<port>` — never the public internet (except AI inference APIs called directly from the renderer).

### Dev workflow

```bash
npm run dev             # Web-only hot reload (vite dev)
npm run build:electron  # Production build with NITRO_PRESET=node-server
npm run electron:dev    # build:electron + electron .
npm run electron:dist   # build:electron + electron-builder (produces installer + zip)
```

### Packaging

- **electron-builder** produces `electron-dist/win-unpacked/Calvras.exe` (and a zip).
- **Inno Setup** (`installer/CalvrasSetup.iss`) packages that folder into `dist/installer/Calvras-Setup-win-x64.exe`.
  `npm run installer:build` instead packs into `electron-dist/payload-<stamp>/win-unpacked` and passes it as
  `/DAppPayload`, because an editor that has the previous `app.asar` mapped blocks electron-builder from
  replacing it in place.

---

## Previous: Avalonia/.NET Native (archived)

The `archive/CalvrasDesktop-avalonia/` directory contains the Avalonia-based native Windows app.
It was archived (not deleted) on 2026-10-15. The Electron approach was chosen for better cross-platform support and easier web-component reuse.
