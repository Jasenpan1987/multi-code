# Compose Box — Ideation

**Date:** 2026-06-08
**Type:** Feature ideation + technical validation
**Participants:** Jasen (builder), AI

## Pain Point

When pasting into a terminal (Claude Code / OpenCode), the CLI collapses the content into a
placeholder like `[Pasted text #N +M lines]` instead of showing the actual characters. This is
painful especially with **voice input**: occasional typos or transcription errors are invisible
until the message is already sent, and editing inside a TUI input line (cursor up/down, no
click-to-position) is clumsy.

Builder wants a "draft / compose" area where:
1. Input lands in a small editable box first.
2. All characters are visible; the builder can click with the mouse to fix text directly.
3. Pressing Enter is what actually sends it to the CLI.

## Key Decisions

**Scope — claude only for MVP.** OpenCode is explicitly out. Its paste/image behavior is not
validated and not in scope this round.

**Form factor — optional pop-up, not always-on.** An always-on QQ-style bottom bar was
considered and rejected: claude is a full-screen TUI that owns arrow keys, Esc, Ctrl+C, the `/`
command menu, `@` completion, Shift+Tab, history nav. Capturing all keyboard input would break
those. Resolution: **optional, hotkey-summoned** box. Normal TUI work is unchanged.

- Summon: **Cmd+L** (L = line/long-text; avoids the terminal's Ctrl+L clear).
- **Enter** = send. **Shift+Enter** = newline. **Esc** = cancel (discard, close).
- One box per instance; switching instances discards the draft (no persistence).
- Empty content (no text AND no image) → Enter does nothing. An attached image counts as
  non-empty even with no text.
- Folding placeholder after send (`[Pasted text #N]`) is **acceptable** — the pain is "can't see
  it BEFORE sending", which the box solves. After-send folding is fine, even cleaner.
- Instance-not-ready protection (trust page, ~4s boot) is **out of scope** — edge case.

**Image paste — self-save temp file + `@path`** (chosen over clipboard passthrough). The CLI
reads pasted images from the OS clipboard itself (image bytes never flow through the PTY —
confirmed from the binary, function `G47()`). Clipboard-passthrough is fragile in a draft-first
flow (clipboard may change between paste and send). So: paste image → app saves a temp file →
shows a chip in the box → on send, splice `@<temp-path>` into the message.

## Technical Validation (real claude 2.1.165, node-pty)

Ran a node-pty probe spawning the real claude TUI. Both assumptions confirmed with PTY-output
evidence. Notable correction to a prior assumption:

**Multi-line send — what actually controls "submit" is `\r` vs `\n`, NOT bracketed paste.**
- `\n` (0x0A) in claude's input box only inserts a newline — it NEVER submits. Verified:
  `AAA` + `\n` + `BBB` placed BBB on line two, token counter stayed `0 (0.0%)`, no agent activity.
- Only `\r` (0x0D, real Enter) submits.
- So the earlier worry ("first newline submits the message") was WRONG. Multi-line `\n` content
  is safe to send as-is.

**Bracketed paste is still used — for the folding UX, not for submit-safety.**
- 8-line content WITH `\x1b[200~ … \x1b[201~` wrap → folds to `[Pasted text #1 +7 lines]`
  (native, clean). WITHOUT wrap → all 8 lines splatter into the input box.
- Correct send sequence: `\x1b[200~` + content + `\x1b[201~`, then send `\r` SEPARATELY to submit.
  Do not include `\r` inside the paste markers.

**Image via `@path` — works, treated as a real image attachment (vision), not text.**
- Typing `@` opens completion; image files get a `+` prefix (vs `*` for agents). `@prob` filtered
  to `+ probe-red.png`; Tab completed it.
- Real submit of `@probe-red.png what color` produced `⎿ Read probe-red.png (74 bytes)` and the
  answer "The image is a solid red" (an 8x8 red PNG). Absolute paths (`@/tmp/xxx.png`) also work.

**Incidental findings affecting implementation:**
- First time in a new cwd, claude shows a trust prompt ("Is this a project you trust? 1. Yes /
  2. No", default 1, `\r` to confirm). Boot → input-box-ready takes ~4s. (Out of scope for the
  box per builder, but relevant context.)
- claude's handshake enables `?2004h` (bracketed paste), `?1004h` (focus), `?2031h` (in-band
  resize) — it expects the frontend to use the bracketed-paste protocol for pastes.
- Key sequences: confirm trust = `\r`; insert newline = `\n`; submit message = `\r`.

(Validation cost was negligible — one short real submit, ~19k tokens. Probe scripts and temp
files cleaned up.)
