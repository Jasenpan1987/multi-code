# 2026-10-06 — Attention alerts investigation

**Type:** investigation (measured, no code changed)
**Participants:** Builder (Jasen), AI
**Epic:** `attention-alerts`

## Summary

The builder has fought the notification sound for months with two symptoms: it chimes
while an agent is still working (sometimes mid-sentence), and it often stays silent when
an agent actually finishes. This session measured why, against a real CLI and against the
builder's own transcripts, and surveyed how comparable apps solve it. Conclusion: both
symptoms come from Multi-Code *guessing* agent state, and from an attention policy that
silences real completions while letting guessed prompts through. The CLI reports its own
state precisely through hooks and through its session registry. Builder decided to move
to hooks.

## Method

- **Live probes.** A Python `pty.fork()` harness spawned the real CLI (2.1.290,
  `--model haiku`, 160x50, `TERM=xterm-256color`) in `/tmp/mc-probe/work*`, drove prompts,
  and logged with timestamps: every PTY chunk, every OSC/BEL sequence, every change of
  `~/.claude/sessions/<pid>.json` `status`/`waitingFor` (polled every 100ms), and every hook
  delivery. Hooks were injected with `--settings <file>` registering a command hook on
  `Stop`, `SubagentStop`, `Notification`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `SessionStart`, `StopFailure` that appended its stdin JSON to a log.
  A permission dialog was forced with `"permissions": {"ask": ["Bash(touch:*)"]}` in the
  same settings file.
- **Transcript replay.** The 60 most recently modified `~/.claude/projects/*/*.jsonl` were
  replayed through the current detector's rules.
- **Survey.** Source of Orca, cmux, Superset, Agent Deck, Sculptor, vibe-kanban,
  claudecodeui, Crystal, opcode, Claude Squad, CCManager; docs for Conductor and Claude
  Code hooks.

To check the registry by hand: `jq '{status,waitingFor}' ~/.claude/sessions/<pid>.json`.

## Facts Learned

### What Multi-Code does today (verified in code)

- "Finished" (`waiting`): an assistant row with `stop_reason: "end_turn"` in the session
  JSONL, confirmed by a 2s timer that a string-content `user` row cancels.
  (`workspace/app/src/main/backends/claude.ts`)
- "Needs you" (`prompt`): a `tool_use` unpaired for >1.5s while the PTY has been silent
  for ≥800ms, polled every 500ms. (same file)
- Policy (`workspace/app/src/renderer/audio/attentionPolicy.ts`, added 2026-08-24 after
  Orca): `waiting` is silent when the instance is selected and the window has focus;
  `prompt` is "urgent" and sounds regardless; 5s per-instance cooldown. The selected
  instance's red dot auto-clears after 1.5s (`App.tsx`).

### Why it chimes mid-work (measured)

- **PTY silence is not a reliable "waiting on you" signal.** While a foreground tool runs
  the CLI repaints ~8 times/s but gaps of 0.88–0.90s were recorded. While background work
  runs with the main agent idle, it repaints exactly every 1.00s. Both exceed the 800ms
  threshold.
- **Exposure is large for this builder.** `Bash(*)`, `Write(*)`, `Edit(*)`, `Agent(*)`,
  `WebFetch(*)` are all auto-allowed, so real permission dialogs are rare but long tool
  runs are constant: 1,799 of 4,730 tool calls (38%) stayed unpaired >1.5s, each one a
  window where a single repaint hiccup fires a false urgent chime.
- **Background agents end a turn early.** When the agent launches a background subagent
  it replies "running in the background, I'll report back" with `end_turn`; the current
  detector chimes there, and again when the subagent's completion wakes the agent.

### Why it stays silent at the end (measured or verified in code)

- **The policy inverts the builder's experience.** While watching an instance, real
  completions are suppressed and guessed prompts are not. `document.hasFocus()` is true
  while the builder looks at a phone or another screen.
- **Cooldown swallows real events.** A false prompt within 5s before a real finish eats it.
- **Real permission dialogs are invisible to the silence rule.** The Bash permission dialog
  repaints 40 bytes every 0.60s, so the PTY is never silent for 800ms. (AskUserQuestion was
  silent for 13.5s and would be caught.)
- Minor: 29 of 1,447 `end_turn` rows were followed within 2s by a string `user` row (20
  typed, 7 `<task-notification>`, 2 meta) that cancels the chime; 15 turns ended with
  `stop_sequence`, `refusal`, or `tool_use` and never chime.

### What the CLI itself reports (measured, CLI 2.1.290)

