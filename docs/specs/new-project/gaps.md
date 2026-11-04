# New Project Epic — Gaps

Raised in the 2026-11-04 ideation (`docs/timeline/2026-11-04_new-project-ideation.md`).

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-702 | What does "make a project that doesn't exist" make? | An empty folder only; no `git init`, no files. | 2026-11-04 builder |
| G-703 | How is the folder made? | With the macOS picker's New Folder button. A typed path that doesn't exist is refused on Create. | 2026-11-04 builder |
| G-704 | Where does clone go in the dialog? | A mode switch at the top: Open folder / Clone from Git. | 2026-11-04 builder |
| G-705 | Where does the builder wait for a clone? | In the dialog, with git's progress and Cancel. | 2026-11-04 builder |
| G-706 | Is the clone's folder name needed? | Optional, empty by default; empty means the repo's name, as `git clone <url>`. Not the same as Alias. | 2026-11-04 builder, mock v1 |
| G-707 | URL forms, branch, existing target, Cancel, login prompts, typed missing path, phone | The 8 defaults in the timeline entry, confirmed together. | 2026-11-04 builder |
| G-708 | Which mode opens first; Esc and outside clicks during a clone; where "Clone into" starts | Last mode used; they do nothing while cloning; last cloned-into folder, else last picked parent, else the newest session's parent. As in mock v2. | 2026-11-04 builder approved mock v2 |

## Open Gaps

| ID | Question | Impacts | Ask | Status |
|----|----------|---------|-----|--------|
| G-701 | Does `git clone` over SSH work from the installed app opened from the Dock (key, agent, `~/.ssh/config`), with the login-shell environment? | Story 3; if not, every private clone fails | Builder's test of the installed build | open |
