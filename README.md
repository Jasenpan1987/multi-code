# Multi-Code

> [中文文档](./README.zh-CN.md)

A desktop application for managing multiple Claude Code CLI instances from a single interface. Think of it as a terminal multiplexer with a classic QQ (early-2000s chat app) aesthetic — each Claude Code session appears as a "contact" in a sidebar, with full terminal fidelity and notification support.

## Why

When working with multiple Claude Code sessions across different projects simultaneously, you run into context contamination and missed notifications. Multi-Code solves this by giving each session its own isolated terminal view while providing unified notification management.

## Features

### Core
- **Instance Management** — Spawn, restart, and remove Claude Code sessions per project directory
- **Full Terminal Fidelity** — Real PTY via node-pty, rendered in xterm.js. No chat abstraction, no message parsing
- **Session Notifications** — Monitors Claude's session JSONL files; plays audio, flashes the contact, and bounces the macOS Dock when an agent finishes responding
- **Persistence** — Instance list saved to disk, survives app restart
- **Three-Column Layout** — Contact list | terminal | toolbox, with a draggable splitter between terminal and toolbox

### Toolbox (per-instance utility panel)
- **Git section** — Current branch, file counts (new / modified / staged), remote ahead/behind, clickable file list (opens file in VS Code). Polls every 5s while the section is expanded
- **Quick Actions** — One-click buttons for common operations:
  - **Go to Code Base** — Open the project in VS Code
  - **Show Cost / Clear / Compact** — Auto-type `/cost`, `/clear`, `/compact` into the terminal
  - **Resume Elsewhere** — Copy `claude --resume <session-id>` to clipboard for handoff to IDE-integrated Claude Code
- **Terminal section** — Embedded real shell (your default `$SHELL`) running in the project's directory. Persists in background across collapses and instance switches

### Visual / UX
- **QQ Aesthetic** — Aqua-blue gradients, compact avatars, familiar sidebar layout
- **Dock Bounce** — macOS Dock icon bounces when an agent finishes while the app is in the background

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
│       │   │   ├── index.ts          # Entry point, window creation, dock icon
│       │   │   ├── process-manager.ts # Spawns & manages claude CLI processes
│       │   │   ├── shell-manager.ts  # Spawns & manages shell PTYs (toolbox Terminal)
│       │   │   ├── session-watcher.ts # Monitors session JSONL for end_turn
│       │   │   ├── git-status.ts     # Git status reader (used by toolbox)
│       │   │   ├── ipc-handlers.ts    # IPC endpoint registration
│       │   │   ├── preload.ts         # Context bridge (electronAPI)
│       │   │   └── store.ts           # Persistent storage (~/.config/Multi-Code/)
│       │   ├── renderer/       # React UI
│       │   │   ├── App.tsx
│       │   │   ├── components/       # ContactList, TerminalView, Toolbox + sections, etc.
│       │   │   ├── hooks/            # useNotifications
│       │   │   ├── audio/            # Web Audio notification sounds
│       │   │   ├── assets/           # Icons (gaming.png), sound files
│       │   │   └── styles/           # Global CSS (QQ theme)
│       │   └── shared/         # Shared TypeScript types
│       ├── package.json
│       └── rspack.renderer.config.ts
├── docs/                       # Business docs, specs, knowledge base
├── package.json                # Root workspace config
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Installing the .dmg (end users)

> Apple Silicon Macs only (M1/M2/M3/M4). Intel Macs are not supported.

You will receive a `Multi-Code-0.1.0-arm64.dmg` file directly (e.g. via Slack/Drive/AirDrop). Follow the steps below.

### Prerequisite: Claude Code CLI

Install the Claude Code CLI **before** launching Multi-Code:

```bash
curl -fsSL https://claude.ai/install.sh | sh
```

Verify it works:

```bash
claude --version
```

If that prints a version number, you're good.

### Step 1 — Install the app

1. Double-click the `Multi-Code-0.1.0-arm64.dmg` file you received
2. In the disk window that opens, drag the **Multi-Code** icon into the **Applications** folder
3. Eject the mounted disk (right-click → Eject, or drag it to the Trash)

### Step 2 — Clear the quarantine flag (required, do once)

This app is not signed with an Apple Developer certificate, so macOS Gatekeeper will block it from running by default. Run this command once in Terminal to remove the quarantine flag:

```bash
xattr -cr /Applications/Multi-Code.app
```

### Step 3 — Launch

Open Multi-Code from Launchpad or the Applications folder. From now on, double-click works as normal — you don't need to repeat Step 2.

### Troubleshooting

**"Multi-Code can't be opened" / nothing happens on double-click**
You skipped Step 2. Run the `xattr` command above and try again.

**Created an instance but the chat window says OFFLINE**
The `claude` CLI isn't on your PATH. Verify with `claude --version`. If that fails, reinstall the Claude Code CLI (see Prerequisite above).

