# Diff View Epic — Gaps

All gaps were raised and resolved with the builder on 2026-09-18, in the same session as
ideation and PRD authoring. PRD v1.0 reflects these decisions.

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-101 | Clicking a file row already opened VS Code. Does the diff overlay take over the row click, or get its own affordance? | Neither takes the whole row. Each row gets two tags: `View` (diff overlay) and `Go To` (VS Code). The whole-row click target goes away, because the row now has two destinations. | 2026-09-18 builder |
| G-102 | Markdown rows already had a `View` tag opening the Markdown View. Name collision with the diff `View`. | The old one is renamed `MD`. `View` means the diff overlay on every row, for every file kind. A `.md` row shows `MD` / `View` / `Go To`. | 2026-09-18 builder |
| G-103 | What goes into the compose box when lines are selected — the code, or a reference? | A reference only: `@src/foo.ts:12-30`. Rejected the fenced-code-block form on token cost. Named trade-off: the agent sees the current file, not the diff's "before" side, so it may need to run `git diff` itself to answer "why did you change this". | 2026-09-18 builder |
| G-104 | Which comparison does `View` show for a file that is both staged and modified? | The one belonging to the clicked row: Modified → working tree vs index; Staged → index vs HEAD. The Git section already lists such a file twice, so the row is the disambiguator. | 2026-09-18 PRD |
| G-105 | Whole-file context, or hunks with 3 lines of context? | Whole file. It is what makes it feel like an IDE view, and it makes the right-hand line numbers the file's real line numbers, which is what the `@path:start-end` reference depends on. | 2026-09-18 PRD |
| G-106 | Which side's line numbers go into the reference? | The new version's (the file as it is on disk), because that is what the agent will read. A selection of only removed lines has no new-version number, so it falls back to the nearest surrounding new line and says so. | 2026-09-18 PRD |
| G-107 | Syntax highlighting? | Out of scope for MVP. It needs a highlighter dependency, and the diff colours carry the meaning. Revisit if reading the diff turns out to be uncomfortable in practice. | 2026-09-18 PRD |
| G-108 | Line selection vs ordinary text selection on the same surface | Both must work. Line selection is what feeds the reference; text selection is how code gets copied out. A diff you cannot copy from would be worse than one you cannot reference. | 2026-09-18 PRD |

## Open Gaps

(none)
