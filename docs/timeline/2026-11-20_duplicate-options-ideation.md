# Duplicate options — ideation

**Date:** 2026-11-20
**Type:** ideation
**Participants:** Jasen (builder), Claude
**Source:** (verbal, builder-described, in session), plus read-only probes of both CLIs
**Outcome:** new epic `docs/specs/duplicate-options/`, to ship in the same release as
`session-notes`

## The ask

Right-click → "Duplicate…" today starts a second contact on the same project in a fresh
session. What the builder actually wants most of the time is a fork: a new session that
starts from the current session's conversation. The builder likes today's behaviour too,
so Duplicate should ask:

1. Fork from the current session
2. Create new (today's behaviour)
3. Create new with the other tool: from an OpenCode session, a new Claude Code session;
   from a Claude Code session, a new OpenCode session ("就是用另一个工具打开")
4. Cancel

The builder also called session-notes done ("这个功能就算做完了") and asked for this in the
same version.

## What the CLIs offer (probed 2026-11-20, read-only)

- **Claude Code 2.1.328:** `claude --resume <id> --fork-session` copies the history into a
  new session id and leaves the original unchanged. The official changelog says
  `--session-id <uuid>` can name the copy when combined with `--resume` and
  `--fork-session`, so Multi-Code can know the new session's id before it starts.
  (source: code.claude.com/docs/llms-full.txt)
- **OpenCode 2.3.0:** no fork flag on the command line (`opencode --help`,
  `opencode session --help`: list, delete, export, import). The shared background service's
  API has `POST /api/session/{sessionID}/fork`, body `{ before?: messageID | null }`,
  read from the service's own `/openapi.json`. Its database already has
  `fork_session_id` and `fork_boundary` columns. A terminal can then attach to the new
  session with `opencode --session <id>`, as Multi-Code does today.

## Open point raised to the builder

Forking an OpenCode session means Multi-Code calls the shared service's API to create a
session. The architecture rule says Multi-Code puts nothing into that service; the only
exception so far is answering dialogs by request id (decisions.md, 2026-10-16). This needs
the builder's call (G-1101).
