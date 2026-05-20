# Business Overview — Multi-Code

## Product Positioning

Multi-Code is a desktop application that lets programmers manage multiple Claude Code CLI instances from a single window. UI is inspired by classic QQ (early 2000s) — a contact list where each "contact" is a running Claude Code terminal session.

It is essentially a **terminal multiplexer with a QQ skin**. The app spawns real `claude` CLI processes and renders their output in embedded terminal views (xterm.js). No abstraction layers, no custom protocols — just raw terminal I/O with a nice management UI on top.

## Core Pain Points

1. **Context contamination** — Multiple terminal windows; accidentally typing in the wrong one corrupts AI context
2. **No unified view** — No single place to see all active AI sessions at a glance
3. **Missed responses** — AI replies in one project while user is focused on another window

## Target Users

- Primary: Programmers and technical workers
- Initial scope: Internal team usage
- Long-term goal: Open source

## Core Concepts

| Concept | QQ Analogy | Actual Meaning |
|---------|-----------|----------------|
| Contact | QQ friend | A Claude Code instance (spawned by the app) |
| Avatar flash | Message alert | Instance has new terminal output |
| Chat window | QQ chat box | Embedded terminal (xterm.js) showing real Claude Code |
| Contact list | QQ friend list | All managed instances at a glance |
| Online/Offline | Friend status | Process running vs exited |

## Key Mental Model

This is NOT a chat application. It's a **terminal multiplexer with a chat-app skin**. The app spawns `claude` processes, pipes their I/O through node-pty, and renders in xterm.js. Everything Claude Code can do in a real terminal, it can do here.

## Technical Approach

- App spawns `claude` CLI via `node-pty` with specified `cwd`
- Terminal rendered via `xterm.js` in Electron renderer
- Full terminal fidelity: ANSI colors, clickable elements, permission prompts, tabs
- No history storage, no message parsing — raw terminal pass-through

## Product Positioning (refined 2026-05-16)

Multi-Code is a **lightweight agent orchestration hub**, not a deep IDE-integrated coding tool.

- **What it's good for:** running many agents in parallel, glancing at status, sending lightweight commands, dispatching work
- **What it's NOT trying to be:** an IDE replacement. When deep "edit code while watching the AI" work is needed, the user hands the session off to IDE-integrated Claude Code (via `claude --resume <session-id>`)

This positioning informs feature scope: features that reduce the cost of glancing at many agents are in scope; features that duplicate IDE capabilities are not.

(source: 2026-05-16 toolbox ideation)

## Product Positioning (refined again 2026-05-18)

Multi-Code is a **general-purpose AI coding-agent orchestration hub** — not specific to any single CLI agent.

- **Backends supported:** Claude Code (since v1), OpenCode (added in opencode-support epic). Architecture is designed to add more (Cursor, aider, etc.) without significant rework.
- **Per-instance backend lock-in:** each instance picks its backend at creation and is locked to it for life. Same cwd may simultaneously host instances from different backends (legitimate use case: collaborator uses opencode, builder uses claude on the same project).
- **Behavioral parity is mandatory:** the user experience for managing a claude instance vs an opencode instance must be as identical as possible. Notifications, completion detection, session ID handling, Quick Actions etc. all use a unified abstraction (the hook channel) so neither backend feels like a second-class citizen.

Why this matters: the original positioning (Claude Code orchestration) tied Multi-Code's identity to one vendor. Builder explicitly wants the project to outlast vendor preferences — colleagues use opencode, builder uses claude, and Multi-Code should treat both as first-class.

(source: 2026-05-18 opencode-support ideation)

## UI Layout (current + planned)

- **Current (MVP):** Two columns — contact list | terminal
- **Planned (Toolbox epic):** Three columns — contact list | terminal | toolbox

The toolbox is a per-instance utility panel using an accordion (one section expanded at a time). MVP sections: Git status, Quick Actions. Designed for future extensibility (more sections added over time).

(source: 2026-05-16 toolbox ideation)

## Multi-Backend Architecture (planned 2026-05-18)

Each instance has a `backend` field (`"claude"` or `"opencode"`) chosen at creation. Backend-specific behavior is funneled through a small set of abstractions:

1. **Spawner**: which CLI binary, which flags. (Currently: `claude --continue` vs `opencode --continue`. Existing-contacts migration: defaults to `claude`.)
2. **Session discoverer**: how to find the sessionId for a running instance. claude scans `~/.claude/sessions/*.json` matching cwd; opencode queries `~/.local/share/opencode/opencode.db` `session` table.
3. **Completion detector**: how to detect "agent finished a turn" or "permission requested". claude polls the session jsonl; opencode polls the sqlite `message` table. Both emit identical higher-level events (`turn_complete`, `permission_request`).
4. **Resume command builder**: produces `claude --resume <id>` or `opencode --session <id>` for the Resume Elsewhere button.
5. **Visual identity**: avatar shape (circle for claude, square for opencode).

**Zero-residue principle:** Multi-Code is strictly a read-only observer of the agents' own state files. It does not modify user configuration (no hooks, no plugins, no settings injection). Uninstalling Multi-Code leaves no trace in claude/opencode behavior.

(source: 2026-05-18 opencode-support ideation; hook approach was considered and rejected — see timeline entry for rationale)
