# PRD: Toolbox

**Version:** 1.2
**Last Updated:** 2026-05-16
**Status:** draft
**Owner:** Jasen

## Overview

Add a third column ("toolbox") to the Multi-Code main UI. Each instance has its own toolbox with two MVP sections — Git status and Quick Actions — organized as an accordion (one section expanded at a time). The toolbox accelerates the builder's most common micro-actions during multi-agent work: glancing at git state and triggering common claude commands or jumping to the IDE.

This epic also formalizes Multi-Code's positioning as a **lightweight agent orchestration hub** (vs. an IDE replacement) by introducing the "Resume Elsewhere" action — a one-click handoff from Multi-Code to IDE-integrated Claude Code.

## Background & Context

The current UI is two columns: contact list | terminal. As the builder uses Multi-Code for parallel agent work, gaps emerged:

- No quick way to see "what branch am I on / did I commit yet" without leaving the terminal
- Common claude slash commands (`/cost`, `/clear`, `/compact`) require typing into the focused terminal — friction across many instances
- When deep "edit code while watching the AI" work is needed, switching to a real IDE-integrated Claude Code requires manually copying session IDs

(source: docs/timeline/2026-05-16_toolbox-ideation.md)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Daily multi-agent work; opens 3-5 instances in parallel |

## User Stories

### Story 1: Three-column layout with toolbox

**As a** Multi-Code user
**I want to** see a toolbox panel to the right of the terminal
**So that** I can access per-instance utilities without leaving the main view

**Acceptance Criteria:**
- [ ] When an instance is selected, the toolbox panel is visible on the right
- [ ] Toolbox column has equal width as the terminal column (1:1 ratio)
- [ ] Toolbox state (which section is expanded) is per-instance — switching instances shows that instance's state
- [ ] When no instance is selected, toolbox is hidden (consistent with current empty-state behavior)

**Notes:**
- Layout: `contact list | terminal | toolbox`
- Width is responsive (no manual drag in MVP)
- 1:1 ratio chosen so the Terminal section (T-008) has enough horizontal room for typical command-line use (80+ columns)

---

### Story 2: Accordion-style sections

**As a** Multi-Code user
**I want to** expand only one toolbox section at a time, with the expanded one filling the available vertical space
**So that** I can focus on what I'm looking at and the toolbox scales as more sections are added in the future