| Moment | Hooks | Registry `status` |
|---|---|---|
| Prompt submitted | `UserPromptSubmit` | `busy` |
| Turn finished | `Stop` (~30ms from registry) | `idle` |
| Permission dialog shown | `PermissionRequest` immediately; `Notification` `permission_prompt` ~6s later | `waiting`, `waitingFor: "permission prompt"` (~50ms) |
| AskUserQuestion shown | `PermissionRequest` (tool `AskUserQuestion`); `Notification` ~6s later | `waiting`, `waitingFor: "input needed"` |
| Dialog answered | — | back to `busy` at once |
| Esc interrupt | **no hook at all** | `idle` within 0.12s |
| Background subagent launched, main reply done | `Stop` fires early | stays `busy` until the subagent finishes |
| Subagent finishes | `SubagentStop` (twice), then `UserPromptSubmit` (agent woken), then `Stop` | `idle` after the final reply |
| Background Bash still running, main reply done | `Stop` | `shell` |
| Idle 70s | no `idle_prompt` observed | `idle` |

- Every installed CLI from 2.1.284 to 2.1.290 writes `status: "waiting"` with `waitingFor`.
  Values seen in the binary: `permission prompt`, `input needed`, `dialog open`,
  `sandbox request`, `goal proposal`, `worker request`. The registry is undocumented.
- `--settings` is additive: the builder's own `~/.claude/settings.json` (Bedrock env,
  allow rules) kept applying, and the injected hooks all fired.
- The CLI emitted no BEL/OSC 9/777. Terminal-title signals are unavailable here because
  the builder's settings set `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`.

### Hook spike (CLI 2.1.291)

T-401. Same PTY harness as the Method section, rewritten to log each hook's **full stdin
JSON** (one file per delivery), poll the registry every 50ms, and render the screen with
`pyte`. A `--settings` file registered 29 of the 33 events 2.1.291 offers, matcher `""`
(skipped: `WorktreeCreate`/`WorktreeRemove`, whose hooks replace behaviour; `Setup`;
`FileChanged`). Every spawn had `MULTICODE_INSTANCE_ID=spike-<run>` in its env. Haiku
unless noted; work dirs under `/tmp/mc-spike/`. The CLI auto-updated 2.1.290 → 2.1.291
mid-spike; the default-mode group was run on both with the same results, and every saved
fixture is from 2.1.291. Reproduce on the builder's machine:
`cd .omt/probes/attention-alerts/spike && uv run --with pyte python3 group_main.py`
(also `group_modes.py`, `group_misc.py`, `group_rerun.py`, `group_bgshell.py`,
`group_cost.py`, `group_stopwait.py`, `group_permwait.py`; `show.py <fixture>` prints a
timeline). Fixtures: `workspace/app/src/main/backends/__fixtures__/claude-hooks/*.json`,
shape `{cli, scenario, description, deliveries: [{ms, payload}], registry: [{ms, status,
waitingFor?}], inputs: [{ms, key}]}`, `ms` since the window's first delivery.

Every delivery carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and
(once a prompt exists) `prompt_id`; most carry `permission_mode`. Deliveries from inside a
subagent add `agent_id` and `agent_type`; the main agent's never do.

1. **Background work at `Stop`: yes, `background_tasks`.** Every `Stop` (and
   `SubagentStop`) carries `background_tasks: [{id, type, status, description, …}]` and
   `session_crons: []`. A running subagent is `{type: "subagent", status: "running",
   agent_type}`; a background Bash is `{type: "shell", status: "running", command}`. The
   real end is a `Stop` with `background_tasks: []`. Registry at Stop +0/100/300/1000ms:
   always still `busy` at +0 (`Stop` precedes the registry write by 15–60ms); final by
   +300ms in every scenario: `idle` on a real finish, `busy` while a subagent runs,
   `shell` while a background Bash runs, `waiting` when a subagent's dialog is up.
   **In 2.1.291 every Agent call is launched async** (`tool_response.isAsync: true,
   status: "async_launched"`), with or without `run_in_background`: the early `Stop` with
   a running subagent is the normal case, not an edge. A finished background task wakes
   the main agent with a `UserPromptSubmit` whose `prompt` starts `<task-notification>`,
   followed by its own `Stop`. That includes a **background shell**: when it exits, the
   agent runs a second turn and a second `Stop` arrives (`bg-shell`).
