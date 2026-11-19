# Duplicate Options Epic — Gaps

Raised in the 2026-11-20 ideation (`docs/timeline/2026-11-20_duplicate-options-ideation.md`).

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-1105 | Which choices does Duplicate offer? | Fork from the current session, Create new (today's), Create new with the other tool, Cancel. | 2026-11-20 builder |
| G-1106 | Does this ship with session-notes? | Yes, same release. | 2026-11-20 builder |
| G-1107 | Can Claude Code fork into a session id Multi-Code picks? | Yes, per the official changelog: `--session-id` with `--resume` and `--fork-session`. To confirm in QA. | 2026-11-20 docs |
| G-1108 | Can OpenCode 2 fork from the command line? | No. 2.3.0 has no fork flag; its service API has `POST /api/session/{sessionID}/fork`. | 2026-11-20 probe |
| G-1101 | May Multi-Code fork an OpenCode session through the shared service's API? | Yes, as a second exception to "puts nothing into that service", one call per Fork click. Recorded in decisions.md and CLAUDE.md. | 2026-11-20 builder |
| G-1109 | Which session does Fork copy when the terminal has just moved (`/clear`, `/resume`)? | The one on screen, as Claude Code's own fork would: read from the source process's own registry entry only, never the directory's fallback, without changing the contact. | 2026-11-20 builder |
| G-1110 | An OpenCode copy made, then the PTY throws at start: keep a contact for it? | No. The copy stays in OpenCode's own session list; the same throw already fails New, Start and Duplicate today. | 2026-11-20 builder |

## Open Gaps

| ID | Question | Impacts | Ask | Status |
|----|----------|---------|-----|--------|
| G-1102 | Enter forks (Fork has the focus)? | Story 1 | builder | open. Assumed yes |
| G-1103 | Every choice names the copy "X 2", "X 3"? | Naming | builder | open. Assumed yes |
| G-1104 | Fork starts from the latest message only (no "fork from here")? | Out of Scope | builder | open. Assumed yes |
