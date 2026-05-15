# PRD: Multi-Code MVP

**Version:** 2.0
**Last Updated:** 2026-05-15
**Status:** draft
**Owner:** Jasen Pan

## Overview

Multi-Code is a desktop application that manages multiple Claude Code CLI instances in one place. The UI is inspired by classic QQ (early 2000s era) — a contact list on the left, a terminal view on the right. Users create new Claude Code instances from within the app, switch between them freely, and get notified when any instance has new output.

The app is essentially a **terminal multiplexer with a QQ skin**. Under the hood it spawns real `claude` CLI processes via `node-pty`, giving full terminal fidelity (ANSI colors, clickable elements, permission prompts, tabs — everything Claude Code supports).

## Background & Context

Programmers frequently work across multiple projects simultaneously, each needing its own Claude Code instance. The core pain points are:
1. Context contamination when accidentally switching between terminal windows
2. No unified view of all active AI sessions
3. Missing AI responses because attention is on another window

(source: docs/knowledge/business-overview.md)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Primary users | Programmers / technical workers | Manage multiple Claude Code sessions daily |
| Team members | Jasen's dev team | Initial beta testers |
| Open source community | Global developers | Future users and contributors |

## User Stories

### Story 1: Create a new Claude Code instance
**As a** programmer
**I want to** click "New Instance", enter a project path, and have a Claude Code session start in that directory
**So that** I can quickly spin up AI sessions for any project from one place

