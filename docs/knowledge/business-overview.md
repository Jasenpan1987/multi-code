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
