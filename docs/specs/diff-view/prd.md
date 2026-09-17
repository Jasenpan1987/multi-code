# PRD: Diff View

**Version:** 1.0
**Last Updated:** 2026-09-18
**Status:** draft
**Owner:** Jasen

## Overview

Clicking `View` on a file in the Toolbox's Git section opens a read-only, full-window
diff overlay: the old version on the left, the new version on the right, so what changed
is visible without leaving Multi-Code. Lines in the overlay can be selected, and the
selection can be handed to the running agent as an `@path:start-end` reference in the
compose box — which is what makes the overlay a way to *challenge* a change ("why is this
here", "this is wrong"), not just to read one.

This closes the last gap that still forced a jump to VS Code during ordinary review: the
Git section could already tell the builder *which* files an agent touched, but not *what*
it did to them.

## Background & Context

The Toolbox's Git section (epic `toolbox`, T-002/T-003) lists new / modified / staged
files and polls every 5s. Clicking a row opened the file in VS Code; markdown rows also
carried a `View` tag that renders the file in the Markdown View section (epic
`markdown-view`, P2-002). Neither shows a diff, so reviewing an agent's work meant
switching to VS Code, finding the change, and coming back to type a question about it.

(source: docs/timeline/2026-09-18_diff-view-ideation.md)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Reviews what an agent changed while it is still running, and challenges specific lines |

## User Stories

### Story 1: Two buttons per file row

**As a** Multi-Code user
**I want** each Git file row to offer both "show me the diff" and "open it in VS Code"
**So that** the common case (look at the change) is one click, and the editor is still one click away

**Acceptance Criteria:**
- [ ] Every file row in the Git section shows a `View` tag and a `Go To` tag, in that order, before the status letter
- [ ] `View` opens the diff overlay for that file
- [ ] `Go To` opens the file in VS Code — the same behaviour the whole-row click had (`openInVSCode(absPath, cwd)`, project root passed so VS Code reveals it in the project window)
- [ ] The row itself is no longer a single click target for VS Code; clicking dead space in the row does nothing
- [ ] Markdown rows additionally show an `MD` tag, first, which opens the file in the Markdown View section — the behaviour previously bound to the `View` tag
- [ ] All tags are keyboard-reachable (each is focusable and responds to Enter / Space)
- [ ] Tags stay within the row on a narrow toolbox column; a long filename truncates rather than pushing them out of view

**Notes:**
- The rename matters for consistency: after this, `View` means "diff overlay" on every row, for every file kind.

---

### Story 2: The overlay is read-only and easy to dismiss

**As a** Multi-Code user
**I want** the diff to open over the app and close without ceremony
**So that** looking at a change never risks changing one

**Acceptance Criteria:**
- [ ] The overlay covers the app window (modal), with the file's repo-relative path in its header
- [ ] An `×` in the top-right closes it; `Esc` also closes it
- [ ] Clicking the backdrop outside the diff panel closes it
- [ ] Nothing in the overlay can modify the working tree, the index, or the file — no stage, unstage, revert, discard, or edit affordance exists
- [ ] While the overlay is open, the terminal keeps running and receives no keystrokes typed into the overlay
- [ ] Closing the overlay returns keyboard focus to the terminal
- [ ] The overlay is per-view, not per-instance state: it is closed on open of the app, and switching the selected instance closes it

**Notes:**
- Read-only is a hard property, not a default. It is what makes the feature safe to use on a repo an agent is actively writing to.

---

### Story 3: Side-by-side diff of the working change

**As a** Multi-Code user
**I want** the old and new versions aligned side by side with the changed lines marked
**So that** I can see exactly what an agent did

**Acceptance Criteria:**
- [ ] Two columns: old version (left), new version (right)
- [ ] Each side shows its own line numbers, matching the real line numbers in that version
- [ ] Added lines are marked on the right with an add treatment and no left counterpart; removed lines are marked on the left with a remove treatment and no right counterpart; a replaced line shows old on the left and new on the right in the same visual row
- [ ] Unchanged context lines appear on both sides, aligned
- [ ] The whole file is shown, not just a few lines of context around each hunk
- [ ] Both columns scroll together vertically
- [ ] Long lines do not break the alignment between the two columns
- [ ] The diff is fetched once when the overlay opens for a file; the Git section's 5s polling does not re-fetch or re-render it underneath the user

**Notes:**
- Whole-file context (rather than 3-line hunks) is what makes it feel like an IDE view and is what lets a line reference be trusted — the right-hand line numbers are the file's real line numbers.

---

### Story 4: The right diff for each file state

**As a** Multi-Code user
**I want** `View` to show the change that the row is telling me about
**So that** a row in "Staged" and a row in "Modified" don't show me the same thing

**Acceptance Criteria:**
- [ ] A row under **Modified** shows the unstaged change: working tree vs the index (`git diff -- <path>`)
- [ ] A row under **Staged** shows the staged change: index vs `HEAD` (`git diff --cached -- <path>`)
- [ ] A row under **New** (untracked) shows an empty left side and the whole file on the right, every line marked as added
- [ ] A deleted file shows the old content on the left, every line marked as removed, and an empty right side
- [ ] A renamed file shows the diff against the old path, with both paths in the header
- [ ] The overlay header states which comparison is being shown, in words (e.g. "working tree vs index")
- [ ] A file that appears under both Modified and Staged opens the diff belonging to the row that was clicked

**Notes:**
- ⚠️ Assumption: the builder wants the row's own truth, not a merged "everything since HEAD" view. Consistent with the Git section, which already lists such a file twice.

---

### Story 5: Selecting lines

**As a** Multi-Code user
**I want** to click a line or select a run of lines
**So that** I can point at the exact code I want to ask about

**Acceptance Criteria:**
- [ ] Clicking a line selects that single line, on either side, and the selection is visibly marked
- [ ] Shift-clicking another line extends the selection to a contiguous range covering both
- [ ] Click-and-drag across lines selects the range
- [ ] Clicking a selected line when it is the only one selected clears the selection
- [ ] The header (or a bar near it) shows the current selection as the reference that would be inserted, e.g. `@src/main/git-diff.ts:12-30`
- [ ] The selection survives scrolling and is cleared when the overlay closes
- [ ] Ordinary text selection (drag to select characters, ⌘C to copy) still works for copying code out of the diff

**Notes:**
- Line selection and text selection are different gestures on the same surface. Text copy must not be sacrificed to line selection — a diff you can't copy out of is worse than one you can't reference.

---

### Story 6: Asking the agent about the selection

**As a** Multi-Code user
**I want** one action that puts the selected lines into the compose box as a reference
**So that** I can type the question and send it to the agent that made the change

**Acceptance Criteria:**
- [ ] With a selection active, an "Ask agent" action is enabled in the overlay
- [ ] Triggering it closes the overlay, opens the compose box for the selected instance, and inserts `@<repo-relative-path>:<start>-<end> ` followed by a space, with the cursor after it, ready for the question
- [ ] A single-line selection inserts `@<path>:<line>` (no range)
- [ ] Line numbers in the reference are the **new** version's line numbers (the file as it is on disk)
- [ ] A selection consisting only of removed lines (which have no new-version line number) inserts the nearest surrounding new-version line, and the overlay says so rather than silently inserting a wrong number
- [ ] If the compose box already holds a draft, the reference is appended to it — the draft is not replaced
- [ ] The action is disabled, with a reason, when the instance is not running (the compose box only targets a running instance)
- [ ] Asking twice in a row appends two references rather than duplicating one

**Notes:**
- Decided in ideation: the reference carries a path and line range, not the code. The agent reads the file itself. Named trade-off: the agent sees the current file, not the "before" side — for a "why did you change this" question it may run `git diff` itself.
- The compose box is the existing Cmd+L overlay (`ComposeBox.tsx`), which already sends `@<path>` refs to both backends.

---

### Story 7: Files that can't be shown

**As a** Multi-Code user
**I want** a clear message instead of a broken view
**So that** a binary or enormous file doesn't look like a bug

**Acceptance Criteria:**
- [ ] A binary file shows "Binary file — no diff to show" and no columns
- [ ] A file whose diff exceeds the size limit shows "Diff too large to show (<n> lines) — open it in your editor" with the `Go To` action still available
- [ ] A file with no change against its comparison shows "No changes"
- [ ] A file that has disappeared from disk since the last poll shows "File not found"
- [ ] A `git` failure shows a single-line error inside the overlay; nothing crashes the renderer or the main process
- [ ] Every one of these states can still be closed with `×` / `Esc`

## Non-Functional Requirements

- **Performance:** computing a diff must not block the UI thread; the git work happens in the main process. A typical file (<2000 lines) opens without a perceptible wait.
- **Stability:** no diff failure may affect the terminal, the PTY, or git polling. All `git` invocations are guarded and time out.
- **Read-only:** the feature issues only read-only git commands. No `git add`, `checkout`, `restore`, `stash`, or `apply`, in any code path.
- **Aesthetic:** QQ-style, compact, information-dense. Monospace, same font as the terminal, tight line height. Diff colours must work in both themes (light and dark).

## Technical Constraints

- Git work runs in the main process, as `git-status.ts` already does — shell out to `git`, don't add a JS git library.
- No new heavy renderer dependency for diffing. Parse `git diff`'s unified output into aligned line pairs in our own code (a small, unit-testable function).
- Whole-file context comes from asking `git diff` for a large `-U` context rather than stitching hunks together.
- The overlay lives in the renderer as a sibling of the existing app layout, following the pattern of the existing dialogs (`NewInstanceDialog`, `RenameSessionDialog`).
- All styles go in `src/renderer/styles/global.css`, the project's single stylesheet.

## Dependencies

- Existing: `src/main/git-status.ts` (git invocation pattern, cwd resolution), `src/main/ipc-handlers.ts`, `src/renderer/components/GitSection.tsx`, `src/renderer/components/ComposeBox.tsx`, `src/renderer/App.tsx` (compose-open plumbing)
- External: `git` on PATH (already assumed by the Git section)

## Out of Scope

- ❌ Editing, staging, unstaging, reverting, or discarding from the overlay — read-only is a hard property
- ❌ Syntax highlighting (would need a highlighter dependency; diff colours carry the meaning for MVP)
- ❌ Word-level / intra-line diff highlighting
- ❌ An inline (unified) diff mode — side-by-side only
- ❌ Diffing arbitrary revisions, commits, or branches; only the working-tree and index comparisons the Git section already lists
- ❌ Navigating between files inside the overlay (next/previous change) — one file per open
- ❌ Inserting the code itself instead of a path reference (decided against in ideation)
- ❌ Commenting on lines, or persisting selections across opens
- ❌ Diffs for files outside the instance's `cwd`

## Open Questions

See `docs/specs/diff-view/gaps.md`. All questions raised during authoring were resolved
with the builder in the same session; no blockers remain.

## Success Metrics

- Reviewing an agent's change no longer requires switching to VS Code for the common case (qualitative)
- "Ask agent" is actually used to challenge a change, rather than the builder retyping the file path by hand
- The overlay never becomes a way to accidentally modify the repo (zero write paths, verifiable by inspection)

## Changelog

- v1.0 (2026-09-18): Initial draft from the same-session ideation. Three builder decisions baked in: two tags per row (`View` / `Go To`), markdown's old `View` renamed `MD`, and the reference form is `@path:start-end` rather than a code block.