**Acceptance Criteria:**
- [ ] Each section has a header that's always visible (collapsed sections show only the header)
- [ ] Clicking a section header expands it and collapses any other expanded section
- [ ] The expanded section fills all available vertical space between collapsed headers
- [ ] On first time selecting an instance, **Git** section is expanded by default
- [ ] Expanded-state is preserved per instance (selecting instance A → switching to B → back to A restores A's expanded section)

**Notes:**
- Accordion model chosen for future extensibility — additional sections can be added without restructuring.

---

### Story 3: Git section displays current state

**As a** Multi-Code user
**I want to** see the current git state of my project at a glance
**So that** I know which branch I'm on, what's modified, and whether I'm ahead/behind the remote

**Acceptance Criteria:**
- [ ] Section displays the **current branch name**
- [ ] Section displays **file counts**: untracked (new), unstaged (modified), staged
- [ ] Section displays **remote status**: ahead/behind counts (e.g., "↑2 ↓0")
- [ ] Section refreshes every **5 seconds** while expanded
- [ ] Polling only runs for the **currently selected instance** (not all instances)
- [ ] Switching to a new instance triggers an **immediate refresh** (don't wait 5s for first display)
- [ ] If `cwd` is not a git repository (no `.git` directly in `cwd`), display "Not a git repository" — **do not search parent directories**
- [ ] If git command fails for any other reason, display "Git unavailable" gracefully

**Notes:**
- Strict cwd check: only the cwd itself is inspected. Subdirectories of a git repo show "Not a git repository" — by design.
- Polling stops when the section is collapsed or the instance is unselected.

---

### Story 4: Quick Actions section with five buttons

**As a** Multi-Code user
**I want to** trigger common actions with one click instead of typing
**So that** I can save keystrokes during multi-agent work

**Acceptance Criteria:**
- [ ] Section displays buttons in a vertical stack, each full-width
- [ ] Buttons render in this order: **Go to Code Base**, **Show Cost**, **Clear**, **Compact**, **Resume Elsewhere**
- [ ] Each button is enabled only when the action is applicable (see individual stories below)

**Notes:**
- Quick Actions are defined as buttons that either trigger system-level actions OR auto-type a slash command into the instance's terminal.

---

### Story 5: "Go to Code Base" button

**As a** Multi-Code user
**I want to** click a button to open my project in VS Code
**So that** I can quickly switch to my IDE when I need to look at or edit code

**Acceptance Criteria:**
- [ ] Button is always enabled when an instance is selected
- [ ] Clicking the button executes `code <cwd>` (using the system `code` command)
- [ ] If VS Code already has the project open, clicking activates the existing window (this is VS Code's natural behavior — relying on it, no detection logic needed in MVP)
- [ ] If VS Code is not installed (`code` command not found), show a non-blocking error: "VS Code not found. Install `code` command from VS Code menu."

**Notes:**
- MVP hardcodes VS Code. Configurable editor support is out of scope for this epic.

---

### Story 6: "Show Cost" / "Clear" / "Compact" buttons

**As a** Multi-Code user
**I want to** click buttons that auto-type common claude slash commands into the terminal
**So that** I don't have to manually type them

**Acceptance Criteria:**
- [ ] **Show Cost** button: types `/cost\r` into the instance's terminal
- [ ] **Clear** button: types `/clear\r` into the instance's terminal
- [ ] **Compact** button: types `/compact\r` into the instance's terminal
- [ ] All three are enabled only when the instance is in the **running** state (not stopped)
- [ ] No app-level confirmation dialog before sending — claude CLI handles its own confirmation if needed
- [ ] After clicking, the terminal becomes the visual focus (so the user sees the result)

**Notes:**
- Implementation will reuse the existing `writeToInstance(id, data)` IPC channel.

---

### Story 7: "Resume Elsewhere" button

**As a** Multi-Code user
**I want to** copy a `claude --resume <session-id>` command to clipboard
**So that** I can hand off this session to IDE-integrated Claude Code or another terminal when I need deeper code work

**Acceptance Criteria:**
- [ ] Button copies the string `claude --resume <session-id>` to the system clipboard
- [ ] After copy, button shows transient confirmation feedback (e.g., text changes to "Copied!" for ~1.5s)
- [ ] If the instance's session-id is not yet known (instance just spawned, watcher hasn't matched the JSONL yet), button is **disabled** with tooltip: "Session not ready — wait a moment"
- [ ] session-id is sourced from the existing session-watcher (already reads `~/.claude/sessions/<pid>.json`)

**Notes:**
- This button is what makes Multi-Code's "lightweight orchestration hub" positioning real — it explicitly defers deep IDE work to other tools.
- The exported command does NOT include `cd <path>`; user is expected to be in (or `cd` to) the project before pasting.

---

### Story 8: Terminal section (real shell PTY)

**As a** Multi-Code user
**I want to** have a real shell terminal embedded in the toolbox, running in the project's directory
**So that** I can run arbitrary shell commands (`git`, `pnpm`, `vim`, etc.) without leaving Multi-Code

**Acceptance Criteria:**
- [ ] Toolbox has a third section "Terminal" after "Quick Actions"
- [ ] Section is empty/lazy until first expanded — opening it the first time spawns a new shell process in the instance's cwd
- [ ] Shell is the user's default shell (`process.env.SHELL`, fallback `/bin/zsh`)
- [ ] Behavior matches Terminal.app: full interactivity, ANSI colors, support for `vim`, paged commands, Ctrl+C, etc.
- [ ] Each instance has its own dedicated shell (per-instance)
- [ ] Shell stays alive when section is collapsed or another instance is selected — switching back resumes the same shell
- [ ] Removing the instance from the contact list kills its shell process
- [ ] When the shell exits (user types `exit`), section shows "Terminal exited" with a Restart action that spawns a fresh shell in the same cwd
- [ ] Visual style matches the main claude terminal (same font, same colors)

**Notes:**
- Implementation parallels (but does NOT share code with) the existing `ProcessManager` for claude. Lifecycle is different: shell is lazy-spawn; claude is eager-spawn.

---

## Non-Functional Requirements

- **Performance:**
  - Git polling: only for selected instance; one `git status` invocation per 5s; should not block the UI thread
  - Toolbox rendering: must not noticeably delay terminal I/O
- **Stability:**
  - Failure of git command must not crash the toolbox or affect terminal operation
  - Failure of `code` command must not crash the app
- **Aesthetic:**
  - Match existing QQ-inspired visual style; toolbox should feel like part of the existing UI, not bolted on

## Technical Constraints

- Must reuse existing IPC channels where possible (e.g., `writeToInstance` for slash command buttons)
- Must reuse existing session-watcher for session-id (no new file watching for this purpose)
- Git operations run in the main process (Node has fs / child_process access; renderer doesn't)
- No new heavy dependencies — prefer shelling out to `git` over a JS git library
- Hardcoded VS Code path — no editor configuration UI

## Dependencies

- Existing: `process-manager.ts`, `session-watcher.ts`, IPC layer
- External: `git` CLI must be on PATH (already a reasonable assumption for target users)
- External: `code` CLI on PATH (graceful degradation if missing)

## Out of Scope

- ❌ Configurable editor (VS Code is hardcoded)
- ❌ Jumping to specific file:line from AI mentions (cut from MVP)
- ❌ "AI-mentioned files" section (cut from MVP)
- ❌ Resizable toolbox column (fixed at 50% of terminal width)
- ❌ File-watching git refresh (using 5s polling)
- ❌ Git operations beyond display (no commit/push/checkout buttons)
- ❌ Toolbox state persistence across app restarts (transient in-memory state is enough)
- ❌ Confirmation dialogs for destructive slash commands (`/clear`, `/compact`)

## Open Questions

See `docs/specs/toolbox/gaps.md` for the full list and resolution status.

All gaps identified in ideation have been resolved during PRD authoring (see `gaps.md` for resolutions). No blockers remain.

## Success Metrics

- Builder uses **Go to Code Base** button at least once per session (qualitative — does it actually replace manual editor switching?)
- Builder uses **Resume Elsewhere** when starting deep code work (validates the "lightweight hub" positioning)
- Git section refreshes don't introduce visible UI lag during typing in the terminal

## Changelog

- v1.0 (2026-05-16): Initial draft from `digest` ideation session
- v1.1 (2026-05-16): Added Story 8 (Terminal section — real shell PTY). Reason: builder requested mid-implementation, after T-001 was done. Decisions: full PTY (not simplified), per-instance, lazy-spawn on first expand, background-persistent across collapses/switches, killed on instance removal, default shell from `process.env.SHELL`.
- v1.2 (2026-05-16): Story 1 — toolbox column width changed from "~50% of terminal width" to "1:1 with terminal". Reason: Terminal section (Story 8) needs more horizontal room for typical command-line use. Already implemented via CSS `flex: 1` on both `.content` and `.toolbox`.
