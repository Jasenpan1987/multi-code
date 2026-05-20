# PRD: OpenCode Support

**Version:** 1.0
**Last Updated:** 2026-05-18
**Status:** draft
**Owner:** Jasen

## Overview

Adds OpenCode CLI as a second supported "agent backend" alongside Claude Code. Each Multi-Code instance now picks its backend at creation and is locked to it. Behavior on opencode instances must mirror claude instances as closely as possible — same notifications, same Quick Actions, same session-resume workflow. The architecture is generalized so adding a third or fourth backend in the future requires only a small new module rather than scattered conditionals.

This epic also bundles a small UX enhancement: notifications now also fire when the agent pauses to ask the user for input (permission requests, multiple-choice prompts, etc.), not only when the agent finishes responding.

## Background & Context

Multi-Code's previous positioning was a "Claude Code orchestration hub". Builder uses Claude Code; many of his colleagues use OpenCode. To collaborate on shared projects, Multi-Code needs to manage instances of both backends side by side. The decision was made to generalize Multi-Code into a "general-purpose AI agent orchestration hub" rather than patch in opencode as a special case.

Architecturally, the original plan was to use each backend's official hook system (Claude `Stop` hook, OpenCode `session.idle` plugin event) to receive completion notifications. This was rejected during PRD review because hooks require writing into user configuration files (`~/.claude/settings.json` or per-project equivalents) that would leave stale residue if Multi-Code is uninstalled or crashes — those residual hooks would attempt to call a dead localhost listener and break the user's standalone use of claude/opencode. Multi-Code adopts a strict zero-residue principle: it observes the agents' own state files read-only, never modifying user configuration.

(source: docs/timeline/2026-05-18_opencode-support-ideation.md)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen | Manages multiple Claude Code instances; will start managing OpenCode instances on shared-project days |
| Builder's colleagues | Internal users (alpha) | Some use OpenCode primarily; want Multi-Code to feel native for them too |

## User Stories

### Story 1: Pick backend when creating an instance

**As a** Multi-Code user
**I want to** choose between Claude Code and OpenCode when I create a new instance
**So that** I can work with the agent matching the project's existing convention or my colleagues' setup

**Acceptance Criteria:**
- [ ] The "+ New" dialog has a backend selector with two options: **Claude Code** and **OpenCode** (radio buttons)
- [ ] Default selection is the most recently used backend (persisted across app restarts)
- [ ] First-ever launch defaults to **Claude Code** (matches existing behavior)
- [ ] When the user picks OpenCode and `opencode` is not on PATH, the dialog shows a soft inline warning (not blocking — they can still create the instance, but will see an error in the terminal when it spawns)
- [ ] Once an instance is created, its backend is fixed for life (no UI to change it later)

**Notes:**
- Existing instances in `contacts.json` without a `backend` field are treated as `"claude"` (lazy migration on load; field is added on next persistence write).

---

### Story 2: Same cwd may host instances from different backends

**As a** Multi-Code user
**I want to** create both a Claude Code instance and an OpenCode instance for the same project directory
**So that** I can collaborate with colleagues using a different agent on shared projects

**Acceptance Criteria:**
- [ ] The "+ New" dialog accepts the same cwd even if an instance already exists at that path, **provided the backend is different** (or the user explicitly accepts the duplication)
- [ ] Existing duplicate-cwd warning still applies for same-backend duplicates
- [ ] Both instances run independently — separate sessions, separate notifications, separate Resume Elsewhere outputs

**Notes:**
- If both instances default to the cwd's basename for a name and the user doesn't set aliases, the contact list will show two same-named entries differentiated only by avatar shape. That's acceptable — user's responsibility to set aliases if they want clarity.

---

### Story 3: Backend visible in the contact list

**As a** Multi-Code user
**I want to** see at a glance which backend each instance is using
**So that** I never confuse a Claude instance with an OpenCode instance, especially when they share a cwd

**Acceptance Criteria:**
- [ ] Claude instances render with a **circular** avatar (current behavior)
- [ ] OpenCode instances render with a **square** avatar (new)
- [ ] All other contact-list visual elements (online dot, unread badge, alias) work identically across backends
- [ ] Avatar shape applies anywhere the avatar is shown (contact list, future tooltips, etc.)