**Upgrading to a new version**
Drag the new `Multi-Code.app` into Applications (replace the old one), then run `xattr -cr /Applications/Multi-Code.app` again before launching.

---

## Development (run from source)

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

## Usage Guide

Multi-Code positions itself as a **lightweight agent orchestration hub**: run multiple Claude Code sessions in parallel, watch them at a glance, send quick commands. When a session needs deep "edit code while watching the AI" work, hand it off to IDE-integrated Claude Code (VS Code etc.) with one click.

### Creating an instance

1. Click the **"+ New"** button at the bottom of the left sidebar
2. Select a project directory (absolute path)
3. Optionally fill in an alias (display name in the contact list)
4. Click Create — the app spawns `claude` in that directory. On first entry to a directory with no prior session, it starts a fresh session; otherwise it resumes the latest one with `--continue`.

### Main layout (three columns)

```
┌──────────────┬─────────────────────┬─────────────────────┐
│ Contact List │ Terminal (claude)   │ Toolbox             │
│              │                     │  ▾ Git              │
│  + New       │                     │  ▸ Quick Actions    │
│              │                     │  ▸ Terminal         │
└──────────────┴─────────────────────┴─────────────────────┘
```

- **Left** — Instance list. Green avatar = running, gray = stopped. Right-click for Restart / Remove. Stopped instances show a ▶ button to restart.
- **Middle** — The main claude chat (real terminal). Light Aqua-blue background tuned for ANSI diff blocks.
- **Right** — Toolbox, accordion-style: only one section is expanded at a time and fills the available vertical space. Git is expanded by default.
- **Between middle and right** — A **draggable splitter**. Drag to resize. Each side has a 280px minimum.

### Toolbox sections

#### Git
- Shows current branch, file counts, and remote ahead/behind
- Lists each changed file — **click a file name to open it in VS Code**
- If there are more than 20 changed files, the list is hidden and a "too many files" message is shown
- Strict cwd check: only the cwd's own `.git` is inspected; parent directories are not searched. Subdirectories of a repo show "Not a git repository" by design.

#### Quick Actions
| Button | What it does |
|--------|--------------|
| Go to Code Base | Runs `code <cwd>` — opens the project in VS Code, or activates the existing window if it's already open |
| Show Cost | Types `/cost` into the main terminal |
| Clear | Types `/clear` into the main terminal |
| Compact | Types `/compact` into the main terminal |
| Resume Elsewhere | Copies `claude --resume <session-id>` to the clipboard |

#### Terminal
- Real shell PTY (uses your `$SHELL`), black background and white text like Terminal.app
- Opens in the instance's project directory
- Lazy-spawned on first expand, then **kept alive in the background** — switching to another instance or collapsing the section does not kill the process
- Anything works: `vim`, `pnpm test`, `git commit`, etc.

### Notification behavior

- Agent completes a turn (`end_turn`) → plays the "ding" notification sound
- Avatar blinks + red dot badge appears
- macOS Dock icon bounces (`critical` mode — keeps bouncing until you bring the app to the front)
- For the currently selected instance: the blink auto-clears after 1.5s (you're already looking at it)
- For other instances: keeps blinking until you click into it

### Offline state

- Stopped instances have a gray avatar
- When a stopped instance is selected: the chat area shows a large **OFFLINE** label
- All toolbox sections are force-collapsed and cannot be expanded
- To bring it back online: click the ▶ button on the contact entry to relaunch claude

### Resuming a session in your IDE

When a session enters deep "edit code while watching the AI" territory:

1. Toolbox → Quick Actions → click **Resume Elsewhere** — the command is now on your clipboard
2. Open a terminal in VS Code (or iTerm / Terminal.app), `cd` to the project root
3. Paste and press Enter — claude continues this session in the IDE-integrated environment
4. You can leave Multi-Code running, or close it

### Data persistence

- Instance list (directory + alias) is stored in `~/.config/Multi-Code/contacts.json`
- On app restart, the contact list is restored (all entries start as stopped — relaunch manually)
- Session content itself is managed by Claude Code (under `~/.claude/`); Multi-Code does not store any conversation data

## How It Works

1. User creates an instance by selecting a project directory
2. App spawns `claude` (or `claude --continue` if a session exists) via node-pty in that directory
3. PTY stdout is piped in real-time to an xterm.js terminal in the renderer
4. SessionWatcher polls the Claude session JSONL file for `end_turn` events to detect completion
5. On completion: audio + flash + Dock bounce. The selected instance auto-clears unread state after 1.5s
6. Toolbox sections each manage their own lifecycle:
   - Git: shells out to `git` every 5s while expanded
   - Terminal: lazy-spawns a shell PTY on first expand, persists across collapses
7. Instances persist to `~/.config/Multi-Code/contacts.json`

## License

Private / Internal use.
