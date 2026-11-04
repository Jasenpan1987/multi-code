# Gaps — Compose Box

Tracking open questions for the Compose Box epic. Status: `open` | `resolved` | `deferred` | `validated`.

| # | Question | Status | Resolution / Notes |
|---|----------|--------|--------------------|
| G1 | OpenCode parity for compose box | resolved (out of scope) | MVP is claude-only. OpenCode deferred to a future epic; its paste/image behavior is not validated. |
| G2 | Does multi-line content submit on the first newline? | validated (NO) | Tested on claude 2.1.165: `\n` only inserts a newline, never submits. Only `\r` submits. Multi-line text is inherently safe. |
| G3 | Does bracketed paste matter, and why? | validated | Yes, for folding UX (long content → `[Pasted text #N]`), NOT for submit-safety. Send `\x1b[200~ … \x1b[201~` then `\r` separately. |
| G4 | Does `@<path>` make claude treat a local image as an attachment? | validated (YES) | Tested: `@probe-red.png what color` → `Read probe-red.png` + correct "solid red" answer. Vision channel, not text. Absolute + relative paths both work. |
| G5 | Enter on empty content | resolved | No-op (don't send empty). An attached image counts as non-empty. |
| G6 | Draft on instance switch | resolved | Discard. One box per instance, no persistence. |
| G7 | Image temp-file lifecycle | resolved | Clean up on cancel; survive successful send (CLI must read the file while processing). Files live in OS temp dir. |
| G8 | Cmd+L hotkey conflict | open (low risk) | Chosen to avoid terminal Ctrl+L (clear). Verify no clash with existing App-level key handling during implementation. |
| G9 | Image chip: thumbnail vs filename | deferred | MVP: filename/indicator chip is enough; thumbnail is a nice-to-have. |
| G10 | Instance-not-ready guard (trust page, ~4s boot) | resolved (out of scope) | Builder: don't handle. Edge case — you wouldn't compose a long message into a just-spawned instance anyway. |

## Resolved during ideation / validation

- Form factor: optional hotkey-summoned overlay (NOT always-on bar). — resolved
- Summon key Cmd+L; Enter send; Shift+Enter newline; Esc cancel. — resolved
- Scope: claude only. — resolved
- Image strategy: temp-file + `@path` (NOT clipboard passthrough). — resolved + validated (G4)
- Multi-line send: `\n` safe, bracketed-paste wrap for folding UX, separate `\r` submit. — validated (G2, G3)
- Post-send `[Pasted text #N]` folding is acceptable (pain is pre-send visibility). — resolved
