# Business Overview — Multi-Code

## Product Positioning

Multi-Code is a desktop application that lets programmers manage multiple Claude Code CLI instances from a single window. The UI is a compact list where each entry (a "contact") is a running Claude Code terminal session.

It is essentially a **terminal multiplexer**. The app spawns real `claude` CLI processes and renders their output in embedded terminal views (xterm.js). No abstraction layers, no custom protocols — just raw terminal I/O with a nice management UI on top.

## Core Pain Points

1. **Context contamination** — Multiple terminal windows; accidentally typing in the wrong one corrupts AI context
2. **No unified view** — No single place to see all active AI sessions at a glance
3. **Missed responses** — AI replies in one project while user is focused on another window

## Target Users

- Primary: Programmers and technical workers
- Initial scope: Internal team usage
- Long-term goal: Open source

## Core Concepts

| Concept | Meaning |
|---------|---------|
| Contact | A Claude Code instance (spawned by the app) |
| Avatar flash | Instance has new terminal output |
| Chat window | Embedded terminal (xterm.js) showing real Claude Code |
| Contact list | All managed instances at a glance |
| Online/Offline | Process running vs exited |

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
- **Behavioral parity is mandatory:** the user experience for managing a claude instance vs an opencode instance must be as identical as possible. Notifications, completion detection, session ID handling, Quick Actions etc. all go through one backend abstraction, so neither backend feels like a second-class citizen.

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
3. **Completion detector**: how to detect "agent finished a turn" or "permission requested". claude polls the session jsonl; opencode polls the sqlite `message` table. Both emit identical higher-level events (`turn_complete`, `permission_request`). Decided 2026-10-06: claude moves to report-only hooks injected with `--settings` (epic `attention-alerts`); until that ships, it polls the jsonl as described.
4. **Resume command builder**: produces `claude --resume <id>` or `opencode --session <id>` for the Resume Elsewhere button.
5. **Visual identity**: avatar shape (circle for claude, square for opencode).

**Zero-residue principle (revised 2026-10-06):** Multi-Code never writes a file the user owns: not `~/.claude/settings.json`, not a project's `.claude/` or `.opencode/`, not any CLI's global config. An agent run outside Multi-Code behaves exactly as if Multi-Code were not installed. Anything Multi-Code needs an agent to load (its MCP config, report-only hooks) lives in Multi-Code's own `userData` directory and reaches only the processes Multi-Code spawns, through their launch options (`--mcp-config`, `--settings`). Uninstalling Multi-Code leaves no trace in claude/opencode behavior.

(source: 2026-05-18 opencode-support ideation, which rejected hooks because they would have had to be written into the user's own config; revised by the builder on 2026-10-06, when passing them with `--settings` removed that reason — see docs/timeline/2026-10-06_attention-alerts-investigation.md)

## Secretary Mode (planned 2026-10-07)

The builder wants agents to keep working while they are away from the screen. Each session gets a **secretary** that briefs them by voice, the way a secretary briefs a CEO: a narrated account of what happened, with the details, not the screen read aloud.

- **Pull, not push.** The chime and red dot fire as today. With Secretary Mode switched on in the toolbox, clicking a red-dot contact plays that session's brief; with it off, nothing changes.
- **Only the moments the CLI answers the builder**: a turn finished (done, or can't be done) and needs-you (a decision or a permission). Never mid-turn narration.
- **The card carries originals, and only when words aren't enough.** When the brief can't make something clear, or the builder needs the exact detail to decide, the secretary attaches the original (the exact command, the question and its options, the flagged code with its risky lines highlighted, a reviewer's comment, an image the agent produced) and never rewrites it. When the brief alone gets it across, there is no attachment. (refined by the builder on 2026-10-07 during the PRD review)
- **Briefs are written by Claude Sonnet 5.5 on the company's Bedrock** (`global.anthropic.claude-sonnet-5-5`), using the Bedrock access Claude Code already has on the machine.
- **The builder answers in words, the secretary presses the keys.** The builder dictates with their own software into the card's input box; the secretary maps the sentence to the dialog choice, confirms, and asks back when unsure. Multi-Code does no speech recognition.
- **A brief speaks the user's language of the moment.** It follows the language of the user's latest message in that session: pure English gets English, Chinese or mixed gets Chinese with English technical terms kept. No setting decides it, so whoever is at the keyboard is answered in their own language.
- **The voice is Qwen3-TTS with the Serena voice, served from a GPU server, never generated on the user's Mac.** Locally it peaks at 6–7 GB of memory, too much to ask of a user. Multi-Code calls an OpenAI-shaped speech API with a bearer key; the server is reproducible from `deploy/tts-server/`, and the builder's runs at `https://tts.jasenpan.com`.
- **The voice is optional; the secretary is not.** With no speech server configured, or one that is stopped, unreachable or deleted, Secretary Mode still works and shows the brief as text on the card. Nothing else in the app depends on the server.
- **v1:** Mac audio only, Claude Code and OpenCode sessions (OpenCode added 2026-10-08 at the builder's request, before the first release). Phone delivery follows as its own track; answering OpenCode dialogs in words waits for Milestone 2.

(source: docs/timeline/2026-10-07_voice-secretary-ideation.md, docs/timeline/2026-10-07_voice-engine-hosting.md)