2. **Plan approval.** `PreToolUse` (`ExitPlanMode`) then `PermissionRequest`
   (`ExitPlanMode`) 25–100ms later, registry `waiting (permission prompt)`. Options: "Yes,
   auto-accept edits" / "Yes, manually approve edits" / "Tell Claude what to change".
   Approved: `PostToolUse` (`ExitPlanMode`) ~45ms after the key, plus `PostModelSwitch`
   (`source: "auto"`) as the mode changes. Esc: no hook, registry `idle`, turn over.
3. **Auto mode** (`--permission-mode auto`) needs a model that supports it: haiku and the
   `sonnet` alias (Sonnet 4.5 on Bedrock) show "auto mode unavailable for this model" and
   silently run in the default mode. On `opus` (the builder's Opus 5.5), `PermissionRequest`
   fired for AskUserQuestion, ExitPlanMode and an ask-rule Bash call. Under
   `--dangerously-skip-permissions` it also fired for AskUserQuestion and ExitPlanMode, so
   cmux #6606 (no `PermissionRequest` in bypass mode) does not reproduce on 2.1.291.
   **`PermissionRequest` fired for every dialog in every mode measured** (default, plan,
   auto, bypass).
4. **MCP input request.** A throwaway stdio MCP server sending `elicitation/create`:
   `Elicitation` fires ~60ms after the tool's `PreToolUse` with `mcp_server_name`,
   `message`, `mode: "form"`, `requested_schema`; registry `waiting (input needed)`; no
   `PermissionRequest`. On submit: `ElicitationResult` (`action: "accept"`, `content`)
   ~130ms later, a `Notification` (`elicitation_response`), then the tool's `PostToolUse`.
5. **API error.** `--model claude-does-not-exist-9`: `StopFailure` with
   `error: "model_not_found"` and `last_assistant_message` holding the API error text.
   **No `Stop`.** Registry `idle` ~3ms before it. The binary's error enum:
   `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`,
   `verification_required`, `billing_error`, `rate_limit`, `overloaded`,
   `invalid_request`, `model_not_found`, `server_error`, `unknown`, `max_output_tokens`,
   `cloud_credential_error` (only `model_not_found` provoked).
6. **After a dialog.** Approved (Yes; "Yes, and don't ask again"; AskUserQuestion
   answered; plan approved): that tool's `PostToolUse` 35–70ms after the key (one outlier
   2.1s while three CLIs ran at once), registry `busy` within ~50ms. **Denied (Esc; "No" in
   the two-option ask-rule dialog; "No" in the three-option dialog; plan Esc): no hook at
   all** (no `PermissionDenied`, no `PostToolUseFailure`, no `Stop`); registry `idle` in
   40–145ms and the turn is over. A dialog forced by an `ask` rule offers only Yes / No;
   a tool with no rule offers Yes / "Yes, and don't ask again for …" / No, and its
   `PermissionRequest` carries `permission_suggestions`.
7. **Ids.** `PreToolUse`/`PostToolUse` carry `tool_use_id`. **`PermissionRequest` carries
   no `tool_use_id`**, only `tool_name` and a `tool_input` identical to the preceding
   `PreToolUse`'s (plus `agent_id` from a subagent). `Elicitation` has no tool id either.
   One dialog produced exactly one `PermissionRequest` in every run, and two dialogs in a
   row produced two, so keying "needs you" on `PermissionRequest` and `Elicitation` alone
   needs no dedupe; `PreToolUse` on AskUserQuestion/ExitPlanMode adds nothing on 2.1.291.
8. **A user Stop hook that blocks** (in the work dir's `.claude/settings.json`, ours in
   `--settings`: both sources' hooks ran). Our `Stop` (`stop_hook_active: false`), then
   ~850ms later a second `Stop` (`stop_hook_active: true`) after the forced continuation;
   registry `busy` the whole gap, `idle` after the second. Related: a **synchronous Stop
   hook delays the registry's `idle` by its own runtime** (a `sleep 2` hook: `idle` 2045ms
   after the hook started), so a user's slow-but-not-blocking Stop hook also shows `busy`
   at +300ms with no second `Stop` to follow. With `"async": true` the registry went
   `idle` before the hook even started.
9. **Slash commands.** `/cost`, `/status`, `/model` (closed with Esc): no hooks; registry
   `waiting` with **`waitingFor: "dialog open"`** while the panel is up, `idle` after.
   `/compact`: `PreCompact` (`trigger: "manual"`), a `SubagentStop` (`agent_type: ""`,
   the compaction), `SessionStart` (`source: "compact"`, same `session_id`), `PostCompact`
   (`trigger: "manual"`, `compact_summary`), registry `idle`. **No `Stop`, no
   `UserPromptSubmit`.** `/clear`: `SessionEnd` (`reason: "clear"`) on the old id, then
   `SessionStart` (`source: "clear"`) with a new `session_id`; no `Stop`.
