# Multi-Code

A desktop application for managing multiple Claude Code CLI instances from a single interface. Think of it as a terminal multiplexer with a classic QQ (early-2000s chat app) aesthetic — each Claude Code session appears as a "contact" in a sidebar, with full terminal fidelity and notification support.

## Why

When working with multiple Claude Code sessions across different projects simultaneously, you run into context contamination and missed notifications. Multi-Code solves this by giving each session its own isolated terminal view while providing unified notification management.

## Features

- **Instance Management** — Spawn, restart, and remove Claude Code sessions per project directory
- **Full Terminal Fidelity** — Real PTY via node-pty, rendered in xterm.js. No chat abstraction, no message parsing
- **Session Notifications** — Monitors Claude's session JSONL files; plays audio and shows badge when an agent finishes responding in a background tab
- **Persistence** — Instance list saved to disk, survives app restart
- **QQ Aesthetic** — Compact, information-dense UI with color-coded avatars and familiar sidebar layout

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 35 |
| Language | TypeScript (strict, ES2024, ESM) |
| Frontend | React 19 |
| Terminal | xterm.js 5.5 + FitAddon |
| PTY | node-pty 1.0 |
| Bundler | rspack 1.3 |
| Lint | oxlint + eslint |
| Test | vitest |
| Package Manager | pnpm (workspace monorepo) |

## Project Structure

```
multi-code/
├── workspace/
│   └── app/
│       ├── src/
│       │   ├── main/           # Electron main process
│       │   │   ├── index.ts          # Entry point, window creation
│       │   │   ├── process-manager.ts # Spawns & manages claude CLI processes
│       │   │   ├── session-watcher.ts # Monitors session JSONL for activity
│       │   │   ├── ipc-handlers.ts    # IPC endpoint registration
│       │   │   ├── preload.ts         # Context bridge (electronAPI)
│       │   │   └── store.ts           # Persistent storage (~/.config/Multi-Code/)
│       │   ├── renderer/       # React UI
│       │   │   ├── App.tsx
│       │   │   ├── components/       # ContactList, TerminalView, Avatar, etc.
│       │   │   ├── hooks/            # useNotifications
│       │   │   ├── audio/            # Web Audio notification sounds
│       │   │   └── styles/           # Global CSS (QQ theme)
│       │   └── shared/         # Shared TypeScript types
│       ├── package.json
│       └── rspack.renderer.config.ts
├── docs/                       # Business docs, specs, knowledge base
├── package.json                # Root workspace config
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Claude Code CLI installed and available in PATH (`claude`)

### Install & Run

```bash
pnpm install
pnpm start
```

### Scripts

```bash
pnpm start        # Build and launch the app
pnpm build        # Build renderer + main process
pnpm lint         # Run oxlint + eslint
pnpm lint:fix     # Auto-fix lint issues
pnpm type         # Type check without emit
pnpm test         # Run vitest
pnpm pack         # Package app (directory output)
pnpm dist         # Build distributable (dmg on macOS)
```

## How It Works

1. User creates an instance by selecting a project directory
2. App spawns `claude --continue` via node-pty in that directory
3. PTY stdout is piped in real-time to an xterm.js terminal in the renderer
4. SessionWatcher polls the Claude session JSONL file for agent completion events
5. On completion, plays audio notification and shows unread badge if the instance isn't focused
6. Instances persist to `~/.config/Multi-Code/contacts.json`

## License

Private / Internal use.
