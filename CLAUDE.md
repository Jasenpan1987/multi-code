# CLAUDE.md

## Project Overview

Multi-Code is an Electron desktop app that manages multiple Claude Code CLI instances. It spawns real `claude` CLI processes via node-pty and renders their output in xterm.js terminals. The UI is compact and information-dense: a sidebar of sessions, a terminal, and a toolbox.

## Architecture

- **No abstraction layers** — The app spawns the `claude` CLI directly. No SDK, no bridge, no hooks middleware.
- **Report-only hooks and plugins are allowed** — Passed from `userData` to the processes Multi-Code spawns (Claude: `--settings`; OpenCode: a plugin named in `OPENCODE_CONFIG_CONTENT`), never written to the user's own config. They report state and never block or change a call, so plain `claude` or `opencode` outside Multi-Code is unaffected.
- **Monorepo** — pnpm workspace with `workspace/app/` as the main package.
- **Electron** — Main process manages PTY lifecycle; renderer shows terminals in React.
- **Session monitoring** — Claude instances report finished / needs-you through report-only hooks (`--settings <userData>/alert-settings.json`) posting to the local `/alert` endpoint; `backends/claudeHooks.ts` turns them into activity. OpenCode instances do the same through Multi-Code's plugin (`backends/opencodePlugin.ts`), turned into activity by `backends/opencodeAttention.ts`. Epic `attention-alerts` (`docs/specs/attention-alerts/prd.md`). The session JSONL and OpenCode's database are still read for transcripts and context usage, never for state.

## Key Paths

- `workspace/app/src/main/` — Electron main process (process-manager, session-watcher, IPC, store)
- `workspace/app/src/renderer/` — React UI (App.tsx, components/, hooks/, audio/, styles/)
- `workspace/app/src/shared/types.ts` — Shared TypeScript interfaces
- `docs/` — Business docs, specs, PRD, kanban

## Tech Stack & Conventions

- **TypeScript** strict mode, target ES2024, ESM (`"type": "module"`)
- **React 19** for renderer
- **xterm.js** + FitAddon for terminal rendering
- **node-pty** for process spawning
- **rspack** for bundling the renderer
- **oxlint + eslint** for linting
- **vitest** for testing
- **pnpm** as package manager

## Common Commands

```bash
pnpm install          # Install dependencies
pnpm start            # Build + launch Electron app
pnpm build            # Build renderer (rspack) + main (tsc)
pnpm lint             # oxlint && eslint --cache
pnpm lint:fix         # Auto-fix lint issues
pnpm type             # Type-check (tsc --noEmit)
pnpm test             # Run vitest
```

## Release Process

When building to **release/ship** a version (not a routine dev build):

1. Run `pnpm build` and confirm it succeeds.
2. Bump the version in `workspace/app/package.json` (the only place a version
   lives — the root package.json is private and has none). Ask which part to
   bump (patch/minor/major); default suggestion is **patch**.
3. Commit the bump on its own (e.g. `chore: bump version to X.Y.Z`).

Routine dev builds during development do NOT bump the version — only do this in
a release context so the number isn't pushed on every build.

## Code Style

- All project files (code, comments, commit messages) in English
- No unnecessary abstractions — keep it simple and direct
- Prefer editing existing files over creating new ones
- UI should stay compact and information-dense

## Data Storage

Everything persisted lives in Electron's `app.getPath("userData")`, which on macOS
is `~/Library/Application Support/multi-code/` for a dev build, and `…/Multi-Code/`
(the `productName`) for the installed app. macOS's default filesystem is
case-insensitive, so those are the same folder (observed 2026-10-07): running both at
once, they read the same contacts and overwrite each other's spawn files. Never hardcode these paths; call `app.getPath("userData")`.

- `contacts.json` — the instance list. Each entry: id, cwd (project directory),
  alias (display name), backend
- `settings.json` — theme, phone-link enabled
- `remote-identity.json`, `remote-devices.json` — phone-link keys and paired devices
- `manager-mcp.json` — the manager's `--mcp-config`, written 0600 because it carries
  a bearer token; removed on shutdown
- `manager-settings.json`, `manager-hook.curl` — the manager's `--settings` (its
  activity hooks plus the alert hooks, one file because the CLI honours only the last
  `--settings`) and the curl config holding the `/hook` token; 0600, removed on shutdown
- `alert-settings.json`, `alert-hook.curl` — every other Claude instance's
  `--settings` (alert hooks only) and the curl config holding the `/alert` token; 0600,
  removed on shutdown
- `opencode/multicode-plugin.js`, `opencode/alert.json` — the report-only plugin every
  OpenCode instance loads (named in its `OPENCODE_CONFIG_CONTENT`) and the `/alert`
  endpoint and token it reads (path in `MULTICODE_ALERT_FILE`); 0600, removed on shutdown

## IPC Pattern

Renderer communicates with main process via Electron's contextBridge:
1. Renderer calls `window.electronAPI.someMethod()`
2. Preload bridges to `ipcRenderer.invoke("channel-name", ...args)`
3. Main process handler registered in `ipc-handlers.ts` responds
4. Events from main to renderer via `webContents.send()`
