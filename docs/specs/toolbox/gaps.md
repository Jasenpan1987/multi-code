# Toolbox Epic — Gaps (resolved)

All gaps from ideation were resolved during PRD authoring on 2026-05-16. PRD v1.0 reflects these decisions.

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-001 | Detecting "VS Code already has this project open" | No detection logic. Just run `code <cwd>` — VS Code natively activates an existing window for the same path. | 2026-05-16 PRD |
| G-002 | "Resume Elsewhere" behavior when session-id not yet known | Button disabled with tooltip "Session not ready — wait a moment". | 2026-05-16 PRD |
| G-003 | Toolbox column width — fixed or resizable | **Updated 2026-05-16 (PRD v1.2):** Width = 1:1 with terminal column. Original PRD v1.0 said ~50% of terminal width; revised after T-001 implementation when builder noted Terminal section needs more horizontal room. Still not manually resizable in MVP. | 2026-05-16 PRD v1.2 |
| G-004 | Quick Actions visual layout (5 buttons) | Vertical stack, full-width buttons, in fixed order. | 2026-05-16 PRD |
| G-005 | cwd in subdirectory of git repo | Strict cwd check only — no parent search. Subdirectories of git repos display "Not a git repository". Builder rationale: monorepo subpackage users can tell the difference; no need to be clever. | 2026-05-16 PRD |
| G-006 | Confirmation dialog for `/clear` and `/compact` | No app-level confirmation. claude CLI handles its own confirmation if needed. Trust the user. | 2026-05-16 PRD |
| G-007 | Git polling scope — selected instance or all | Only the **currently selected** instance polls. Switching triggers immediate refresh (don't make user wait 5s). | 2026-05-16 PRD |

## Open Gaps

(none)
