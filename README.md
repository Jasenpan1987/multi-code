# Multi-Code

> [中文文档](./README.zh-CN.md)

A desktop application for managing multiple terminal-based coding-agent sessions from a single interface. It supports two backends — **Claude Code** and **OpenCode** — and you can mix both. Think of it as a terminal multiplexer with a classic QQ (early-2000s chat app) aesthetic: each agent session appears as a "contact" in a sidebar, with full terminal fidelity and notification support.

**Zero residue:** Multi-Code spawns the real `claude` / `opencode` CLI directly and never writes into their config or session directories. Uninstalling the app leaves no trace in `~/.claude/`, `~/.config/opencode/`, or your projects. It only keeps its own tiny contact list (see [Data persistence](#data-persistence)).

## Why

When working with multiple coding-agent sessions across different projects simultaneously, you run into context contamination and missed notifications. Multi-Code solves this by giving each session its own isolated terminal view while providing unified notification management — regardless of whether the session is Claude Code or OpenCode. When even that is too many terminals to watch, a **Manager** agent can do the watching and dispatching for you (see [Manager Agent](#manager-agent-1)).

## Features

### Core
- **Multi-Backend** — Each instance runs either **Claude Code** or **OpenCode**. Pick the backend when creating an instance; mix both freely, even in the same project directory
- **Instance Management** — Spawn, restart, and remove agent sessions per project directory
- **Full Terminal Fidelity** — Real PTY via node-pty, rendered in xterm.js. No chat abstraction, no message parsing
- **Session Notifications** — Detects when an agent finishes a turn (Claude via its session JSONL, OpenCode via its session database); plays audio, flashes the contact, and bounces the macOS Dock
- **Context usage at a glance** — Each contact row shows how full that session's context window is, as a percentage with a colour tint. Hover for the exact token count, the model, and when it was measured. Where the window size can't be established reliably, the row shows the raw token count instead of guessing a percentage. Stopped sessions show their last known usage too
- **Follows `/clear` and `/new`** — When a running CLI moves to a fresh session, Multi-Code follows it, so context usage, notifications, and the manager's view keep tracking the live session
- **Persistence** — Instance list (including each instance's backend) saved to disk, survives app restart
- **Drag to reorder** — Drag contacts up and down the sidebar; the order is saved and survives a restart
- **Compose Box** — `Cmd+L` summons an editor over the terminal: multi-line input, mouse editing, `Enter` to send / `Shift+Enter` for a newline, and image paste (with a thumbnail preview) sent as an `@<path>` attachment. For long messages the folded TUI input makes awkward. Works for both backends
- **Side-by-side diff** — Open any changed file from the Git section in a movable, resizable diff window. Select lines and hit **Ask agent** to drop an `@path:start-end` reference into the Compose Box
- **Three-Column Layout** — Contact list | terminal | toolbox, with a draggable splitter between terminal and toolbox

### Manager Agent
- **One agent to talk to** — Click **+ Manager** to create a Claude Code instance whose job is your other sessions. Ask it how a project is going, or tell it to hand work out, instead of switching between terminals yourself
- **Reads without interrupting** — It reads another session's transcript directly, so the target spends no tokens and loses no turn. Stopped sessions can be read too
- **Dispatches work, safely** — It can start a stopped session, send a task, run an allowlisted slash command (`/clear`, `/new`, `/compact`, `/context`, `/handoff`), and wait for a session to go idle. A write-safety gate refuses to type into a session that is waiting on a permission dialog, so the manager can't accidentally approve something for you
- **Works across backends** — It dispatches to OpenCode sessions as well as Claude Code ones
- **Nothing invisible** — Every call it makes, including refusals and its own Bash/Edit/Write calls, shows up live in the toolbox's **Manager** section
- **Local only** — Its tools are served by an MCP server bound to `127.0.0.1` with a bearer token kept in a `0600` file, never on the command line

### Toolbox (per-instance utility panel)
- **Git section** — Current branch, file counts (new / modified / staged), remote ahead/behind, and a file list where each row has **View** (side-by-side diff), **Go To** (open in VS Code), and for Markdown files **MD** (preview). Renames show as renames. Polls every 5s while the section is expanded
- **Quick Actions** — One-click buttons for common operations:
  - **Go to Code Base** — Open the project in VS Code
  - **Show Cost / Clear / Compact** — Auto-type `/cost`, `/clear`, `/compact` into the terminal (Show Cost is disabled for OpenCode, which has no inline cost command)
  - **Resume Elsewhere** — Copy the backend's resume command to clipboard for handoff to a standalone terminal (`claude --resume <id>` or `opencode tui --session <id>`)
  - **Rename Session** — Give the current session a name, using each backend's own `/rename`
- **Terminal section** — Embedded real shell (your default `$SHELL`) running in the project's directory. Persists in background across collapses and instance switches
- **View section** — Render a Markdown file inline: paste a `.md` path (or click a `.md` path in the terminal output, or the "View" affordance on a changed `.md` in the Git section). Supports GitHub-flavored Markdown, math (KaTeX), Mermaid diagrams, and local/remote images
- **Phone section** — Pair a phone and watch/steer your agents from it (see [Phone Link](#phone-link) below)
- **Manager section** — Live feed of every call the manager agent makes, newest first, with the full arguments and result one click away

### Phone Link
- **No intermediary server** — Your phone talks straight to your desktop. Nothing transits a third party, ours or anyone else's
- **Works away from home** — Over [Tailscale](https://tailscale.com), your phone reaches the desktop from anywhere as a direct connection. On the same WiFi it just works with no setup
- **No app install** — The desktop serves a mobile web client; scan the QR and add it to your home screen
- **Live mirroring** — Terminal output streams in real time, and a phone joining mid-session gets a snapshot of the current screen rather than a blank one
- **Tap to answer** — When an agent asks a question, its options render as buttons. Tap one and the agent unblocks
- **Type to answer** — A compose box for open questions, sending the same way the desktop's `Cmd+L` box does
- **End-to-end encrypted** — NaCl box (Curve25519 + XSalsa20-Poly1305). Your phone pins the desktop's public key at pairing, so nothing at that address can impersonate it
- **Revocable** — Each paired phone has its own token; revoking one disconnects it immediately

### Visual / UX
- **QQ Aesthetic** — Aqua-blue gradients, compact avatars, familiar sidebar layout
- **Themes** — Light, dark, and sepia, switched from the top-right toggle
- **Backend at a glance** — Claude Code instances have **circular** avatars and blue window chrome; OpenCode instances have **rounded-square** avatars and green chrome. The header also names the backend
- **Pinned manager** — The manager row always sits at the top of the list, styled apart from the projects
- **Long names scroll** — A name too long for the sidebar slides to its end when you hover it
- **Version badge** — The current build version shows in the top-right of the window (next to the theme toggle), so you can always tell which build is running. A dev build adds a **DEV** chip and amber stripes across the titlebar, so it can't be mistaken for the installed app
- **Mac-style shortcuts** — In the agent terminal, `Cmd+Backspace` clears the input line and `Cmd+Left` / `Cmd+Right` jump to its start / end. `Cmd+R` is disabled so it can't reload the window by accident
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
│       │   │   ├── run-state.ts       # Write-safety gate (idle / busy / blocked per instance)
│       │   │   ├── manager-mcp/       # Local MCP server + tools for the manager agent
│       │   │   ├── manager-workspace.ts # Seeds the manager's own folder and guidance
│       │   │   ├── remote/            # Phone Link: WebSocket server, crypto, paired devices
│       │   │   ├── shell-manager.ts  # Spawns & manages shell PTYs (toolbox Terminal)
│       │   │   ├── git-status.ts     # Git status reader (used by toolbox)
│       │   │   ├── git-diff.ts       # Reads a file's diff as aligned old/new rows
│       │   │   ├── ipc-handlers.ts    # IPC endpoint registration
│       │   │   ├── preload.ts         # Context bridge (electronAPI)
│       │   │   ├── settings-store.ts  # settings.json (theme, phone link)
│       │   │   └── store.ts           # contacts.json (in Electron's userData folder)
│       │   ├── renderer/       # React UI
│       │   │   ├── App.tsx
│       │   │   ├── components/       # ContactList, TerminalView, Toolbox + sections, DiffWindow, etc.
│       │   │   ├── hooks/            # useNotifications, useTheme
│       │   │   ├── audio/            # Web Audio notification sounds
│       │   │   ├── assets/           # Icons (gaming.png), sound files
│       │   │   └── styles/           # Global CSS (QQ theme)
│       │   ├── renderer-mobile/ # Phone Link web client (served to the phone)
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

You will receive a `Multi-Code-0.1.0-arm64.dmg` file directly (e.g. via Slack/Drive/AirDrop). Follow the steps below. The `0.1.0` in the filename here is just an example; your file carries whatever version you were sent.

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
The backend's CLI isn't on your PATH. Verify with `claude --version` (or `opencode --version` for an OpenCode instance). If that fails, reinstall that CLI (see Prerequisite above).

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
│  + Manager   │                     │  ▸ Terminal         │
│              │                     │  ▸ View             │
│              │                     │  ▸ Phone            │
│              │                     │  ▸ Manager          │
└──────────────┴─────────────────────┴─────────────────────┘
```

- **Left** — Instance list. Green avatar = running, gray = stopped. Each row shows context usage. Drag rows to reorder (the manager stays pinned on top). Right-click for Restart / Remove. Stopped instances show a ▶ button to restart.
- **Middle** — The main agent chat (real terminal — Claude Code or OpenCode's TUI). Light Aqua-blue background tuned for ANSI diff blocks.
- **Right** — Toolbox, accordion-style: only one section is expanded at a time and fills the available vertical space. Git is expanded by default.
- **Between middle and right** — A **draggable splitter**. Drag to resize. Each side has a 280px minimum.

### Compose Box

The TUI's own input is folded, which is awkward for long messages, multi-line content, or attaching images. Use the Compose Box instead:

1. Press **`Cmd+L`** in the terminal to summon it (any running instance, Claude Code or OpenCode; a no-op for stopped instances)
2. Type freely — **`Enter` sends**, **`Shift+Enter` inserts a newline**, **`Esc` cancels**
3. To attach an image, just **paste it** (e.g. a screenshot) — a thumbnail chip appears; on send the image goes to claude as an `@<path>` attachment
4. Switching instances discards the draft (each instance's draft is independent)

### Toolbox sections

#### Git
- Shows current branch, file counts, and remote ahead/behind
- Lists each changed file, with tags at the end of the row:
  - **View** — open the file's side-by-side diff (see [Diff window](#diff-window) below)
  - **Go To** — open the project in VS Code and reveal the file. If the project isn't open yet, its window is launched (rather than dropping the file into whatever window is frontmost)
  - **MD** — on `.md` / `.markdown` files, preview the file inline in the View section below
- A renamed file shows under its new name and diffs as a rename, not as a whole new file
- If there are more than 20 changed files, the list is hidden and a "too many files" message is shown
- Strict cwd check: only the cwd's own `.git` is inspected; parent directories are not searched. Subdirectories of a repo show "Not a git repository" by design.

#### Quick Actions
| Button | What it does |
|--------|--------------|
| Go to Code Base | Runs `code <cwd>` — opens the project in VS Code, or activates the existing window if it's already open |
| Show Cost | Types `/cost` into the main terminal. **Disabled for OpenCode** (no inline cost command) with an explanatory tooltip |
| Clear | Types `/clear` into the main terminal |
| Compact | Types `/compact` into the main terminal |
| Resume Elsewhere | Copies the backend's resume command — `claude --resume <session-id>` or `opencode tui --session <session-id>` — to the clipboard |
| Rename Session | Asks for a name and renames the session through the backend's own `/rename` |

#### View
- Renders a Markdown file inline in the toolbox column
- Open a file three ways: paste its path into the input and press Enter, **click a `.md` path in the terminal output**, or click the **MD** tag next to a changed `.md` file in the Git section
- Supports GitHub-flavored Markdown, math (`$…$` / `$$…$$` via KaTeX), Mermaid diagrams, and images (local images resolve relative to the file; remote `https://` images load directly)
- Only `.md` / `.markdown` files, capped at 2 MB; anything else shows a plain inline message. Raw HTML in the Markdown is not executed

#### Terminal
- Real shell PTY (uses your `$SHELL`), black background and white text like Terminal.app
- Opens in the instance's project directory
- Lazy-spawned on first expand, then **kept alive in the background** — switching to another instance or collapsing the section does not kill the process
- Anything works: `vim`, `pnpm test`, `git commit`, etc.

#### Manager
- A live feed of every call the manager agent makes, newest first
- Each entry shows the target session and a one-line preview; click it for the full arguments and result
- A call shows up the moment it starts, so a long `wait_for_idle` is visible while it runs
- Refused calls are listed too, with the reason. The manager's own Bash / Edit / Write calls carry an **own** badge

### Diff window

Click **View** on a row in the Git section to open that file's diff.

- Old version on the left, new on the right, aligned row by row, with whole-file context. One scroll moves both halves
- It's a window, not a modal: drag it by the header, resize it from the corner, and keep using the rest of the app. Opening another file reuses the same window in the same place. `Esc` closes it
- **Select lines** — click a row, shift-click to extend, or drag across a range. A bar shows the reference the selection makes (`@path:start-end`)
- **Ask agent** — appends that reference to the Compose Box and opens it with the cursor after it, so you can type your question. Ask about two places and both references accumulate
- Copying text out of the diff copies code only, without line numbers
- If a diff can't be shown, it says why: binary, too large, not found, no changes, or git failed. Very long files are truncated at 5,000 rows with a note

### Manager Agent

The manager is one Claude Code agent you talk to instead of talking to each session yourself.

**Setting it up:**

1. Click **+ Manager** at the bottom of the sidebar. It creates the manager in its own folder inside Multi-Code's data directory, and the button disappears once a manager exists
2. On first start, Claude Code asks whether you trust the folder. **The highlighted default is "No, exit", and pressing Enter will shut the manager down.** Press the down arrow to pick "Yes, I trust this folder", then Enter. Multi-Code shows a reminder for this the first time

**What it can do:**

| Tool | What it does |
|------|--------------|
| `list_sessions` | Lists every session with its state (idle / busy / blocked / stopped) and context usage |
| `read_session` | Reads a session's recent transcript without interrupting it. Works on stopped sessions too |
| `send_task` | Sends a message to a session. Refused if the session is waiting on a dialog |
| `run_command` | Runs one of `/clear`, `/new`, `/compact`, `/context`, `/handoff` in a session. Anything else is refused |
| `start_session` | Starts a stopped session |
| `wait_for_idle` | Waits until a session finishes its turn, instead of polling |

It also has its normal Claude Code tools (Bash, Edit, Write), so it can check a session's claims or make small fixes itself. Its guidance tells it not to edit a project whose session is busy.

Sessions are addressed by the name you see in the sidebar. If two share a name, give one an alias.

**Safety:** before the manager writes into a session, a gate checks that the session isn't waiting on a permission dialog. Typing into a dialog could approve something you never saw, so those writes are refused and the reason shows up in the Manager section. Your own typing, from the desktop or the phone, is never gated.

The manager's role guidance lives in a `CLAUDE.md` in its folder. You can edit it; Multi-Code only upgrades that file if it still matches a version it wrote.

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

### Phone Link

Watch your agents and answer their questions from your phone, so an agent
doesn't sit blocked just because you stepped away.

**Setup (once):**

1. Toolbox → **Phone** → click **Phone link: OFF** to turn it on. It binds port
   6768 and is off by default, since it opens a port on your network
2. Click **Pair a phone** — a QR code appears
3. Scan it with your phone's camera, then use your browser's "Add to Home
   Screen" so it opens like an app

That's it on the same WiFi. To reach your desktop **from anywhere**, install
[Tailscale](https://tailscale.com) on both the desktop and the phone and sign
into the same account. The Phone section tells you whether a Tailscale address
was found — without one, pairing only works on your local network.

**Using it:**

- The instance list mirrors your contact list; tap one to open it
- When an agent needs you, the phone vibrates and the instance shows a badge
- A question with options renders as buttons — tap one to answer
- For open questions, type in the box and hit Send
- Expand **Terminal** to see the raw screen exactly as the desktop shows it

**Security notes:**

- The QR contains a device secret. Treat it like a password; generate a new one
  if it leaks
- Traffic is end-to-end encrypted and never passes through any server
- Your phone pins the desktop's public key at pairing time, so nothing else at
  that address can impersonate your desktop
- Revoke a lost phone from the same panel — it disconnects immediately and its
  token stops working

**Limitation worth knowing:** reading prompts is reliable (parsed from the CLI's
own session files), but *answering by button* assumes the CLI's option boxes
accept number keys. If a CLI update changes that, the buttons may stop working
while everything else keeps going — the terminal view is always there as a
fallback.

### Data persistence

Everything Multi-Code keeps lives in Electron's user-data folder. On macOS that is `~/Library/Application Support/Multi-Code/` for the installed app, and `~/Library/Application Support/multi-code/` when running from source (so the two never share state).

- `contacts.json` — instance list (directory + alias + backend), in sidebar order
- `settings.json` — theme and whether Phone Link is on
- `remote-identity.json`, `remote-devices.json` — Phone Link keys and paired phones
- `manager/` — the manager agent's working folder and its `CLAUDE.md`
- `manager-mcp.json` — the manager's MCP config, written `0600` because it holds a bearer token; removed on shutdown
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
7. Instances persist to `contacts.json` in Electron's user-data folder
8. If a manager exists, the main process also runs a small MCP server on `127.0.0.1` (OS-assigned port, bearer-token auth). The manager's `claude` is spawned with `--mcp-config` pointing at it, plus hooks that report its own tool calls back to the activity feed
9. When Phone Link is on, the main process also runs a WebSocket server on port 6768 that serves the mobile client and streams the same PTY bytes plus decoded prompts to paired phones. Frames are sealed with NaCl box; the phone reaches the desktop directly over LAN or Tailscale, with no relay involved

## License

Private / Internal use.
