# OpenCode Support — Open Gaps

These are questions identified during ideation/PRD that need decisions during implementation. None block PRD authoring.

## Open Gaps

| ID | Question | Impacts | Source | Status |
|----|----------|---------|--------|--------|
| G-107 | Should we verify `opencode` is on PATH when the user picks OpenCode in the New Instance dialog? Show a soft warning if not? Currently we silently rely on `claude` being available. | UX | 2026-05-18 ideation | open |
| G-108 | Existing claude instances in `contacts.json` lack a `backend` field. Lazy migration: on load, treat missing field as `"claude"` in memory; the file gets the field next time it's persisted. | Implementation | 2026-05-18 ideation | open |
| G-110 | What does the OpenCode sqlite `message.data` field look like for permission requests? Need to probe the schema/data to design the `permission_request` event. (claude side: probe `permission_request` shape in jsonl too — we currently only handle end_turn). | Implementation | 2026-05-18 PRD | open |
| G-111 | Both backends keep adding rows to their session storage as the agent works. We need to choose a polling cadence that's responsive (~500ms-1s) without being wasteful. claude already uses 500ms; opencode sqlite check is cheap (single indexed query). | Performance | 2026-05-18 PRD | open |
| G-112 | If the sqlite db file is locked when we try to read (opencode has it open in WAL mode), how do we handle? `better-sqlite3` with `readonly: true` should bypass; verify in implementation. | Reliability | 2026-05-18 PRD | open |
| G-113 | Are we adding "permission request" sound *now* (in this epic) or v1.1? Builder mentioned it as a desired feature when reconsidering the hook approach, but it's distinct from the core opencode-support scope. | Scope | 2026-05-18 PRD | open |
| G-114 | Multi-step interactive guidance (multiple choice prompts, step-by-step questions, sound on each step) — explicitly out of MVP scope but flagged for v1.1. | Scope | 2026-05-18 PRD | open |

## Resolved during ideation/PRD

- ~~How to detect agent completion across backends~~ → file polling with `CompletionDetector` interface (both backends)
- ~~Should we use claude/opencode hooks~~ → **rejected**. Hooks would write to user config files; uninstalling Multi-Code leaves residue that would call a dead localhost. Zero-residue principle wins.
- ~~How to discover sessionId for an opencode instance~~ → query sqlite `session` table by `directory = <cwd>`, take most recent `time_created`
- ~~Localhost port for hook listener~~ → no longer needed (no hook listener)
- ~~Hook installation user consent flow~~ → no longer needed
- ~~Hook cleanup on Multi-Code crash~~ → no longer needed
- ~~Hook ordering when user has existing hooks~~ → no longer needed
- ~~Bun runtime requirement for opencode plugins~~ → no longer needed
- ~~Plugin file template strategy~~ → no longer needed
- ~~How to distinguish backends in contact list~~ → avatar shape (circle vs square)
- ~~Default backend in New Instance dialog~~ → remember last used
- ~~Quick Actions parity~~ → all 1:1 except Show Cost (opencode disabled)

## Notes for PRD Author

- The shift from hook back to polling means `session-watcher.ts` is **not** being deleted — it's being generalized. PRD should frame the work as "extract polling logic into a `CompletionDetector` abstraction with two implementations" rather than "rewrite session-watcher".
- Builder explicitly named two new sound events ("complete" and "permission requested") during the discussion. Decide in PRD whether both are MVP or just "complete".
