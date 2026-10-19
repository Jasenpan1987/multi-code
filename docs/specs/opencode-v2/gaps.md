# Gaps: OpenCode 2

| ID | Question | Impact | Ask | Status |
|-------|-------------------------------|--------------------------|-----------------|--------|
| G-601 | Does a TUI plugin named in `OPENCODE_CLI_CONFIG_CONTENT` (a directory with a `tui` entry) load in 2.0.32, see `ui.router.current()`, and get its options? What is the entry file's exact name (`tui.js`?) | Story 4 has no other way to know the shown session | Spike T-601 | open |
| G-602 | Can an isolated OpenCode 2 (scratch XDG dirs, own service port) run real turns with OpenCode's free models, without a login? | Spike and QA need real turns; the alternative is the builder's own providers | Spike T-601; builder if it needs a login | open |
| G-603 | Order and timing of events for each scenario (finish, error, Esc, Reject with and without reason, dismiss, subagent dialog, `always`, service replacement). In particular: does `permission.replied{reject}` arrive before `execution.interrupted{shutdown}`? | Story 3's rules and the test fixtures | Spike T-601 | open |
| G-604 | Should Multi-Code start the shared service itself, from a clean env, when none is running, so its terminal never donates `MULTICODE_*` and `OPENCODE_CLI_CONFIG_CONTENT` to it? Or is that leak harmless enough to accept? | Story 10 | Spike T-601 decides, logged | open |
| G-605 | Does the TUI push `MULTICODE_*` and `OPENCODE_CLI_CONFIG_CONTENT` into the agent's shell env (per-session environment), and does that matter (a nested `opencode` in the agent's shell)? | Story 10 | Spike T-601 | open |

## Resolved

| ID | Question | Resolution | Evidence |
|-------|-------------------------------|--------------------------|-----------------|
| G-606 | Support 1.x and 2.x together if it's cheap? | No. It isn't cheap: two plugin APIs, two event vocabularies, two table sets, two dialog key maps, each OpenCode change measured twice. 2.x only | Builder, 2026-10-16; re-checked 2026-10-20 (docs/timeline/2026-10-16_backend-expansion-research.md) |
| G-607 | Alert when a stopped contact's turn finishes or needs the builder in the background? | No. A stopped contact stays silent; the next start reopens the session with the result | Builder, 2026-10-20, in session |
| G-608 | Stop: close the terminal only, or also interrupt the turn? | Close the terminal only, as VS Code does | Builder, 2026-10-16 (decisions.md) |
