# PRD: Manager Agent

**Version:** 1.0
**Last Updated:** 2026-09-02
**Status:** draft
**Owner:** Jasen

## Overview

Give Multi-Code a manager agent: one session the user talks to, which drives
every other session on their behalf. The user's role moves up a level — they
state intent ("find out where MSK got to", "get portal-backend reviewed", "that
session is too full, hand it off") and the manager does the dispatching, the
collecting, and the follow-up.

The topology is a star, not a mesh. Sessions do not need to know about each
other and do not talk to each other. Only the manager has a roster, and only the
manager initiates. Peer-to-peer agent messaging was explored and dropped: it
solves a problem the user doesn't have, and it requires every agent to be
mesh-aware.

Cast, in the user's terms: the user is the CTO, the manager is a dev manager, the
sessions are the developers.

## Requirements

### The three things the manager must do

Each one is a capability the Claude Code CLI does **not** provide, which is why
this is built on Multi-Code's own primitives rather than on native cross-session
messaging. See [Why not native messaging](#why-not-native-messaging).

**R1 — Report on a session's progress without disturbing it.**
"How far did MSK get on that thing?" The manager reads the target's transcript
directly. The target agent spends no tokens, loses no turn, and never knows it
was asked. Built on `Backend.readTranscript`
(`workspace/app/src/main/backends/types.ts:127`), which is already backend-
agnostic — Claude reads its session JSONL, OpenCode reads its sqlite db.

**R2 — Dispatch work and collect the result.**
"Have someone review portal-backend, then give the findings to the session
working on it." This is a chain the manager runs on its own:

```
send_task("reviewer", "review portal-backend's diff, write findings to <path>")
wait_for_idle("reviewer")
read_session("reviewer")            → the findings
send_task("portal-backend", "...")  → carrying them
```

The user says one sentence. The manager does four steps.

**R3 — Drive a session's slash commands, specifically `/handoff`.**
When a session's context is nearly full it needs to hand its chain of work to a
fresh session. Two parts: knowing *when*, and doing it.

*Knowing when* is information nothing else in the system has. An agent cannot see
how full its own window is — the `omt:handoff` skill says as much, leaving the
timing to the user. Multi-Code can compute it from the transcript. Verified on
this machine 2026-09-02, from the last `assistant` record of a live session's
JSONL:

```
"usage": {
  "input_tokens": 2,
  "cache_creation_input_tokens": 462,
  "cache_read_input_tokens": 452559,
  ...
}
```

Sum of the three ≈ 453k tokens of context in use. Surfacing this turns the
manager proactive: it can raise "HRR is at 450k, worth handing off" instead of
waiting to be asked.

*Doing it* requires typing into the target's TTY, because a slash command
delivered as text is not executed. `ProcessManager.sendPrompt`
(`process-manager.ts:256`) already writes to a PTY as one bracketed-paste unit.

### R4 — A manager MCP server, scoped to the manager alone

Multi-Code runs a local MCP server and injects it via `--mcp-config` into the
manager instance only. Not into every instance: the tools below are management
authority, and an ordinary project agent has no business holding them.

| Tool | Returns / does | Built on |
|------|----------------|----------|
| `list_sessions()` | alias, cwd, backend, status, context tokens, last activity | Instance map + registry + transcript usage |
| `read_session(alias, limit)` | transcript tail, newest last | `Backend.readTranscript` |
| `send_task(alias, text)` | queue a prompt to that session | `sendPrompt` |
| `run_command(alias, command)` | run one allowlisted slash command | PTY write |
| `wait_for_idle(alias, timeoutMs)` | resolve when the target's turn ends | `CompletionDetector` `waiting` event |

Transport: HTTP bound to `127.0.0.1` on an ephemeral port. **Not** port 6768 —
that one is reachable over Tailscale for the phone, and these tools can drive
arbitrary work in every one of the user's repos. They must never be reachable off
the machine.

### R5 — Safety boundary

The manager can type into other sessions' terminals. That is a real privilege and
needs real limits. Native messaging is explicit that an inter-agent message can't
approve a permission prompt or relay a denied action; we must not open that hole
ourselves just because our channel is the PTY.

**The blocked-target check is the load-bearing one, and it is not theoretical.**
Measured 2026-09-02 (see [Verification log](#verification-log)): a session parked
on a plan-approval dialog received an ordinary text task over `sendPrompt` —
`please review the diff and report findings`, containing no digits and no `y` —
and the write **approved the plan, selected the default highlighted option
`1. Yes, and use auto mode`, and the session then edited a real file.**

That is a path for the manager to grant edit authority the user never gave. It
must be closed before any dispatch tool ships, not after.

- **Every write checks the target's state first.** Before `send_task` or
  `run_command` writes a byte, the target must be `idle` or `busy` — never
  blocked on a dialog. When the detector reports `prompt` (permission box,
  AskUserQuestion, plan approval), the tool refuses and returns "target is
  waiting on a decision from you", naming the instance. An allowlist does **not**
  substitute for this: the payload that caused the escalation above was plain
  prose, not a command.
- **`run_command` takes an allowlist, never free-form keystrokes.** v1 allows
  `/handoff`, `/compact`, `/context`. `/clear` is deliberately excluded: it
  discards context irreversibly and writes nothing down first, where `/handoff`
  lands the work before handing over. Second line of defence, after the state
  check.
- **`run_command` must send two carriage returns.** A leading `/` opens the
  slash-command autocomplete menu, which swallows the first `\r`; only the second
  submits. Verified 2026-09-02 with `/context`. A plain `send_task` needs one.
- **No self-dispatch.** The manager cannot `send_task` or `run_command` its own
  instance.
- **Everything is visible.** Every tool call the manager makes appears in a UI
  activity feed: what it read, what it dispatched, to whom, when. The user
  authorised the manager to act without per-action approval, on the condition
  that nothing is invisible.

### R6 — The manager instance

- A contact like any other, flagged as the manager. One per app.
- `cwd` defaults to `~/.config/Multi-Code/manager/`, so it has somewhere to keep
  notes without polluting a repo.
- Role guidance lives in a `CLAUDE.md` inside that directory rather than in an
  `--append-system-prompt` flag: user-editable, survives our releases, loaded
  automatically.
- `--add-dir` for each managed project, so it can read code when a question needs
  more than a transcript.
- Spawned with `--mcp-config` pointing at R4's server.

### R7 — Context usage in the UI

Independently useful, and a prerequisite for R3. Show each contact's context
usage in `ContactList`. Computed from the transcript's newest `usage` record:
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.

## Why not native messaging

The previous draft of this spec concluded that Claude Code's native
cross-session messaging (`ListAgents` / `SendMessage`, on by default from
v2.1.224, v2.1.248+ on Bedrock) made a custom layer redundant. For a peer mesh of
Claude sessions, that holds. For this feature it does not, on four counts:

| Need | Native | Ours |
|------|--------|------|
| Read a session's progress | Impossible by design — a message carries text, "never the sender's conversation history or files". Asking costs the target a turn. | Read the transcript; target undisturbed |
| Trigger `/handoff` | Impossible by design — "a command in the message's text, such as `/compact`, arrives as plain text. Claude Code never executes it." | PTY write |
| See context usage | Not exposed at all | Computed from transcript `usage` |
| Cover OpenCode sessions | Not possible — OpenCode isn't a Claude Code session and doesn't register in `~/.claude/sessions/` | Backend-agnostic: `readTranscript` + PTY |

The user runs a mix of Claude Code and OpenCode, which makes the last row
decisive on its own.

This is not a reversal of the earlier "don't rebuild what the CLI gives you"
call. That call rejected building a *duplicate messaging layer for every agent*.
This builds a *management layer for one agent*, over capabilities the CLI has no
equivalent for.

Native messaging stays available as a later addition: if the fleet is ever
all-Claude, sessions could use `SendMessage` to report to the manager
unprompted, making the star bidirectional. Out of scope for v1.

Also rejected, recorded so it isn't revisited: **Agent Teams**
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). One team per session, teammates spawned
and owned by a lead, lead fixed for its lifetime, in-process teammates don't
survive `/resume`. Multi-Code's model is N independent long-lived sessions, one
per project. Wrong shape.

## Out of scope for v1

- Peer-to-peer messaging between project sessions.
- Native `ListAgents` / `SendMessage`, in either direction.
- Cross-machine and cloud sessions.
- Standing automation rules ("A finishes → always notify B"). The manager is the
  automation; a rule engine underneath it is a separate feature.
- Multiple managers, or a manager managing another manager.

## Resolved questions

All five open questions from the first draft were answered by POC on 2026-09-02.
Kept here because each answer constrains the design.

- **Q1 — OpenCode context usage: yes, per message.** Each `message.data` JSON
  carries `tokens: { total, input, output, reasoning, cache: { read, write } }`,
  with `total` pre-summed. R7 works on both backends. **Do not** use the `session`
  table's `tokens_*` columns for this: they are lifetime totals (observed
  `tokens_cache_read` of 17.1M against a 200k–1M window), useful for cost display
  but meaningless as a fullness signal. That table also carries `cost`, which is
  worth surfacing on its own.
- **Q2 — The manager's context budget is a non-issue.** Measured against three
  real sessions: a 20-entry tail is ~600 tokens, 50 entries ~3–5k, 100 entries
  ~4–9.5k. Reading five sessions at depth 50 costs ~20k. The reason is that
  `TranscriptEntry` keeps only a one-line summary per tool and drops tool results
  entirely, and tool results are what actually consume context. No summarised mode
  needed; default `limit` 50.
- **Q3 — `wait_for_idle` on OpenCode is reliable.** Its detector does not guess
  from the painted terminal for completion; it reads the sqlite `message` row's
  `finish` field, treating only `finish === "stop"` as done and ignoring
  `"tool-calls"` and streaming states (`opencode.ts:418-421`). Screen reading is
  used only for permission dialogs, which OpenCode never persists. Claude's
  detector is the weaker of the two here, since it infers completion from JSONL
  pairing plus PTY silence thresholds (`claude.ts:107`).
- **Q4 — Manager restart: re-derive, don't persist.** Rebuild from
  `list_sessions()` plus transcript tails. Q2's numbers make this cheap, and a
  persisted task file would drift from reality the first time the user kills a
  session or a session compacts itself, leaving the manager to dispatch on stale
  beliefs.
- **Q5 — `/clear` stays out of the allowlist.** See R5.

## Still open

- **Q6 — resolved 2026-09-02: hand-rolled, no SDK dependency.** Implemented in
  T-204 as `manager-mcp/server.ts` on node's built-in `http`, ~330 lines, zero new
  dependencies. `@modelcontextprotocol/sdk` is 4.3MB across 17 direct dependencies
  — express *and* hono, jose and pkce-challenge for OAuth, ajv, a rate limiter —
  none of which a tools-only server needs. The spec's minimum for such a server is
  small: one endpoint, four JSON-RPC methods (`initialize`,
  `notifications/initialized`, `tools/list`, `tools/call`), GET answerable with
  405 since we never push, `Mcp-Session-Id` a MAY, and POST responses allowed to
  be `application/json` rather than SSE. Cost of the choice: protocol revisions
  are ours to track. Mitigated by pinning accepted versions in one set literal and
  by the client being the CLI on the same machine.
- **Q8 — Drive OpenCode instances over its HTTP API instead of the PTY?**
  Discovered 2026-09-15: OpenCode (1.18.30) ships an HTTP server with an OpenAPI
  3.1 spec at `/doc` and 162 endpoints, and `--port` / `--hostname` are top-level
  CLI options, not just `serve` subcommand ones. It covers most of this epic
  directly: `POST /api/session/{id}/prompt` (send), `.../wait`, `.../compact`,
  `.../interrupt`, `GET /api/session/{id}/history`.

  The part that matters most is the blocked check. `GET /api/permission/request`,
  `GET /api/question/request` and `GET /api/session/{id}/permission` report
  pending decisions **exactly**, where R5's PTY-side gate has to infer them from a
  detector. And a structured POST cannot approve a dialog by accident, so the
  measured escalation in the verification log simply doesn't exist on this path.

  Cost of taking it: spawn must pass an explicit `--port` (verified 2026-09-15
  that the TUI listens on nothing by default), must set
  `OPENCODE_SERVER_PASSWORD` (the server warns `is not set; server is unsecured`),
  and we need an instance→OpenCode-sessionID mapping. It also means two genuinely
  different transports behind the same tools, which `tech-conventions.md`'s
  multi-backend rule says to express as a `Backend` method rather than scattered
  `if (backend === ...)` branches.

  Does not affect M1. Decide before T-203, since a precise gate for half the
  fleet changes what that task has to cover. Note the API's `GET
  /api/session/{id}/context` is **not** token usage (returns `{"data": []}`), and
  session-level `tokens`/`cost` are lifetime totals, so T-201 stands as specified.
- **Q4 — reopened 2026-09-15. What actually bounds the manager?**
  T-209 left out `--add-dir` on the reasoning that the CLI's directory boundary would
  then confine the manager to its own workspace. **That reasoning is wrong.** In real
  use the manager ran `cd <a user repo> && git …` and read that repo's state without
  trouble: the boundary governs the file tools (Read/Edit/Write), not `Bash`, and this
  user's settings allow `Bash(*)`.

  So the manager is currently as privileged as the user's own Bash rules allow, and
  omitting `--add-dir` narrows the surface without bounding it. Options, none chosen
  yet: pass `--settings` with a manager-specific deny list (`Edit`, `Write`, plus
  `Bash` patterns that write); accept the privilege and rely on T-210's visibility;
  or give the manager its own permission mode. Worth settling before T-206 and T-207
  add tools that make the manager act on other sessions rather than just read them.
- **Q7 — Detector coverage for the blocked check.** R5's state check is only as
  good as the `prompt` event. Claude's detection of a blocked state is threshold-
  based, so there is a window where a session is on a dialog but not yet reported
  as such. Does the write need a second guard — for example refusing when the last
  PTY byte is more recent than the last state change?

## Verification log

Gathered on this machine rather than from docs.

- 2026-09-02: **a PTY write to a session parked on a plan-approval dialog approves
  the plan.** POC spawned `claude --permission-mode plan`, asked for a plan, waited
  for the PTY to fall silent with the dialog up, then wrote
  `please review the diff and report findings` exactly the way `sendPrompt` does
  (bracketed paste + `\r`). The dialog's default highlighted option
  (`1. Yes, and use auto mode`) was selected, the session entered auto mode, and it
  edited `README.md` — confirmed by hash change `575cb590…` → `64cf9bda…` and
  `git status` reporting `M README.md`. The file was restored. The payload
  contained no digits and no `y`, so an allowlist would not have prevented this.
  This is the origin of R5's state check.
- 2026-09-02: a PTY write while the target is **busy** is queued, not lost and not
  interrupting. POC dispatched `sleep 18`, then mid-run wrote a second task; the
  screen showed `queued` and the second task ran to completion after the first.
- 2026-09-02: a slash command sent over bracketed paste needs **two** carriage
  returns — the autocomplete menu that `/` opens consumes the first. Confirmed by
  `/context` rendering its usage grid only after the second `\r`.
- 2026-09-02: transcript tail cost measured across three real sessions —
  20 entries ~600 tokens, 50 ~3–5k, 100 ~4–9.5k.
- 2026-09-02: OpenCode stores per-message token usage in `message.data.tokens`
  (`total` pre-summed); the `session` table's `tokens_*` columns are lifetime
  totals, not context size.
- 2026-09-02: token usage is present in the session JSONL's `assistant` records
  (`cache_read_input_tokens: 452559` in the largest live session), so context
  usage is computable for Claude sessions.
- 2026-09-02: the user's global settings allow `Read(*) Write(*) Edit(*) Bash(*)
  Agent(*) WebFetch(*)`, so ordinary permission prompts are rare on this machine.
  Plan approval and AskUserQuestion still block regardless, which is why R5 keys
  off the detector's `prompt` event rather than off permission config.
- 2026-09-02: `Backend.readTranscript(sessionId, limit)` is part of the backend
  interface and implemented for both backends, so R1 needs no new per-backend
  work.
- 2026-09-01: cross-session messaging verified working on this machine
  (`/tmp/cc-socks/73380.sock`, `~/.claude/sessions/73380.json` with
  `status: idle`), and its documented limits verified as the ones listed in
  [Why not native messaging](#why-not-native-messaging).
- 2026-09-01: `claude --version` reports the launcher version, not the running
  session's — check `CLAUDE_CODE_EXECPATH` instead. Relevant if native messaging
  is ever added.
