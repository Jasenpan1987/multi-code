# CLAUDE.md

## Project Overview

Multi-Code is an Electron desktop app that manages multiple Claude Code CLI instances. It spawns real `claude` CLI processes via node-pty and renders their output in xterm.js terminals. The UI is compact and information-dense: a sidebar of sessions, a terminal, and a toolbox.

## Architecture

- **No abstraction layers** — The app spawns the `claude` CLI directly. No SDK, no bridge, no hooks middleware.
- **Report-only hooks and plugins are allowed** — Passed from `userData` to the processes Multi-Code spawns (Claude: `--settings`; OpenCode: a TUI plugin named in `OPENCODE_CLI_CONFIG_CONTENT`), never written to the user's own config. They report state and never block or change a call, so plain `claude` or `opencode` outside Multi-Code is unaffected. One exception (decisions.md, 2026-10-16): OpenCode dialogs answered from the phone or the secretary go through OpenCode's own API, by request id, as the builder would answer by keypress.
- **OpenCode 2 only** — OpenCode runs every session in one shared background service per user; Multi-Code's terminals attach to it as VS Code's do (`opencode --session <id>`; tabs as the user's own settings say). Multi-Code puts nothing into that service, starts it only when none is running (with the builder's login-shell environment), and never restarts or stops it. 1.x is refused with the upgrade command. Epic `opencode-v2` (`docs/specs/opencode-v2/prd.md`).
- **Phone link over the tailnet only** — The phone app and its socket are served to the tailnet only through `tailscale serve` (HTTPS at the Mac's tailnet name); the port binds to 127.0.0.1. Multi-Code runs `tailscale serve` only when the builder presses "Set up HTTPS", never over another 443 config, and never removes it. Push goes from the Mac straight to Apple's Web Push service, no relay. Epic `mobile-v2` (`docs/specs/mobile-v2/prd.md`).
- **Monorepo** — pnpm workspace with `workspace/app/` as the main package.
- **Electron** — Main process manages PTY lifecycle; renderer shows terminals in React.
- **Session monitoring** — Claude instances report finished / needs-you through report-only hooks (`--settings <userData>/alert-settings.json`) posting to the local `/alert` endpoint; `backends/claudeHooks.ts` turns them into activity. OpenCode instances' state comes from the shared service's event stream (`backends/opencodeService.ts`), and the session each terminal shows from Multi-Code's TUI plugin (`backends/opencodePlugin.ts`, posting to `/alert`); `backends/opencodeAttention.ts` turns both into activity. Epics `attention-alerts` and `opencode-v2`. The session JSONL and OpenCode 2's database (`session_v2`, `session_message`, read-only) are still read for transcripts and context usage, never for state.

## Key Paths

- `workspace/app/src/main/` — Electron main process (process-manager, session-watcher, IPC, store)
- `workspace/app/src/renderer/` — React UI (App.tsx, components/, hooks/, audio/, styles/)
- `workspace/app/src/shared/types.ts` — Shared TypeScript interfaces
- `workspace/app/src/shared/remote-protocol.ts` — Phone link wire protocol (v3), the phone ↔ desktop contract
- `workspace/app/src/renderer-mobile/` — The phone web app (served to the iPhone, built by `rspack.mobile.config.ts`)
- `workspace/app/scripts/mobile-harness/` — Phone dev harness: the real server with scripted sessions, Playwright WebKit screenshots at iPhone size (`pnpm harness`, `pnpm harness:shot`)
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
4. Bring `README.md` and `README.zh-CN.md` up to date with what the release changes.
5. Build the installer with `pnpm dist` in `workspace/app`: it writes
   `release/Multi-Code-X.Y.Z-arm64.dmg` (and its `.blockmap`). Then delete the
   intermediate `release/mac-arm64/` folder. Never ship `pnpm run pack`'s output: it
   is only the `.app` (`--dir`), for testing the Dock badge.
6. `git push origin master`.

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
  alias (display name), backend, sessionId (the session its next start resumes, so
  two contacts on one project stay apart)
- `settings.json` — theme, phone-link enabled, Secretary Mode, speech server address,
  each project's default drop folder
- `remote-identity.json`, `remote-devices.json` — phone-link keys and paired devices (each
  with its token, its Web Push subscription and its last push error); 0600
- `remote-push.json` — the VAPID keypair; its public half goes to each phone in `auth-ok`;
  0600; generated once and kept (a missing or corrupt file gets a new pair); never logged,
  never sent to the renderer. Losing it drops every phone's subscription; each re-subscribes
  on its next launch
- `manager-mcp.json` — the manager's `--mcp-config`, written 0600 because it carries
  a bearer token; removed on shutdown
- `manager-settings.json`, `manager-hook.curl` — the manager's `--settings` (its
  activity hooks plus the alert hooks, one file because the CLI honours only the last
  `--settings`) and the curl config holding the `/hook` token; 0600, removed on shutdown
- `alert-settings.json`, `alert-hook.curl` — every other Claude instance's
  `--settings` (alert hooks only) and the curl config holding the `/alert` token; 0600,
  removed on shutdown
- `opencode/tui/tui.js`, `opencode/alert.json` — the report-only TUI plugin every
  OpenCode terminal Multi-Code starts loads (named in its `OPENCODE_CLI_CONFIG_CONTENT`)
  and the `/alert` endpoint and token it reads (path in `MULTICODE_ALERT_FILE`); 0600,
  removed on shutdown
- `speech-key` — the secretary's speech-server bearer key, alone in its file at 0600;
  never in `settings.json`, never logged, never sent to the renderer (it learns only
  whether one is set); kept across runs

## IPC Pattern

Renderer communicates with main process via Electron's contextBridge:
1. Renderer calls `window.electronAPI.someMethod()`
2. Preload bridges to `ipcRenderer.invoke("channel-name", ...args)`
3. Main process handler registered in `ipc-handlers.ts` responds
4. Events from main to renderer via `webContents.send()`