10. **Subagent identity.** `PreToolUse`, `PostToolUse`, `PostToolBatch` and
    `PermissionRequest` from inside a subagent carry `agent_id` + `agent_type`. A subagent
    ends with `SubagentStop` (carrying `agent_id`), never `Stop`.
11. **Hook environment.** Yes: every hook command saw `MULTICODE_INSTANCE_ID` from the
    `claude` process's env.
12. **Two `--settings` flags: the last one wins outright.** Only the second file's hooks
    fired; the first file's `SessionStart`/`SessionEnd` hooks never ran.
13. **Cost.** One `curl -K` delivery to a local 204 server: 11ms median outside the CLI.
    Five Bash `true` calls per condition (transcript `tool_use` → `tool_result`, median):
    no hooks 29ms; sync curl on `PreToolUse`+`PostToolUse` 67ms; the same with
    `"async": true` 31ms; sync `sleep 1` on both 2067ms; async `sleep 1` 28ms. So the CLI
    waits for sync tool hooks, accepts `"async": true`, and async removes the cost.
    Async deliveries arrived complete and in order. A sync `PermissionRequest` hook running
    2s did not delay the dialog (registry `waiting` ~25ms after the hook started).

Also measured: `SessionStart` (`source: "startup"`, carries `model`) arrives within ±200ms
of the registry entry appearing. `InstructionsLoaded` follows it per CLAUDE.md loaded.
`MessageDisplay` streams the assistant's text (`delta`, `final`) and is noise for alerts.
`PostToolBatch` follows each batch of tool results. Once, on 2.1.290, the registry went
`idle` for ~30ms between a subagent's `SubagentStop` and the `<task-notification>` wake
(not reproduced on 2.1.291): a registry-only reader would have seen a false finish.

### How comparable apps do it (survey; source read unless marked)

- Orca, cmux, Superset, Agent Deck, Sculptor: Claude Code hooks — `Stop`/`StopFailure`
  for done, `PermissionRequest` plus `PreToolUse` on `AskUserQuestion`/`ExitPlanMode` for
  needs-input. None uses JSONL `end_turn`.
