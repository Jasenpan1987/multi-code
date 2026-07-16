# Multi-Code

> [中文文档](./README.zh-CN.md)

A desktop application for managing multiple terminal-based coding-agent sessions from a single interface. It supports two backends — **Claude Code** and **OpenCode** — and you can mix both. Think of it as a terminal multiplexer with a classic QQ (early-2000s chat app) aesthetic: each agent session appears as a "contact" in a sidebar, with full terminal fidelity and notification support.

**Zero residue:** Multi-Code spawns the real `claude` / `opencode` CLI directly and never writes into their config or session directories. Uninstalling the app leaves no trace in `~/.claude/`, `~/.config/opencode/`, or your projects. It only keeps its own tiny contact list (see [Data persistence](#data-persistence)).

## Why

When working with multiple coding-agent sessions across different projects simultaneously, you run into context contamination and missed notifications. Multi-Code solves this by giving each session its own isolated terminal view while providing unified notification management — regardless of whether the session is Claude Code or OpenCode.

## Features

### Core
- **Multi-Backend** — Each instance runs either **Claude Code** or **OpenCode**. Pick the backend when creating an instance; mix both freely, even in the same project directory
- **Instance Management** — Spawn, restart, and remove agent sessions per project directory
- **Full Terminal Fidelity** — Real PTY via node-pty, rendered in xterm.js. No chat abstraction, no message parsing
- **Session Notifications** — Detects when an agent finishes a turn (Claude via its session JSONL, OpenCode via its session database); plays audio, flashes the contact, and bounces the macOS Dock
- **Persistence** — Instance list (including each instance's backend) saved to disk, survives app restart
- **Three-Column Layout** — Contact list | terminal | toolbox, with a draggable splitter between terminal and toolbox

### Toolbox (per-instance utility panel)
- **Git section** — Current branch, file counts (new / modified / staged), remote ahead/behind, clickable file list (opens file in VS Code). Polls every 5s while the section is expanded
- **Quick Actions** — One-click buttons for common operations:
  - **Go to Code Base** — Open the project in VS Code
  - **Show Cost / Clear / Compact** — Auto-type `/cost`, `/clear`, `/compact` into the terminal (Show Cost is disabled for OpenCode, which has no inline cost command)
  - **Resume Elsewhere** — Copy the backend's resume command to clipboard for handoff to a standalone terminal (`claude --resume <id>` or `opencode --session <id>`)
- **Terminal section** — Embedded real shell (your default `$SHELL`) running in the project's directory. Persists in background across collapses and instance switches
- **View section** — Render a Markdown file inline: paste a `.md` path (or click a `.md` path in the terminal output, or the "View" affordance on a changed `.md` in the Git section). Supports GitHub-flavored Markdown, math (KaTeX), Mermaid diagrams, and local/remote images

### Visual / UX
- **QQ Aesthetic** — Aqua-blue gradients, compact avatars, familiar sidebar layout
- **Backend at a glance** — Claude Code instances have **circular** avatars, OpenCode instances have **rounded-square** avatars
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
│       │   │   ├── index.ts          # Entry point, window creation, dock icon, mdimg:// protocol
│       │   │   ├── process-manager.ts # Spawns & manages agent CLI processes (backend-agnostic)
│       │   │   ├── backends/          # Backend abstraction: claude.ts, opencode.ts, registry
│       │   │   ├── shell-manager.ts  # Spawns & manages shell PTYs (toolbox Terminal)
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

### Prerequisite: a backend CLI

Multi-Code drives real agent CLIs — install **at least one** backend before launching. You only need the CLI for the backend(s) you actually plan to use; neither is mandatory if you only want the other.

**Claude Code CLI** (for Claude Code instances):

```bash
curl -fsSL https://claude.ai/install.sh | sh
claude --version   # verify
```

**OpenCode CLI** (optional — only for OpenCode instances):

```bash
curl -fsSL https://opencode.ai/install | bash
opencode --version   # verify
```

If the relevant command prints a version number, you're good. If you pick a backend in the app whose CLI isn't installed, that instance simply comes up OFFLINE.

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
- At least one backend CLI in PATH: Claude Code (`claude`) and/or OpenCode (`opencode`)

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

Multi-Code positions itself as a **lightweight agent orchestration hub**: run multiple Claude Code / OpenCode sessions in parallel, watch them at a glance, send quick commands. When a session needs deep "edit code while watching the AI" work, hand it off to an IDE-integrated or standalone terminal with one click.

### Creating an instance

1. Click the **"+ New"** button at the bottom of the left sidebar
2. Choose a **backend** — **Claude Code** or **OpenCode**. The picker defaults to whichever you used last. If you select OpenCode and its CLI isn't on your PATH, an inline warning appears (you can still create the instance)
3. Select a project directory (absolute path)
4. Optionally fill in an alias (display name in the contact list)
5. Click Create — the app spawns the chosen CLI in that directory (`claude` or `opencode`), resuming a prior session if one exists. The instance's avatar is **circular for Claude Code, rounded-square for OpenCode**.

> The same directory can host both a Claude Code and an OpenCode instance at once — they run independently. Creating a duplicate of the *same* backend in the same directory still warns you (as before).

### Main layout (three columns)

```
┌──────────────┬─────────────────────┬─────────────────────┐
│ Contact List │ Terminal (agent)    │ Toolbox             │
│              │                     │  ▾ Git              │
│  + New       │                     │  ▸ Quick Actions    │
│              │                     │  ▸ Terminal         │
│              │                     │  ▸ View             │
└──────────────┴─────────────────────┴─────────────────────┘
```

- **Left** — Instance list. Green avatar = running, gray = stopped. Right-click for Restart / Remove. Stopped instances show a ▶ button to restart.
- **Middle** — The main agent chat (real terminal — Claude Code or OpenCode's TUI). Light Aqua-blue background tuned for ANSI diff blocks.
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
| Show Cost | Types `/cost` into the main terminal. **Disabled for OpenCode** (no inline cost command) with an explanatory tooltip |
| Clear | Types `/clear` into the main terminal |
| Compact | Types `/compact` into the main terminal |
| Resume Elsewhere | Copies the backend's resume command — `claude --resume <session-id>` or `opencode --session <session-id>` — to the clipboard |

#### View
- Renders a Markdown file inline in the toolbox column
- Open a file three ways: paste its path into the input and press Enter, **click a `.md` path in the terminal output**, or click the **View** affordance next to a changed `.md` file in the Git section
- Supports GitHub-flavored Markdown, math (`$…$` / `$$…$$` via KaTeX), Mermaid diagrams, and images (local images resolve relative to the file; remote `https://` images load directly)
- Only `.md` / `.markdown` files, capped at 2 MB; anything else shows a plain inline message. Raw HTML in the Markdown is not executed

#### Terminal
- Real shell PTY (uses your `$SHELL`), black background and white text like Terminal.app
- Opens in the instance's project directory
- Lazy-spawned on first expand, then **kept alive in the background** — switching to another instance or collapsing the section does not kill the process
- Anything works: `vim`, `pnpm test`, `git commit`, etc.

### Notification behavior

Notifications work identically for both backends — only the detection source differs (Claude Code's session JSONL vs OpenCode's session database).

- Agent completes a turn → plays the "ding" notification sound
- Avatar blinks + red dot badge appears
- macOS Dock icon bounces (`critical` mode — keeps bouncing until you bring the app to the front)
- For the currently selected instance: the blink auto-clears after 1.5s (you're already looking at it)
- For other instances: keeps blinking until you click into it

### Offline state

- Stopped instances have a gray avatar
- When a stopped instance is selected: the chat area shows a large **OFFLINE** label
- All toolbox sections are force-collapsed and cannot be expanded
- To bring it back online: click the ▶ button on the contact entry to relaunch its backend CLI

### Resuming a session in your IDE

When a session enters deep "edit code while watching the AI" territory:

1. Toolbox → Quick Actions → click **Resume Elsewhere** — the backend's resume command is now on your clipboard (`claude --resume <id>` or `opencode --session <id>`)
2. Open a terminal in VS Code (or iTerm / Terminal.app), `cd` to the project root
3. Paste and press Enter — the agent continues this session in that environment
4. You can leave Multi-Code running, or close it

### Data persistence

- Instance list (directory + alias + backend) is stored in `~/.config/Multi-Code/contacts.json`
- On app restart, the contact list is restored (all entries start as stopped — relaunch manually)
- Session content itself is managed by the backend CLI (Claude Code under `~/.claude/`, OpenCode under `~/.local/share/opencode/`); Multi-Code does not store any conversation data and never writes into those directories

## How It Works

1. User creates an instance by selecting a project directory and a backend (Claude Code / OpenCode)
2. App spawns the backend CLI (`claude` / `opencode`, resuming a prior session if one exists) via node-pty in that directory. Backends are pluggable behind a small `Backend` interface in `src/main/backends/`
3. PTY stdout is piped in real-time to an xterm.js terminal in the renderer
4. A per-backend completion detector watches for turn completion — Claude via its session JSONL, OpenCode via its session database — read-only, without writing anything back
5. On completion: audio + flash + Dock bounce. The selected instance auto-clears unread state after 1.5s
6. Toolbox sections each manage their own lifecycle:
   - Git: shells out to `git` every 5s while expanded
   - Terminal: lazy-spawns a shell PTY on first expand, persists across collapses
7. Instances persist to `~/.config/Multi-Code/contacts.json`

## License

Private / Internal use.
