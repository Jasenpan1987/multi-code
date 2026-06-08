# PRD: Compose Box

**Version:** 1.0
**Last Updated:** 2026-06-08
**Status:** draft
**Owner:** Jasen

## Overview

Add an optional, hotkey-summoned "compose box" overlay for a running **claude** instance.
Instead of typing directly into the CLI's terminal — where pasted/dictated content is collapsed
into `[Pasted text #N]` placeholders and can only be edited with TUI line-editing — the builder
pops up an editable text box, sees every character, fixes typos with the mouse, then presses
Enter to send the whole message to the CLI at once.

The box is **optional and transient**: normal terminal/TUI interaction is unchanged. It is
summoned with **Cmd+L**, sends on **Enter**, and closes afterward, returning focus to the
terminal. It also supports pasting images: a pasted image is saved to a temp file and referenced
via the CLI's native `@<path>` syntax on send, with a visible chip so the builder knows what's
attached.

## Background & Context

The current input flow is: user types into xterm.js → `terminal.onData()` → `writeToInstance`
→ PTY. Pasting (especially after voice dictation) is painful:

- The CLI collapses pasted text into `[Pasted text #N +M lines]` — the actual characters are
  invisible before sending, so typos / transcription errors are only discovered after sending.
- Editing inside a TUI input line means cursor up/down navigation; there is no
  click-to-position-cursor with the mouse.

The builder wants a draft area that is fully visible and mouse-editable **before** sending. The
pain is specifically pre-send visibility — folding after send is acceptable.

An always-on bottom input bar (QQ-style) was considered and rejected: claude is a full-screen TUI
that owns arrow keys, Esc, Ctrl+C, the `/` command menu, `@` completion, Shift+Tab, and history
navigation. Capturing all keyboard input into a textarea would break those. The resolution is an
**optional, hotkey-summoned** box.

(source: docs/timeline/2026-06-08_compose-box-ideation.md)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Heavy voice-input user; composes long prompts and wants to proofread before sending |

## User Stories

### Story 1: Summon and dismiss the compose box

**As a** Multi-Code user
**I want to** pop up a compose box over the current instance with a hotkey, and dismiss it
**So that** I can switch into "draft a message" mode only when I want to, without disrupting normal TUI work

**Acceptance Criteria:**
- [ ] Pressing **Cmd+L** while an instance is selected opens the compose box for that instance
- [ ] The compose box is an overlay anchored to the bottom of the active terminal area (QQ input-bar feel)
- [ ] On open, keyboard focus moves into the box's textarea automatically
- [ ] Pressing **Esc** while the box is open discards its content and closes it
- [ ] On close (whether by send or cancel), keyboard focus returns to the terminal
- [ ] When the box is **closed**, all keyboard input behaves exactly as today (terminal/TUI unaffected)
- [ ] Cmd+L does not leak to the terminal/PTY (no stray characters sent to the CLI)

**Notes:**
- The box is per the **currently selected** instance; only one box is shown at a time.
- One box per instance; switching instances **discards** the in-progress draft (no persistence). See Story 5.

---

### Story 2: Edit text freely with the mouse, then send

**As a** Multi-Code user
**I want to** see and mouse-edit all the text I'm about to send
**So that** I can catch voice-input typos before they reach the CLI

**Acceptance Criteria:**
- [ ] The box contains a multi-line `<textarea>` showing all entered text with no truncation/collapsing
- [ ] The builder can click anywhere in the text to position the cursor and edit (standard textarea behavior)
- [ ] **Enter** sends the current content to the instance and closes the box
- [ ] **Shift+Enter** inserts a newline without sending
- [ ] If content is empty (no text **and** no attached image), Enter does **nothing** (no send, box stays open)
- [ ] A small hint line is visible showing the keybindings (e.g. "Enter to send · Shift+Enter newline · Esc cancel")

**Notes:**
- An attached image counts as non-empty even when there is no text (see Story 4).
- The box composes a single message; it is not a scrollback or history viewer.

---

### Story 3: Multi-line content sends intact

**As a** Multi-Code user
**I want to** send multi-line text as one message
**So that** the CLI receives the whole thing as a single turn

