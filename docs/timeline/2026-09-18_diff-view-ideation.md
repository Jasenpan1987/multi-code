# Diff View — ideation

**Date:** 2026-09-18
**Participants:** Jasen (builder), Claude
**Outcome:** new epic `docs/specs/diff-view/`

## The ask

In the Toolbox's Git section, clicking a changed file should open a VS Code-style diff
page: old version on the left, new version on the right, so it's obvious what changed.
Two properties were named up front:

1. **Read-only.** No staging, no reverting, no editing. An × in the top-right closes it.
2. **Selectable, and referenceable.** After clicking a line or selecting a block, the
   selection can be dropped into the compose box as a reference, so the running agent can
   be challenged about it — "why was this changed", "this change is wrong", "this code is
   badly written".

## Decisions taken in this session

**Every file row gets two buttons: `View` and `Go To`.** `View` opens the diff overlay,
`Go To` opens the file in VS Code. Before this, clicking the row itself opened VS Code —
that behaviour becomes an explicit button rather than a whole-row click, because the row
now has two destinations and one of them is the new default reason to click.

**The existing markdown `View` tag is renamed `MD`.** Markdown files already carried a
`View` tag that opens the Toolbox's Markdown View. `View` is now the diff overlay for
every file kind, so the markdown preview keeps its own tag under a new name. A `.md` row
therefore shows three tags: `MD`, `View`, `Go To`. Nothing is lost, and `View` means the
same thing on every row.

**The reference is a path + line range, not the code itself.** Selecting lines and asking
the agent inserts `@src/foo.ts:12-30` into the compose box, not a fenced code block.
Rejected the code-block form on token cost: the agent can read the file itself. The
trade-off was named explicitly — the agent will see the *current* file, not the "before"
side of the diff, so for a "why did you change this" question it may need to run
`git diff` itself.

## Not decided here

Selection ergonomics (click a line, shift-click to extend), the overlay's size, and
whether syntax highlighting is worth it were left to the PRD.