**Notes:**
- Color is *not* used to distinguish backends — color is already used by the auto-generated initial color, and shape is more glanceable / colorblind-friendly.

---

### Story 4: Spawn OpenCode and pipe to terminal

**As a** Multi-Code user
**I want** my OpenCode instance to behave like my Claude instances — running in a real terminal, with full TUI fidelity
**So that** the experience is identical to running `opencode` directly in Terminal.app

**Acceptance Criteria:**
- [ ] Selecting an OpenCode instance shows a real PTY-backed xterm with the opencode TUI running
- [ ] All TUI features work: `ctrl+x` shortcuts, `/help`, ANSI colors, file reference `@`, plan/build mode toggle
- [ ] When a fresh instance is spawned the first time in a cwd, opencode is invoked plainly (no `--continue`); subsequent restarts use `--continue` to resume the most recent session in that cwd (mirrors claude behavior)
- [ ] If `opencode` binary is not on PATH, the terminal shows the system error and the instance status becomes `stopped` — same failure path as a missing `claude` binary

**Notes:**
- Spawn uses node-pty exactly like the claude path; the only difference is the binary name and `--continue` semantics.

---

### Story 5: Notification on agent completion (both backends)

**As a** Multi-Code user
**I want to** hear a sound and see a flash whenever any of my agents — Claude or OpenCode — finishes responding
**So that** I can step away from the screen during long runs and not miss completion

**Acceptance Criteria:**
- [ ] When a Claude Code instance reaches `stop_reason: "end_turn"`, the existing notification fires (sound + avatar blink + dock bounce)
- [ ] When an OpenCode instance writes a `message` row with `finish: "stop"` (or its semantic equivalent), the same notification fires
- [ ] Behavior is indistinguishable to the user: same sound, same blink animation, same dock bounce mechanism, same auto-clear-after-1.5s for the currently-selected instance
- [ ] If the agent is mid-tool-call (claude `tool_use` / opencode `tool-calls` finish), no notification fires — just like today
- [ ] Implementation uses **read-only file polling** of the agent's own session storage (jsonl for claude, sqlite for opencode); Multi-Code never modifies the agent's configuration

**Notes:**
- This story explicitly replaces the originally planned hook-based architecture. The user-facing behavior is the same; the implementation differs.

---

### Story 6: Notification when the agent waits for user input

**As a** Multi-Code user
**I want to** hear the same notification sound when the agent stops to ask me something — a permission prompt, a multiple-choice question, or any interactive guidance step
**So that** I know to come back and respond, even if the agent isn't "done" yet

**Acceptance Criteria:**
- [ ] When Claude pauses for a permission request (Bash, file write, etc.), the notification fires
- [ ] When OpenCode pauses for any user input (permission, multi-choice, prompt), the notification fires
- [ ] The same sound is reused (no need to distinguish "complete" vs "waiting for input" — builder explicitly accepted same-sound)
- [ ] For multi-step interactive guidance: only the *appearance* of an input prompt triggers a notification, not each individual step the user clicks through
- [ ] Once the user has interacted with the prompt (typed or clicked anything), no further notification fires until the agent reaches another idle/wait state

**Notes:**
- ⚠️ Implementation needs to probe the actual jsonl / sqlite formats to identify "waiting for input" — current Multi-Code only detects `end_turn`. Probe is a kanban task, not a PRD blocker.

---

### Story 7: Quick Actions parity across backends

**As a** Multi-Code user
**I want** the Quick Actions toolbox section to work the same way regardless of backend
**So that** muscle memory transfers seamlessly between my claude and opencode instances

**Acceptance Criteria:**
- [ ] **Go to Code Base** — works identically (runs `code <cwd>`, no backend dependency)
- [ ] **Clear** — works on both: claude receives `/clear`, opencode receives `/clear` (which opencode treats as alias for `/new`)
- [ ] **Compact** — works on both: both backends accept `/compact` natively
- [ ] **Show Cost** — works on claude (sends `/cost`); on opencode the button is **disabled** with tooltip "OpenCode does not have an inline cost command"
- [ ] **Resume Elsewhere** — copies `claude --resume <id>` for claude instances, `opencode --session <id>` for opencode instances

**Notes:**
- The Show Cost disabling is the only place a backend has a missing capability. Builder accepted this as "tooltip-explained graceful degradation".

