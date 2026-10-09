# Voice Secretary: how each Claude dialog takes its answer (spike for T-509)

**Date:** 2026-10-10
**Type:** investigation
**Participants:** Claude (driving the real CLI)
**Source:** CLI 2.1.295, Haiku, driven in a PTY by the attention-alerts spike harness
**Outcome:** the key sequences T-509 writes, and how it checks what the CLI recorded

## Summary

Every Claude dialog the secretary answers was driven key by key on 2.1.295 and its screen
read after each key. Digits pick an option at once; "Type something." takes a digit, the
text, and Enter; a multi-select question toggles with digits and moves on from its "Next"
row; a box with more than one question, or one multi-select question, ends on a review page
whose "1. Submit answers" sends it. `PostToolUse` for `AskUserQuestion` carries
`tool_input.answers` (`{question: "Label, Label"}`), the CLI's own record of what was
answered. A whole three-question sequence at 40 ms between keys was answered right; T-509
uses 150 ms.

Reproduce: `.omt/probes/voice-secretary/t509/drive.py` (`uv run --with pyte python3 drive.py
<run> --permission-mode default --setting-sources project,local`) and `ctl.sh <run> <op>
<json>`. `--setting-sources project,local` leaves out the builder's own settings, which
allow `Bash(*)`, `Write(*)`, `Edit(*)`, `WebFetch(*)` and so never raise a permission
dialog; the driver passes their `env` along so Bedrock still works.

## Findings

**Which dialogs the builder actually meets.** With those allow rules, the builder's own
sessions raise permission dialogs only for tools outside them (MCP tools, NotebookEdit),
plus `AskUserQuestion` and `ExitPlanMode`. Question boxes with two or three questions are
the common case.

**Permission, no rule for the tool** (`PermissionRequest` carries `permission_suggestions`):

```
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: curl -sI https://example.com
   3. No
 Esc to cancel · Tab to amend
```

- `1` / `2`: allowed at once; `PostToolUse` follows.
- `3`: the turn ends ("Interrupted · What should Claude do instead?"), the registry is
  `idle` 41 ms later, and **no hook is sent**. "Deny and say why" is `3`, then the reason
  as an ordinary prompt once the CLI is idle.
- A dialog forced by an `ask` rule has only Yes / No (attention-alerts spike), so No is `2`.

**Question box, one single-select question:**

```
 ☐ Button color
 Which color should the button be?
 ❯ 1. Red
   2. Blue
   3. Type something.
 ──────
   4. Chat about this
 Enter to select · ↑/↓ to navigate · Esc to cancel
```

- A digit for an option selects and submits at once; no review page.
- `3` ("Type something.", always option count + 1) focuses its text field; the typed text
  replaces the label; Enter submits. Chinese text types fine.
- "Chat about this" is never pressed.

**Question box, several questions** (tabs `←  ☐ Framework  ☐ Features  ☐ Host  ✔ Submit  →`),
or **one multi-select question** (tabs `☐ Toppings  ✔ Submit`):

- Single-select question: a digit picks and moves to the next question. "Type something."
  is a digit, the text, Enter, which moves on.
- Multi-select question: options are `[ ]` boxes, then `[ ] Type something`, then an
  unnumbered `Next` row (`Submit` on the last question). A digit toggles its box and **the
  cursor stays on row 1**. For text, Down × option count reaches the "Type something" row;
  typing fills it and ticks it. Down once more (or Down × option count + 1 with no text)
  reaches `Next`; Enter moves on.
- Tab from a list row moves to the next question, but inside a text field it only moves
  down a row, so T-509 uses Down and Enter, which behave the same everywhere.
- After the last question: "Review your answers", the answers listed, then `1. Submit
  answers` / `2. Cancel`. `1` sends them.
- Letters typed while the cursor is on an option row (not a text field) were ignored.

**Plan approval** (`--permission-mode plan`):

```
 ❯ 1. Yes, auto-accept edits
   2. Yes, manually approve edits
   3. Tell Claude what to change
      shift+tab to approve with this feedback
```

In auto mode option 1 reads "Yes, and use auto mode" (2026-09-02 record); the positions are
the same. `2` approves and switches the session to manual mode (`PostToolUse`
`ExitPlanMode`, `PostModelSwitch`). `3` focuses a text field; the text and Enter send it
back to planning with that feedback, and a new `ExitPlanMode` dialog follows.
`promptExtract.ts` `PLAN_OPTIONS` had the first two the other way round ("Yes" on key 1,
"Yes, with auto-accept edits" on key 2), so the phone's plain "Yes" picked auto-accept.

**What the CLI records.** `PostToolUse` for `AskUserQuestion`:
`"answers": {"Which framework?": "Vue", "Which features?": "Login, Payments", "Which host?":
"Fly"}`, typed text verbatim, several picks joined by ", " in option order.

**Timing.** Keys sent in one go at 150 ms and at 40 ms apart both gave the right answers
for a three-question box with a multi-select question and typed text in two of them.
