# OpenCode Support — Initial Ideation

**Date:** 2026-05-18
**Type:** ideation
**Participants:** Jasen (builder)
**Source:** (verbal interview via OMT/digest, plus opencode.ai docs research and local opencode CLI inspection)

## Summary

Adds OpenCode CLI as a second supported "agent backend" alongside Claude Code. Reframes Multi-Code's positioning from a Claude Code orchestration tool into a **general-purpose AI coding-agent orchestration hub**. Each instance picks its backend at creation time and is locked to it for life. Notification, session discovery, and completion detection — currently three separate Claude-specific mechanisms — will all be unified onto a single channel: each backend's official hook system (Claude's `Stop` hook + OpenCode's `session.idle` plugin event), POSTing to a localhost HTTP listener inside Multi-Code.

## Key Decisions

- **Product repositioning** — Multi-Code becomes a "general AI agent orchestration hub", not Claude-specific. Decided by builder. Reason: long-term vision; future backends (Cursor / aider / etc.) should slot in cleanly.
- **Per-instance backend lock-in** — backend chosen at creation, immutable for life. Decided by builder. Reason: agent-specific session data isn't interoperable; "switch backend mid-instance" has no real meaning.
- **Backend identification by avatar shape** — claude = circle (existing), opencode = square. Decided by builder. Reason: must be glanceable; same cwd may host both backends simultaneously, color/badge would be too subtle.
- **No automatic alias for duplicate cwd+different-backend** — if two instances share the same cwd and the user doesn't set aliases, the contact list shows two same-named entries. User's responsibility.
- **Behavior parity is mandatory** — "Multi-Code's behavior on opencode must be indistinguishable from claude where possible". Decided by builder. Drove the hook decision below.
- **Notifications are non-negotiable** — completion notifications (sound + flash + dock bounce) cannot be skipped on opencode. Decided by builder. Reason: notifications are Multi-Code's core value prop.
- **Completion detection: file polling, NOT hooks** — claude continues to use jsonl polling under `~/.claude/projects/...`; opencode uses sqlite polling on `~/.local/share/opencode/opencode.db` (read-only). Builder explicitly rejected the hook approach after initial agreement. Reason: hooks require writing to user config files (either `~/.claude/settings.json` or `<cwd>/.claude/settings.json` and the opencode equivalents), which leaves stale residue if Multi-Code is uninstalled or crashes — the leftover hook then tries to POST to a dead localhost port and breaks the user's standalone claude/opencode usage. Polling is purely read-only, so uninstalling Multi-Code means it never existed.
- **Behavioral parity via abstraction, not single channel** — instead of forcing both backends through one hook pipe, abstract a `CompletionDetector` interface with two implementations (jsonl reader for claude, sqlite reader for opencode). Both emit identical higher-level events (`turn_complete`, `permission_request`) so all consumers (notifications, session map, etc.) are backend-agnostic.
- **SessionId discovery: cwd-based scanning** — kept the existing approach (claude scans `~/.claude/sessions/*.json` matching cwd; opencode queries sqlite `session` table by `directory`). No reverse-lookup map needed since polling already knows which sessionId belongs to which instance.
- **Quick Actions mapping** — most are 1:1 across backends:
  - `Go to Code Base` → `code <cwd>` (backend-agnostic)
  - `Clear` → both backends accept `/clear` (opencode treats it as alias for `/new`)
  - `Compact` → both backends accept `/compact` (opencode has it natively)
  - `Resume Elsewhere` → `claude --resume <id>` or `opencode --session <id>` based on backend
  - `Show Cost` → claude only (`/cost`); **disabled on opencode** with tooltip explaining why. The only Quick Action that lacks an opencode equivalent.
- **New Instance dialog** — add a backend selector (radio buttons: Claude / OpenCode). Default selection remembers last-used.
- **contacts.json migration** — existing contacts (no `backend` field) treated as `claude`. No user prompt needed; all existing instances were claude.
- **Epic name** — `opencode-support`. Decided by builder. Reason: describes what's actually being added, not abstract architecture intent.