**Acceptance Criteria:**
- [ ] Sending multi-line content delivers all lines to the CLI as a single message (one turn, not N turns)
- [ ] Newlines within the composed text are preserved as line breaks in the CLI input, not treated as submit
- [ ] After send, the terminal shows the content (it is acceptable that long content folds into the CLI's native `[Pasted text #N +M lines]` placeholder)
- [ ] Verified behavior against a running claude instance with a 3+ line message

**Notes (validated mechanism, for kanban):**
- ✅ Validated on claude 2.1.165: `\n` (0x0A) inserts a newline and NEVER submits; only `\r` (0x0D) submits. So multi-line text is inherently safe.
- ✅ Send sequence: wrap payload in `\x1b[200~ … \x1b[201~`, then send `\r` **separately** to submit. The bracketed-paste wrap gives the native folding UX for long content (without it, long content splatters into the input box). Do not put `\r` inside the paste markers.
- ✅ claude's handshake enables `?2004h` — it expects bracketed-paste-wrapped pastes.

---

### Story 4: Paste an image into the compose box

**As a** Multi-Code user
**I want to** paste a screenshot into the compose box and have the CLI receive it
**So that** I can include images in my prompt the way native Claude Code does, but with visible confirmation of what I attached

**Acceptance Criteria:**
- [ ] Pasting an image (Cmd+V with an image on the clipboard) into the box does NOT dump raw data into the textarea
- [ ] The pasted image is saved to a temp file by the app (renderer has no fs access → goes through a main-process IPC)
- [ ] The box shows a visible chip/indicator per attached image (filename or thumbnail)
- [ ] On send, each attached image is referenced to the CLI via its native `@<temp-path>` syntax, spliced into the message
- [ ] On cancel (Esc), temp files created for that draft are cleaned up
- [ ] Temp files **survive** a successful send (the CLI reads them while processing the message)
- [ ] Pasting plain text continues to go into the textarea as normal
- [ ] If the clipboard has no image when an image paste is attempted, nothing breaks (graceful no-op)

**Notes (validated, for kanban):**
- ✅ Validated on claude 2.1.165: `@<path>` (relative or absolute) is treated as a real image attachment via the vision channel, not as text. Real submit of `@probe-red.png what color` returned `Read probe-red.png` and correctly answered "solid red".
- ⚠️ Why `@path` and not clipboard passthrough: the CLI reads images from the OS clipboard itself (image bytes never flow through the PTY — confirmed from the binary, `G47()`). Clipboard passthrough is fragile in a draft-first flow because the clipboard may change between paste and send. Temp-file + `@path` is controllable and lets the builder see what's attached.
- Supported image types per the CLI: png/jpeg/gif/webp/bmp. MVP saves as PNG.

---

### Story 5: One box per instance, draft discarded on switch

**As a** Multi-Code user
**I want** each instance to have its own compose box, and switching instances to discard the draft
**So that** I don't accidentally send one instance's draft to another

**Acceptance Criteria:**
- [ ] The compose box belongs to the currently selected instance
- [ ] Switching to a different instance while a draft is open **discards** that draft (text and any attached image temp files cleaned up)
- [ ] Returning to the original instance shows an **empty** box (no restored draft)
- [ ] Drafts are not persisted across app restarts

**Notes:**
- Deliberately simple: transient, no draft persistence. Avoids the complexity of per-instance draft state.

---

## Non-Functional Requirements

- **Performance:** Opening/closing the box and sending must not introduce visible terminal I/O lag.
- **Stability:** Failure to read/save a clipboard image must not crash the app or corrupt the textarea; the text portion should still send.
- **Aesthetic:** Match the existing QQ-inspired style; the box should feel native to the app, anchored at the bottom of the terminal, compact and information-dense.
- **Non-intrusive:** When unused, zero behavioral change to existing terminal/TUI interaction.

## Technical Constraints

- claude backend only for MVP (OpenCode out of scope — its behavior is not validated).
- Reuse the existing `writeToInstance` (pty-input) IPC for sending — no changes to the main-process send path.
- A new main-process IPC is required only to save the clipboard image to a temp file (renderer has no fs/clipboard-image access).
- No new heavy dependencies; use Electron's built-in `clipboard` API for image extraction.
- Zero-residue principle stays intact — temp files live in the OS temp dir only; no CLI config modification.

## Dependencies

- Existing: `TerminalView.tsx` (terminal + `writeToInstance`), `preload.ts`, `ipc-handlers.ts`, `shared/types.ts`, App-level knowledge of the selected instance.
- Electron `clipboard` and Node `os`/`fs` (main process) for temp-file image save.

## Out of Scope

- ❌ OpenCode support (claude only for MVP)
- ❌ Always-on bottom input bar (rejected — would break TUI interaction)
- ❌ Capturing/redirecting normal keyboard input through the box (opt-in via hotkey only)
- ❌ Per-instance persisted drafts across instance switches or app restarts
- ❌ Instance-not-ready guard (trust page / ~4s boot) — edge case, not handled
- ❌ Rich text / markdown preview inside the box (plain textarea)
- ❌ Editing or re-ordering already-sent messages
- ❌ Clipboard-passthrough image paste (chose temp-file + `@path`)
- ❌ Image editing/annotation before send
- ❌ Eliminating the CLI's `[Pasted text #N]` folding after send (folding is acceptable)

## Open Questions

See `docs/specs/compose-box/gaps.md`. All blockers from ideation were resolved (scope, hotkey,
image strategy) or validated against real claude (multi-line send, `@path` images). No open
blockers remain for MVP.

## Success Metrics

- Builder uses the compose box for voice-dictated prompts and catches/fixes a typo before sending (the core pain it solves).
- Multi-line and image messages arrive at the claude CLI intact and as a single turn.
- Zero regressions in normal terminal/TUI interaction when the box is not summoned.

## Changelog

- v1.0 (2026-06-08): Initial draft from compose-box ideation. Technical assumptions (multi-line send via `\r`/`\n` + bracketed paste, `@path` image attachment) validated against real claude 2.1.165 before writing.