**Acceptance Criteria:**
- [ ] "New Instance" button in the UI
- [ ] Dialog to input the project root path (or folder picker)
- [ ] App spawns `claude` CLI process with `cwd` set to the given path
- [ ] New instance immediately appears in the contact list
- [ ] The Claude Code process runs in the project directory (all commands execute there, not in the app's directory)

**Notes:** Uses `node-pty` to spawn the process, giving us full PTY control (stdin/stdout/terminal signals).

### Story 2: Instance naming and alias
**As a** programmer
**I want to** give each instance a custom alias, and be forced to name duplicates
**So that** I can easily distinguish between instances

**Acceptance Criteria:**
- [ ] Default name = project directory name (e.g., `admin-msk`)
- [ ] User can set an alias on any instance (click to rename)
- [ ] If opening a second instance in the same project directory, system prompts user to provide an alias (mandatory)
- [ ] Alias displayed in the contact list as the instance name

**Notes:** Alias is optional for the first instance of a project, mandatory for duplicates.

### Story 3: Classic QQ-style contact list UI
**As a** programmer
**I want to** see all my instances in a classic early-2000s QQ contact list layout
**So that** the interface is familiar, simple, and distraction-free

**Acceptance Criteria:**
- [ ] Left panel: contact list with avatar/icon, instance name (or alias), status (running/stopped)
- [ ] Right panel: full terminal view for the selected instance
- [ ] Visual style references classic QQ 2003-2005 (compact list, small avatars, simple color scheme, no modern bloat)
- [ ] Running instances show active status; stopped ones are greyed out
- [ ] List sorted by: running first, then by most recent activity

**Notes:** Think QQ 2003-2005 aesthetic. Compact, information-dense, no unnecessary whitespace.

### Story 4: Terminal view with full fidelity
**As a** programmer
**I want to** click an instance and see its full terminal output with all interactive features preserved
**So that** it works exactly like I opened Claude Code in a real terminal

**Acceptance Criteria:**
- [ ] Right panel renders a full terminal (xterm.js)
- [ ] Supports ANSI colors, cursor movement, clickable links
- [ ] All Claude Code interactive features work: permission prompts, tab completion, clickable elements
- [ ] Auto-scrolls to bottom on new output
- [ ] Input goes directly to the terminal (stdin) — no separate input box needed

**Notes:** This is a real embedded terminal, not a "chat view". The user types directly into it just like a normal terminal. We use xterm.js which handles all terminal rendering and input natively.

### Story 5: Notifications on new output
**As a** programmer
**I want to** be alerted when a non-focused instance has new output
**So that** I never miss an AI response from any project

**Acceptance Criteria:**
- [ ] Contact avatar flashes/blinks when the instance produces output while not selected (like classic QQ message notification)
- [ ] Notification sound (configurable on/off)
- [ ] macOS system notification
- [ ] Unread indicator on the contact item (clears when selected)

**Notes:** "New output" = any new data written to the PTY stdout of that instance while it's not the active/focused one.

### Story 6: Instance lifecycle (online/offline)
**As a** programmer
**I want to** see when an instance stops or crashes
**So that** I know which sessions are still active

**Acceptance Criteria:**
- [ ] When the `claude` process exits (normal exit or crash), instance shows as "offline"/greyed out
- [ ] User can restart a stopped instance (re-spawn in same directory)
- [ ] User can remove/dismiss a stopped instance from the list
- [ ] Running instances show uptime or last activity time

## Technical Architecture

```
┌─────────────────────────────────────────────┐
│  Electron App                                │
├──────────────┬──────────────────────────────┤
│  Contact     │  Terminal View (xterm.js)     │
│  List        │                              │
│              │  ┌──────────────────────┐    │
│  instance-1  │  │ $ claude             │    │
│  instance-2  │  │ > How can I help?    │    │
│  instance-3  │  │ ...                  │    │
│              │  └──────────────────────┘    │
└──────────────┴──────────────────────────────┘
        │                    ▲ ▼
        │              node-pty (spawn)
        │                    │
        ▼                    ▼
   State management    claude CLI process
   (which instances    (cwd: /project/path)
    are running)
```

**Key tech decisions:**
- `node-pty`: Spawns Claude Code with a real PTY — full terminal fidelity
- `xterm.js`: Renders terminal in the Electron renderer process — handles all ANSI codes, clicks, etc.
- No history storage, no message parsing — just raw terminal I/O piped to the UI

## Naming Strategy

1. **Default:** Directory name from the project path (e.g., `admin-msk`)
2. **Optional alias:** User can rename any instance at any time
3. **Duplicate enforcement:** If same directory already has a running instance, user must provide an alias for the new one

## Non-Functional Requirements

- **Performance:** UI response < 100ms, terminal rendering smooth at high output rates
- **Security:** Zero data transmitted externally; all communication is local-only
- **Scalability:** Handle 10+ simultaneous instances smoothly
- **Accessibility:** Keyboard navigation, hotkeys to switch between instances (e.g., Cmd+1/2/3)
- **Resource usage:** Memory < 200MB (excluding Claude Code processes themselves)

## Technical Constraints

- Framework: Electron
- Frontend: TypeScript + React
- Terminal: xterm.js + node-pty
- macOS only (initial version)
- Claude Code must be installed on the user's machine (`claude` command available in PATH)

## Dependencies

- `claude` CLI available in the user's PATH
- `node-pty` compatibility with macOS + Electron
- `xterm.js` for terminal rendering

## Out of Scope

- Discovering externally-started Claude Code instances (not launched by this app)
- Built-in AI chat (this is NOT another Claude client)
- Team collaboration features
- Windows/Linux support (MVP phase)
- Custom AI model integration
- Conversation history persistence/storage
- Auto-accept permission mode ("dangerously mode" — future feature)

## Open Questions

None — all technical blockers resolved.

## Success Metrics

- Users can manage 5+ Claude Code instances from one window without confusion
- Zero missed AI responses (notification system works)
- Terminal fidelity: everything that works in a real terminal works in Multi-Code
- App resource usage stays under 200MB (excluding spawned processes)

## Changelog

- v2.0 (2026-05-15): Major rewrite. Simplified architecture — app spawns its own `claude` processes via node-pty. Removed auto-discovery of external instances. Added xterm.js for full terminal fidelity. Removed Agent SDK dependency. Removed all open questions (resolved). Added alias/naming enforcement for duplicate projects.
- v1.1 (2026-05-15): Rewrote to English. Clarified terminal-style UX. Added naming strategy. Confirmed Electron.
- v1.0 (2026-05-15): Initial draft