- Injection: cmux and Sculptor pass `--settings`; Orca and Superset write the global
  `~/.claude/settings.json` guarded by an env var, and Superset shipped a bug where the
  global hook fired outside the app (their #5531).
- Pitfalls they hit: `Stop` before background subagents finish (Superset #8120, Orca
  #25663); `SubagentStop` counted as done (Superset #6929); no hook on Esc (Orca, Sculptor
  design doc); `AskUserQuestion`/`ExitPlanMode` raise no `PermissionRequest` under
  `--dangerously-skip-permissions`, only `PreToolUse` sees them (cmux #6606).
- Screen-parsing tools (Claude Squad, CCManager) break whenever CLI wording or the
  status line changes (CCManager #227, #117).
- Headless hosts (vibe-kanban, Crystal, Conductor — inferred) use stream-json, which does
  not apply to a PTY-hosted TUI.

### OpenCode has the same thing: a plugin (measured, OpenCode 1.18.34)

Probe: a plugin file `plugin/probe.js` exporting
`async () => ({ event: async ({ event }) => append(event) })`, placed in a scratch
directory passed as `OPENCODE_CONFIG_DIR`, with the TUI driven through a PTY
(`opencode -m github-copilot/claude-haiku-4.5`).

- **Injection without touching user config.** `OPENCODE_CONFIG_DIR` adds one more config
  directory; OpenCode loads `{plugin,plugins}/*.{ts,js}` and `opencode.json` from it.
  `opencode debug config` with the variable set still showed the builder's own model, MCP
  servers (`documonster`, `sentry`) and skills, plus the injected plugin: the configs merge.
  `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` also exist in the binary.
  ⚠️ Superseded by the source research below: this variable drops the user's global
  `AGENTS.md`, so production uses `OPENCODE_CONFIG_CONTENT` instead.
- **Events, all on the main session's id:**

| Moment | Plugin events |
|---|---|
| Turn finished | `session.status` `{type:"idle"}` then `session.idle` |
| Long tool running (sleep 15) | `busy` only, nothing else |
| Permission dialog shown | `permission.asked` with `id`, `permission`, `patterns`, `metadata.command` |
| Permission answered | `permission.replied` with `reply: "once"` |
| Question tool shown | `question.asked` with the questions and options |
| Question answered | `question.replied` with the answers |
| Subagent (task tool) | `session.created` with `parentID`; the child's own `session.idle` fires first, then the parent's |
| Esc Esc interrupt | `session.error` `MessageAbortedError`, then `session.idle` **twice** |

So OpenCode reports exactly what Multi-Code currently guesses from its SQLite rows and
from parsing the permission dialog off the screen. Two rules a consumer needs: ignore
sessions that have a `parentID`, and don't treat the `session.idle` that follows a
`MessageAbortedError` as a finish.

### OpenCode source research (anomalyco/opencode `dev` @ 652c090 = 1.18.34)

Read in source and re-run against the local binary in an isolated sandbox (own `HOME`,
mock LLM). The user's `~/.config/opencode` was not touched.

- **`OPENCODE_CONFIG_DIR` is the wrong injection seam.** It replaces the global config
  directory (`packages/core/src/global.ts:64`), and global instructions are read from
  there (`session/instruction.ts:61`), so the user's `~/.config/opencode/AGENTS.md` is
  silently dropped. Model, MCP, agents and plugins still merged, which is why
  `opencode debug config` (no instructions shown) didn't catch it. Upstream #28658;
  Superset hit it (#1527) and Orca moved off it (PR #21854). `OPENCODE_CONFIG` and
  `OPENCODE_CONFIG_CONTENT` both keep `AGENTS.md`. **Use `OPENCODE_CONFIG_CONTENT`
  with `{"plugin":["file://…"]}`**, merging into any value the user already set.
- **Load order** (`config/config.ts`): remote well-known → global → `OPENCODE_CONFIG` →
  project → `.opencode` dirs and `OPENCODE_CONFIG_DIR` → `OPENCODE_CONFIG_CONTENT` →
  managed. Deep merge; `plugin` is a deduplicated union, so ours never removes theirs.
- **Plugin shape.** `export const X = async ({ client, directory, ... }) => hooks`. Every
  named export must be a plugin function, or loading throws. Init is awaited and blocks
  bootstrap, so keep it fast; the `event` hook is fire-and-forget and thrown errors are
  swallowed in the TUI worker. The plugin runs in a Bun worker inside the TUI process:
  never write to stdout. The `permission.ask` hook is never called in 1.18.34; use the
  `permission.asked` event.
- **Event details.** Status stays `busy` while a permission is pending, so Needs you must
  come from `permission.asked`/`question.asked`, not status. `question.rejected` also
  exists. Only `session.created`/`session.updated` carry `info.parentID`. A subagent's
  `permission.asked` carries the child's session id and really blocks the user: map it to
  the instance rather than dropping it. An abort while a permission is open sends no
  `permission.replied`; clear on the session going idle or erroring. Errors and aborts
  produce `session.error` then two idles ~40–50ms apart. A compaction overflow publishes
  `session.error` without going idle, so key Finished on busy→idle, not on the error.
- **Version risk.** OpenCode v2 renames to `permission.v2.*`, `question.v2.*`,
  `session.next.*`.
- **Alternative seam.** `--port` plus `OPENCODE_SERVER_PASSWORD` exposes the same events
  as SSE on `GET /event`; costs port management, reconnect and re-seed logic, and an
  extra local control surface. Kept as a fallback only.
- **Comparable apps.** Superset (plugin via `OPENCODE_CONFIG_DIR`), Orca (plugin written
  into the user's own plugins dir), cmux (user-run setup), Agent Deck (`--port` + SSE),
  vibe-kanban (`opencode serve` + SSE). Common practice: gate the plugin on the host's own
  env var, count only busy→idle, run handlers through a FIFO.

## Key Decisions

- **Move Claude detection to hooks**, injected through `--settings` from Multi-Code's
  `userData`, the pattern the manager already uses. Decided by builder. Reason: every
  comparable app converged on hooks; the CLI reports exact state instead of Multi-Code
  guessing. The file is read only by processes Multi-Code launches, so plain `claude` in a
  terminal is unaffected.
- **Chat-app alert rules.** Decided by builder: every new attention event chimes (no
  suppress-while-watching); typing or clicking on the shown instance stops the sound and
  clears its red dot; an ignored red dot stays and the Dock keeps bouncing.
- **Background subagents hold the alert.** Decided by builder: chime once when all
  background subagent work is done and the agent's final reply ends.

## Open Questions

See `docs/specs/attention-alerts/gaps.md`.