## Facts Learned

### About OpenCode (from opencode.ai docs and local CLI v1.14.41)

- Binary: `opencode` (single command)
- Continue last session: `opencode -c` or `opencode --continue`
- Resume specific session: `opencode -s <id>` or `opencode --session <id>`
- Default invocation `opencode [path]` launches TUI (analogous to `claude`)
- **Session storage**: SQLite database at `~/.local/share/opencode/opencode.db` (NOT jsonl). Drizzle-managed schema with explicit migrations.
- **Built-in slash commands**: `/connect`, `/compact` (alias `/summarize`), `/details`, `/editor`, `/exit`, `/export`, `/help`, `/init`, `/models`, `/new` (alias `/clear`), `/redo`, `/sessions` (aliases `/resume`, `/continue`), `/share`, `/themes`, `/thinking`, `/undo`, `/unshare`. **No `/cost` command.**
- **Plugin system**: JS/TS plugins in `~/.config/opencode/plugins/` or `<cwd>/.opencode/plugins/`. Plugin exports a function returning a hooks object with an `event` handler. Filter by `event.type === "session.idle"` for "agent finished a turn".
- **Multi-provider**: 75+ LLM providers via Models.dev. Anthropic / OpenAI / Bedrock / Copilot etc. — also explains why builder is interested ("not Anthropic-locked").
- The `message.data` JSON field includes a `finish` field analogous to claude's `stop_reason`: `"stop"` (= `end_turn`), `"tool-calls"` (= `tool_use`).

### About Claude Code hooks (already exists, just rediscovered)

- Configured in `~/.claude/settings.json` or `<cwd>/.claude/settings.json`.
- Event `Stop` fires "when Claude finishes responding" — exact match for what we need.
- Hook stdin includes `session_id`, `cwd`, `transcript_path`, `hook_event_name`. Reverse lookup ready.
- Hook can be a `command` type — runs an arbitrary shell command. We can curl POST to localhost.
- Hook can be `async: true` — non-blocking, important so we don't slow down claude.

## Open Questions

(See `docs/specs/opencode-support/gaps.md`)

## Action Items

- [ ] Builder + AI: write PRD next (`prd` skill)

## New Terms

| Term | Meaning | Example |
|------|---------|---------|
| Backend | Which CLI agent powers an instance | "claude" or "opencode" |
| Hook channel | The architecture of using each backend's official hook to POST to Multi-Code's localhost listener | "the unified hook channel" |
| Notification listener | Localhost HTTP server inside Multi-Code main process that receives POSTs from hooks | port chosen at startup |
| Project-level hook | Hook config written under `<cwd>/.claude/` or `<cwd>/.opencode/`, not user-level | scope: this project only |

## Cut from Scope

- Mid-life backend switching (decided not viable since session data isn't interoperable)
- "Cross-backend session import" (e.g., import claude session into opencode) — out of MVP
- Anti-bloat: no settings UI for editor command, no per-backend cost display, no advanced hook config UI

## Round 1/2 mapping (for traceability)

- Round 1 Q1 → why: builder wants generic agent hub, not Anthropic-locked
- Round 1 Q2 → backend lock-in: A
- Round 1 Q3 → identification: shape (circle/square)
- Round 1 Q4 → use case: cross-project, may include same cwd with different backend
- Round 1 Q5 → core principle: behavioral parity is mandatory
- Round 1 Q6 → non-equivalent features get disabled with tooltip (revised below)
- Round 2 Q1 → notifications must work → initially escalated to hook channel, **subsequently reverted** in PRD-stage review (zero-residue concern). Final: dual file-polling abstracted behind CompletionDetector interface.
- Round 2 Q2 → multi-instance same cwd → naturally supported by per-instance polling (each instance polls its own discovered sessionId).
- Round 2 Q3 → slash command parity (Show Cost is the only opencode-disabled one)
- Round 2 Q4 → keep polling (reverted from drop-polling decision after hook approach was rejected)
- Round 2 Q5/Q6/Q7/Q8 → A/B/A/C as decided
