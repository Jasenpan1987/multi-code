# CLAUDE.md

## Project Overview

Multi-Code is an Electron desktop app that manages multiple Claude Code CLI instances. It spawns real `claude` CLI processes via node-pty and renders their output in xterm.js terminals. The UI follows a classic QQ (early-2000s chat app) aesthetic.

## Architecture

- **No abstraction layers** — The app spawns the `claude` CLI directly. No SDK, no bridge, no hooks middleware.
- **Monorepo** — pnpm workspace with `workspace/app/` as the main package.
- **Electron** — Main process manages PTY lifecycle; renderer shows terminals in React.
- **Session monitoring** — Watches Claude's `.claude/sessions/` JSONL files to detect agent completion without any API integration.

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

## Code Style

- All project files (code, comments, commit messages) in English
- No unnecessary abstractions — keep it simple and direct
- Prefer editing existing files over creating new ones
- UI should stay compact and information-dense (QQ aesthetic)

## Data Storage

- Instance list persisted at `~/.config/Multi-Code/contacts.json`
- Each instance has: id, cwd (project directory), alias (display name)

## IPC Pattern

Renderer communicates with main process via Electron's contextBridge:
1. Renderer calls `window.electronAPI.someMethod()`
2. Preload bridges to `ipcRenderer.invoke("channel-name", ...args)`
3. Main process handler registered in `ipc-handlers.ts` responds
4. Events from main to renderer via `webContents.send()`
