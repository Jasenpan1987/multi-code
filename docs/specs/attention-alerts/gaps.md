# Gaps: Attention Alerts

| ID | Question | Impact | Ask | Status |
|-------|-------------------------------|--------------------------|-----------------|--------|

## Resolved

| ID | Question | Resolution | Evidence |
|-------|-------------------------------|--------------------------|-----------------|
| G-001 | ⚠️ CONFLICT: the 2026-05-18 zero-residue principle said "no hooks, no plugins, no settings injection", because hooks would have had to be written into the user's own Claude settings. Does hooks-through-`--settings` from Multi-Code's own data folder replace it? | Yes. The principle is now: never write a file the user owns, and an agent run outside Multi-Code behaves as if Multi-Code were not installed. Launch options pointing at `userData` are allowed. Promoted into `docs/knowledge/business-overview.md` (Zero-residue principle) and `CLAUDE.md` (Architecture). Story 1 is unblocked. | Builder, 2026-10-06, in session |
| G-002 | When an agent stops because of an error (rate limit, overloaded, login expired), should it chime like a normal finish? | Yes, the same chime as a normal finish. Story 2's assumption becomes a requirement. | Builder, 2026-10-06, in session |
| G-003 | A background Bash command finishing wakes the agent (a `<task-notification>` turn) and it replies again, so one request can end with two `Stop`s: one when the shell is launched, one after it exits. Story 2 says "exactly one Finished event per request". Should the second one chime? | Yes. The turn the CLI starts when a background shell finishes ends with its own Finished event, the same chime. A shell that never exits (a dev server) never triggers it. Same idea as background subagents: the builder hears about the result. | Builder, 2026-10-07, in session; measured in T-401 (`bg-shell` fixture) |