---

### Story 8: Read-only observation, zero residue

**As a** Multi-Code user
**I want** uninstalling Multi-Code to leave no trace in claude or opencode
**So that** I can trust the tool to be reversible and non-invasive

**Acceptance Criteria:**
- [ ] Multi-Code does not write any file under `~/.claude/`, `~/.config/opencode/`, `~/.local/share/opencode/`, or any cwd's `.claude/` / `.opencode/` directories
- [ ] Multi-Code does not modify `~/.claude/settings.json` or any opencode config files
- [ ] After uninstalling Multi-Code, running `claude` or `opencode` directly behaves exactly as if Multi-Code never existed
- [ ] Multi-Code's own state lives entirely under `~/.config/Multi-Code/` (existing) and any logs/temp it creates under standard OS app dirs

**Notes:**
- This is a non-functional / architectural requirement, but stated as a story because it was an explicit and important builder decision.

---

## Non-Functional Requirements

- **Performance:**
  - Polling cadence per instance: 500ms (matches existing claude behavior)
  - SQLite reads must be read-only and not block opencode's writes
  - At most one outstanding read per instance per polling tick
- **Reliability:**
  - Polling errors (file missing, sqlite locked) must not crash the instance or app — silent retry on next tick
  - Session storage schema changes in claude/opencode should degrade to "no notification" rather than crash
- **Aesthetic:**
  - Avatar shape change (circle → square for opencode) must match the existing QQ visual style — no harsh edges, retain the avatar size and interior layout

## Technical Constraints

- Must reuse the existing notification pipeline (sound + blink + dock bounce) — no new audio files, no new event channels
- Must reuse existing IPC channels for terminal I/O — opencode uses the same `pty-input` / `pty-output` / `pty-resize` channels as claude
- Backend abstraction lives under `workspace/app/src/main/backends/` (per tech-conventions); per-backend modules implement: spawn, session discoverer, completion detector, resume command builder
- No new heavy dependencies — `better-sqlite3` already exists in the ecosystem if we need it; otherwise shell out to `sqlite3` binary as last resort. Prefer JS library.
- Avatar component must accept a shape prop without breaking existing call sites

## Dependencies

- External: `opencode` CLI must be on PATH for OpenCode instances to run (graceful degradation if missing)
- External: `claude` CLI on PATH (existing dependency, unchanged)
- Internal: existing `process-manager.ts`, `session-watcher.ts`, `Avatar.tsx`, `NewInstanceDialog.tsx`, `QuickActionsSection.tsx`, `contacts.json` schema

## Out of Scope

- ❌ Mid-life backend switching (one instance permanently bound to its backend)
- ❌ Cross-backend session import/export (claude → opencode or vice versa)
- ❌ Different sound for "complete" vs "waiting for input" (builder accepted same-sound)
- ❌ Per-step notification during multi-step guidance (only the *appearance* of the input prompt)
- ❌ Configurable polling interval (hardcoded 500ms)
- ❌ Configurable backend list (only claude + opencode in this epic; future backends are a separate epic)
- ❌ "Hook channel" architecture — explicitly rejected (see background)
- ❌ OpenCode-specific Quick Actions (e.g., `/share`, `/init`, `/themes`) — sticking to the existing 5-button set
- ❌ Visual differentiation beyond avatar shape (no per-backend color, badge, label, etc.)

## Open Questions

See `docs/specs/opencode-support/gaps.md` for the full list and resolution status.

Key items still open after PRD authoring:
- G-110: probe shape of "waiting for input" events in claude jsonl and opencode sqlite (kanban task, not a blocker)
- G-112: handling of sqlite WAL-mode locks (verify in implementation)

## Success Metrics

- Builder can create an OpenCode instance and have it function identically to a Claude instance for the 8 stories above
- Notification sound fires reliably on opencode instances (subjectively "as reliable as claude") — measured against the same QA scenarios used in the toolbox epic
- Adding a hypothetical third backend (e.g., aider) requires modifying only files under `backends/` plus a one-line addition to the avatar shape map and the New Instance dialog options — no scattered conditionals

## Changelog

- v1.0 (2026-05-18): Initial draft from `digest` ideation session. Hook approach was considered then rejected; final architecture is read-only file polling with a `CompletionDetector` abstraction.
