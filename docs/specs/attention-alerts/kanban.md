# Kanban: Attention Alerts

**Generated:** 2026-10-06 · **Revised:** 2026-10-06 (cold-read review before handoff)
**Source:** `docs/specs/attention-alerts/prd.md` v1.4 · `docs/specs/attention-alerts/gaps.md`
**Evidence:** `docs/timeline/2026-10-06_attention-alerts-investigation.md`
**Total Tasks:** 12 (T-401..T-412)
**Milestones:** M1 (Claude alerts you can trust) · M2 (degraded fallback) · M3 (OpenCode on its plugin)

Task ids start at T-401 so they never collide with the diff-view epic's T-3xx. Only M1 is
committed; M2 and M3 are re-planned when M1 ships. The builder runs this as **one line of
work, one task at a time** (no parallel worktrees), so the order below is the order to
take them in.

## Task Overview

```mermaid
graph TD
    T401[T-401: hook behaviour spike] --> T402[T-402: alert endpoint + listener at startup]
    T401 --> T404[T-404: hook-driven attention logic]
    T402 --> T404
    T402 --> T403[T-403: alert settings + spawn injection]
    T401 --> T403
    T403 --> T405[T-405: wire in, remove the guessing]
    T404 --> T405
    T405 --> T406[T-406: chat-app alert rules in the renderer]
    T406 --> T407[T-407: Track 1 QA]
    T405 --> T408[T-408: degraded indicator + registry fallback]
    T407 --> T409[T-409: OpenCode plugin spike]
    T409 --> T410[T-410: OpenCode plugin + injection]
    T409 --> T411[T-411: OpenCode plugin-driven detector]
    T410 --> T411
    T411 --> T412[T-412: Track 2 QA]
```

**Order:** T-401 → T-402 → T-404 → T-403 → T-405 → T-406 → T-407.

**Critical path:** the whole of that order. The spike decides which hooks exist and what
they carry; T-402 defines the delivery shape T-404 consumes; T-403 can only register the
events T-404 turned out to need; the old detector goes in T-405; T-406 waits for T-405 so
the new chime rules never run on the old guesses.

**Why T-406 is not earlier:** it has no code dependency on the hooks, but shipped alone it
would make today's guessed "finished" chime while the builder is watching. Sequenced, not
blocked by code.

**Shared files to watch:** T-402 and T-403 both edit `workspace/app/src/main/manager-mcp/index.ts`; T-405 and T-406 both edit `README.md` (different sections).

---

## Milestone 1: Claude alerts you can trust

**Goal:** a Claude agent in Multi-Code chimes once when it is truly done or truly stuck on
you, never in the middle of work, and the alert stays until you act on it.

**Tasks:** T-401, T-402, T-403, T-404, T-405, T-406, T-407

**Done when:**
- A long Bash command, a foreground subagent, and a background subagent each run to the end with exactly one chime, at the end
- A permission dialog, an AskUserQuestion, and a plan approval each chime within a second of appearing
- Pressing Esc mid-turn does not chime; a turn that dies on an API error does
- The chime plays while you are looking at the session; typing or clicking in it stops the chime and clears the red dot; ignored, the red dot stays and the Dock keeps bouncing
- `claude` started in an ordinary terminal behaves exactly as before, with Multi-Code running or not, and no file outside Multi-Code's data folder was written
- The manager's `wait_for_idle`, the write-safety gate, context usage, and a paired phone all work as before

### T-401: Hook behaviour spike on the real CLI
- **Type:** qa
- **Status:** ready
- **Requirement:** `docs/specs/attention-alerts/prd.md#to-verify-before-building`
- **Knowledge:** `docs/timeline/2026-10-06_attention-alerts-investigation.md#what-the-cli-itself-reports-measured-cli-21290`, and its `#method` section
- **Code:** no app code. Writes fixtures to `workspace/app/src/main/backends/__fixtures__/claude-hooks/` (new) and appends results to the investigation record.
- **Description:** Settle every unknown the attention logic depends on, by driving the real CLI in a PTY with a `--settings` file whose hooks log their **full stdin JSON** plus a timestamp. The harness is the one in the investigation record's Method section (Python `pty.fork()`, `--model haiku`, registry polled at 100ms, a `/tmp` work dir, trust dialog answered with Down + Enter because its default is "No, exit"). On the builder's machine a copy is in `.omt/probes/attention-alerts/claude-hooks-probe.py`; it logs only six fields per delivery, so change it to log the whole payload first. Register every hook event the CLI offers (at least `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` if it exists, `Notification`, `Stop`, `StopFailure`, `SubagentStop`, `Elicitation`, `PreCompact`), each with matcher `""`. Measure and record:
  1. **Background work at `Stop`.** Does the `Stop` payload carry a field listing still-running background subagents (docs mention `background_tasks`)? Record the field and shape. Either way, record the registry `status` 0, 100, 300 and 1000ms after each `Stop` (measured once as `busy` while a background subagent ran, `shell` with a background Bash, `idle` on a real finish).
  2. **Plan approval.** `--permission-mode plan`, let it call ExitPlanMode: which of `PermissionRequest`, `PreToolUse` (`ExitPlanMode`), `Notification` fire, and when.
  3. **Auto mode.** Repeat AskUserQuestion and plan approval in auto mode (take the exact mode name from `claude --help`): does `PermissionRequest` still fire?
  4. **MCP input request.** If an Elicitation can be provoked cheaply, which hook fires; if not, write "not measured".
  5. **API error.** Provoke a failed request (e.g. `--model` set to an id that doesn't exist on Bedrock): does `StopFailure` fire, with what `error`; does `Stop` also fire; what does the registry show?
  6. **After a dialog.** For each of: approved, approved "always", denied with Esc, denied with "No", AskUserQuestion answered: which hooks fire next and how long after the keypress. This is the "prompt cleared" signal.
  7. **Ids for dedupe.** Which id fields (`tool_use_id`, anything else) `PermissionRequest`, `PreToolUse`, `PostToolUse` and `Elicitation` carry, and whether `PermissionRequest` and `PreToolUse` for the same call share one.
  8. **A user Stop hook that blocks.** Add a second `Stop` hook returning `{"decision":"block","reason":"continue once"}` the first time: delivery order, gaps between them, and the registry status during the gap.
  9. **Slash commands.** `/model`, `/cost`, `/status`, `/compact`: which hooks fire, and whether `/compact` ends with a `Stop`.
  10. **Subagent identity.** Do `PreToolUse`/`PermissionRequest` from inside a subagent carry `agent_id`? Does a subagent ever deliver `Stop` (rather than `SubagentStop`)?
  11. **Hook environment.** Does the hook command see an env var set on the `claude` process (spawn with `MULTICODE_INSTANCE_ID=x`, have the hook log it)?
  12. **Two `--settings` flags.** Do both files apply, or does the last one win?
  13. **Cost of a hook.** Wall time a `curl` hook adds to one tool call (time a `Bash` `true` with and without `PreToolUse`+`PostToolUse` hooks), and whether `"async": true` on a hook is accepted and removes that time.
- **Acceptance:** each of the 13 items has a measured answer (or "not measurable, because…") appended to the investigation record under a new `### Hook spike (CLI <version>)` heading, with the CLI version and the probe command. Each captured scenario is saved as one fixture file, `<scenario>.json`: `{ "cli": "<version>", "deliveries": [{ "ms": <ms since first delivery>, "payload": { …full hook stdin… } }], "registry": [{ "ms": …, "status": …, "waitingFor": … }] }`. **Scrub before saving** (the repo is public): replace the home directory with `~` everywhere, including `transcript_path` and `cwd`. Anything that contradicts the PRD is handed back to `prd` before T-404 starts.
- **Blocks:** T-402, T-403, T-404 · **Blocked by:** none
- **Notes:** costs a few cents of haiku. Never point the probe at a real project directory and never change `~/.claude/settings.json`; everything goes through `--settings`. Real permission dialogs need `"permissions": {"ask": ["Bash(touch:*)"]}` in the probe's own settings, because the builder auto-allows `Bash(*)`.

### T-402: Alert endpoint, started with the app
- **Type:** feature
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#story-1-hooks-reach-only-the-instances-multi-code-launches`
- **Knowledge:** `docs/knowledge/tech-conventions.md#a-hook-is-how-the-managers-own-tool-calls-become-visible-added-2026-09-16`
- **Code:** `workspace/app/src/main/manager-mcp/server.ts`, `workspace/app/src/main/manager-mcp/index.ts`, `workspace/app/src/main/index.ts` (`app.whenReady`), `workspace/app/src/main/backends/types.ts` (new `AlertDelivery` type), `README.md` (How It Works, step 8)
- **Description:** Today the loopback HTTP server starts only on the first manager spawn (`ensureManagerMcpStarted`, awaited by `prepareManagerSpawn` in `ipc-handlers.ts`), so a Claude session with no manager has nowhere to report to, and `spawnProcess` is synchronous so it can't start the server itself. Start the server in `app.whenReady` in `main/index.ts`, before any window or instance can spawn, and keep it for the app's lifetime. Add a POST route `/alert`:
  - **Routing before auth.** `handle()` checks the manager token before it looks at the path (`server.ts`, the `isAuthorized` call above the `/hook` branch). Branch on `/alert` first and check it against its own token, so neither token opens the other's path.
  - **A separate token**, minted at server start like the existing one (`crypto.randomBytes(32).toString("base64url")`) and compared in constant time, so the token every session's hook carries cannot call the manager's dispatch tools.
  - **Body** is the CLI's hook stdin JSON. The instance is named by the header `X-Multicode-Instance` (not secret). Size cap as `/hook`, answering `413` when exceeded.
  - **Parse** into the new exported type in `backends/types.ts`: `AlertDelivery = { instanceId: string; event: string; sessionId?: string; toolName?: string; toolInput?: unknown; toolUseId?: string; agentId?: string; payload: Record<string, unknown> }` (field names from T-401's findings; `payload` keeps the whole delivery for anything T-404 needs). Hand it to one listener registered with `onAlertDelivery(cb)`. The server must not import process-manager (see the comment at the top of `manager-mcp/index.ts`); process-manager registers the listener and drops ids it doesn't know.
  - **Answers:** `204` for any authenticated, parseable delivery, before the listener's work matters; `400` for malformed JSON (traced, not delivered); `401` for a bad or missing token; `413` for oversized.
  - **Trace** every accepted delivery: `debugTrace("[alert-hook] <instance8> <event> <tool> at <iso>")`.
  - Export `getAlertTarget(): { endpoint: string; token: string } | null` for T-403. `null` when the server failed to bind: spawns then go ahead without alert settings, the failure is traced, and T-408's degraded indicator covers it once it exists.
  - Update the comment in `manager-mcp/index.ts` that justifies starting lazily, and README "How It Works" step 8, which says the server runs only when a manager exists.
- **Acceptance:** tests in `manager-mcp/server.test.ts`: the alert token on `/mcp` → 401 and the manager token on `/alert` → 401; missing token → 401; valid delivery → 204 and the listener gets the parsed fields; malformed JSON → 400, listener not called; oversized → 413. Existing `/mcp` and `/hook` tests still pass. `pnpm test`, `pnpm type`, `pnpm lint` green.
- **Blocks:** T-403, T-404 · **Blocked by:** T-401 (only for the payload field names; the route itself can be built first)

### T-404: Hook-driven attention logic
- **Type:** feature
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#story-2-finished-fires-once-at-the-real-end`, `docs/specs/attention-alerts/prd.md#story-3-needs-you-fires-once-the-moment-the-agent-blocks`
- **Knowledge:** `docs/timeline/2026-10-06_attention-alerts-investigation.md#what-the-cli-itself-reports-measured-cli-21290`, and the Hook spike section T-401 adds
- **Code:** `workspace/app/src/main/backends/claudeHooks.ts` (new), `workspace/app/src/main/backends/claudeHooks.test.ts` (new), `workspace/app/src/main/remote/promptExtract.ts` (reuse `extractPromptDetail`), `workspace/app/src/main/backends/types.ts` (`AlertDelivery`, `ActivityCallback`)
- **Description:** A pure class, no electron or node-pty imports (same reason as `run-state.ts`), constructed per instance with `(onActivity: ActivityCallback, readRegistryStatus: () => string | null, clock)`. It consumes `AlertDelivery`s and emits the vocabulary everything downstream already speaks: `waiting`, `prompt` with a `PromptDetail`, `prompt-cleared`. Rules, adjusted to T-401's findings:
  - **Finished.** On a main-agent `Stop` (no `agent_id`), wait a short debounce (~300ms), then read the registry: `idle` or `shell` → emit `waiting`; `busy` → hold (background subagents running, or a user Stop hook continued the turn) and decide again at the next `Stop`; `waiting` → nothing (a dialog is up). A `UserPromptSubmit` during the debounce cancels it. If T-401 finds a reliable background-work field on `Stop`, use it instead of or as well as the registry. `StopFailure` → `waiting` at once.
  - **Needs you.** `PermissionRequest`, `PreToolUse` for `AskUserQuestion`/`ExitPlanMode`, and elicitation → `prompt` with `detail = extractPromptDetail(toolName, toolInput)`. One dialog → one `prompt`, keyed on the id T-401 found shared across those hooks; if there is none, treat a second report of the same tool while a prompt is outstanding as the same dialog. A second dialog after the first cleared → a second `prompt`.
  - **Cleared.** The post-dialog signal T-401 found (tool completion, denial, `UserPromptSubmit`, `Stop`) → `prompt-cleared`, once, only while a `prompt` is outstanding. This is secondary: an answer typed at the desk or sent from the phone is a PTY write, which already moves `runState` to busy and clears the phone's card (`process-manager.ts`, `writeToInstance`).
  - **Ignored for events:** `SubagentStop`, `SessionStart`, `Notification`, anything unrecognised, and subagent `Stop`s.
  - `stop()` cancels timers. The clock and timers are injected so tests never sleep. The registry read is a confirmation of a reported `Stop`, not an event source (PRD Story 6 allows it); say so in the module comment.
- **Acceptance:** tests replay T-401's fixtures (registry status from the fixture's `registry` series) and assert the exact event sequence for: plain finish; long Bash; foreground subagent; background subagent (nothing at the early `Stop`, one `waiting` at the end); background shell still running (`waiting` fires); permission dialog approved; denied; AskUserQuestion; plan approval; two dialogs in a row (two `prompt`s); `PermissionRequest` + `PreToolUse` for one call (one `prompt`); blocking user Stop hook (one `waiting`, at the real end); API error (`waiting`); Esc (nothing); `/compact` per T-401's finding.
- **Blocks:** T-405 · **Blocked by:** T-401, T-402

### T-403: Alert settings file and spawn injection for every Claude instance
- **Type:** feature
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#story-1-hooks-reach-only-the-instances-multi-code-launches`
- **Knowledge:** `docs/knowledge/tech-conventions.md#a-hook-is-how-the-managers-own-tool-calls-become-visible-added-2026-09-16`, `docs/knowledge/business-overview.md#multi-backend-architecture-planned-2026-05-18` (Zero-residue principle)
- **Code:** `workspace/app/src/main/manager-mcp/config.ts`, `workspace/app/src/main/manager-mcp/index.ts`, `workspace/app/src/main/backends/claude.ts` (`spawn`, `buildEnv`, `INHERITED_CLI_MARKERS`), `workspace/app/src/main/backends/opencode.ts` (its spawn env), `workspace/app/src/main/backends/types.ts` (`SpawnOptions`), `workspace/app/src/main/process-manager.ts` (`spawnProcess`), `workspace/app/src/main/shell-manager.ts` (env)
- **Description:** Every Claude instance, project sessions and the manager alike, spawns with `--settings <userData>/alert-settings.json`, written once at startup right after T-402's server is up (port and token are per run) and removed on shutdown with the manager's files.
  - **Hooks registered = exactly the events T-404 consumes**, as settled by T-401: at least `UserPromptSubmit`, `Stop`, `StopFailure`, `PermissionRequest`, `PreToolUse` with matcher `^(AskUserQuestion|ExitPlanMode)$`, plus the post-dialog and elicitation events T-401 found, plus `SessionStart` (T-408 uses it to tell hooks are working). Add an all-tools `PreToolUse`/`PostToolUse` only if T-404 needs it **and** T-401 item 13 shows `"async": true` keeps it off the tool call's critical path (PRD Overhead NFR).
  - Each hook runs `curl -K '<userData>/alert-hook.curl' -H "X-Multicode-Instance: $MULTICODE_INSTANCE_ID" || true`, `timeout: 5`. The curl config follows `writeHookCurlConfig` exactly (token behind 0600, `max-time = 2`, `output = "/dev/null"`, `silent`), pointed at `/alert` with the alert token.
  - **Write `alert-settings.json` at 0600** (unlink, write with `mode: 0o600`, `chmodSync`), unlike `writeManagerSettings` today, which writes without a mode. PRD Story 1 requires it.
  - Set `MULTICODE_INSTANCE_ID=<instance id>` in that instance's spawn env. Strip any inherited `MULTICODE_INSTANCE_ID` from every env Multi-Code builds (Claude and OpenCode spawns, `shell-manager.ts` terminals): a dev build launched from inside a Multi-Code session would otherwise hand the parent's id to its children.
  - The manager needs its activity hooks and the alert hooks: pass two `--settings` flags if T-401 item 12 shows both apply, otherwise one merged manager file.
  - When `getAlertTarget()` is null, spawn without the flag and trace why.
  - No `permissions` block, ever.
- **Acceptance:** unit tests: settings JSON shape; file mode 0600; the manager gets both hook sets; a userData path with a space survives quoting; the instance id reaches the env of its own spawn only, and an inherited one is stripped. Manual, recorded in the task outcome: start a project session in Multi-Code and see `[alert-hook]` traces for `SessionStart`, `UserPromptSubmit`, `Stop`; run `claude` in Terminal.app at the same time and see none; `~/.claude/settings.json` and the project's `.claude/` are byte-identical before and after; the user's Bedrock env and allow rules still apply inside the Multi-Code session.
- **Blocks:** T-405 · **Blocked by:** T-401, T-402
- **Notes:** a token in an env var would be expanded into the hook's argv by the shell (see tech-conventions), which is why only the non-secret instance id travels that way.

### T-405: Wire the hook logic in and remove the guessing
- **Type:** refactor
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#story-5-everything-that-relied-on-the-old-detector-keeps-working`
- **Knowledge:** `docs/knowledge/tech-conventions.md#the-write-safety-gate-is-not-the-place-to-fix-a-timing-bug-added-2026-09-15`, `docs/knowledge/tech-conventions.md#agent-state-comes-from-the-agent-never-from-terminal-timing-added-2026-10-06`
- **Code:** `workspace/app/src/main/process-manager.ts` (`spawnProcess`, `attachSession`), `workspace/app/src/main/backends/claude.ts` (`ClaudeCompletionDetector`, `createCompletionDetector`), `workspace/app/src/main/backends/types.ts` (`Backend`, the `createCompletionDetector` doc comment), `workspace/app/src/main/manager-mcp/wait-tools.ts`, tests that fake a claude backend: `workspace/app/src/main/process-manager.write-gate.test.ts`, `workspace/app/src/main/process-manager.live-session.test.ts`, `workspace/app/src/main/process-manager.session-resolution.test.ts`, docs: `README.md` and `README.zh-CN.md` (how detection works), `CLAUDE.md` (Session monitoring, Data Storage)
- **Description:** For Claude instances, create T-404's object at spawn (it needs no session id), give it a registry reader for that pty's pid (`~/.claude/sessions/<pid>.json`, as `findClaudeLiveSessionId` reads it), and feed it the deliveries T-402 routes by instance id. Its events go through the exact path `attachSession` uses today: `runState.onActivity`, `lastActivityAt`, `refreshContextUsage` on `waiting`, `instance-activity` to the renderer except `prompt-cleared`, `remoteServer.broadcastActivity`, `emitActivity`. Session discovery and `syncLiveSessionId` stay, because transcripts and context usage still read the JSONL; only the Claude completion detector stops being created. Delete `ClaudeCompletionDetector` (JSONL `end_turn` tail, 2s timer, unpaired-`tool_use` + PTY-silence check, `PROMPT_PENDING_MS`, `PTY_IDLE_MS`) and its tests; rewrite the `createCompletionDetector` doc in `types.ts`, which describes `end_turn`. Update the fake backends in the three process-manager tests to drive activity through the new seam. OpenCode is untouched. Docs: `README.md` / `README.zh-CN.md` sections on how completion is detected; `CLAUDE.md` Session monitoring, and Data Storage listing the new `alert-settings.json` and `alert-hook.curl` alongside the manager's existing `manager-settings.json` and `manager-hook.curl`, which it already omits.
- **Acceptance:** `pnpm test`, `pnpm type`, `pnpm lint` green. With a real session in Multi-Code: manager `wait_for_idle` returns `idle` at the end of a turn and not during a background subagent; `send_task` to an instance on a permission dialog is refused as blocked; context usage updates after a turn; a paired phone shows an AskUserQuestion's options and drops them when answered at the desk; `start_session` still reports ready on a `--continue` session (its PTY-quiet readiness path in `wait-tools.ts` is a different question and stays). `grep -rn "end_turn\|PTY_IDLE_MS\|PROMPT_PENDING_MS" workspace/app/src/main` finds nothing outside transcript reading.
- **Blocks:** T-406, T-408 · **Blocked by:** T-403, T-404

### T-406: Chat-app alert rules in the renderer
- **Type:** feature
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#story-4-alerts-behave-like-a-chat-app`, and the **Acknowledge** definition in `docs/specs/attention-alerts/prd.md#definitions`
- **Code:** `workspace/app/src/renderer/App.tsx` (activity listener, `handleSelect`), `workspace/app/src/renderer/audio/attentionPolicy.ts` and `attentionPolicy.test.ts`, `workspace/app/src/renderer/audio/sounds.ts`, `workspace/app/src/renderer/hooks/useNotifications.ts`, `workspace/app/src/renderer/components/ContactList.tsx` (to tell contact-list clicks apart), `workspace/app/src/main/ipc-handlers.ts` (`bounce-dock`), docs: `README.md` "Notification behavior" and How It Works step 5, `README.zh-CN.md` equivalents
- **Description:** Replace the attention policy with the builder's rules, for every backend:
  - Every `waiting` or `prompt` activity, for any instance: play the chime, add the red dot, send `bounce-dock` (already `app.dock.bounce("critical")`, which macOS keeps bouncing until the app is activated and ignores while it is frontmost).
  - Remove suppress-while-watching, the urgent override, the 5s cooldown, and the 1.5s auto-clear of the selected instance's red dot (`App.tsx`, the `setTimeout(() => markRead(id), 1500)`).
  - **Acknowledge** = a `keydown`, or a `pointerdown` outside the contact list, while an instance is selected → clear that instance's red dot and stop its chime. Selecting a contact acknowledges that contact (as `handleSelect` already does for the dot), and does not acknowledge the one being left. Register the window listeners in the **capture** phase: xterm handles keys on its own hidden textarea and some components stop propagation, so bubble-phase listeners can miss input. Window focus alone clears nothing.
  - **New sound API** in `sounds.ts` (today `playMessageSound()` takes no argument and nothing can stop it): `playMessageSound(instanceId)` keeps that instance's `AudioBufferSourceNode`, and `stopMessageSound(instanceId)` stops it. A new event for an instance whose chime is still playing restarts it.
  - Update `README.md` "Notification behavior" and How It Works step 5, and the `README.zh-CN.md` equivalents, which describe the auto-clear being removed.
- **Acceptance:** `attentionPolicy.test.ts` rewritten for the new rules, or the module and its test deleted if nothing is left to decide. Manual: with the instance selected and the window focused, a finished turn chimes and the dot stays; a keystroke in the terminal clears it; a click in the compose box clears it; clicking another contact clears that contact's dot and leaves the first one's; with Multi-Code behind another app, the Dock bounces until Multi-Code is brought forward, and the dot is still there after ⌘Tab back.
- **Blocks:** T-407 · **Blocked by:** T-405 (sequencing; see Task Overview)

### T-407: Track 1 QA pass
- **Type:** qa
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#success-metrics`
- **Code:** read-only; scenarios run in the app under `MULTICODE_DEBUG=1` (trace at `$TMPDIR/multicode-debug.log`)
- **Description:** Run every M1 "Done when" line in the real app against real sessions, plus: two instances on the same `cwd` (each alert lands on its own contact); `/clear` mid-session (alerts keep working on the new session); the manager running alongside project sessions; Multi-Code quit while a session is busy (no orphaned hooks, files removed); Multi-Code force-killed (leftover files inert, plain `claude` unaffected). Never run two Multi-Code builds at once: they share one `userData` and would overwrite each other's alert files. Then a week of normal use against the success metrics. Bugs become T-4xx tasks below.
- **Acceptance:** a test plan with each scenario's result recorded in this file's task outcome; the trace shows exactly one event per finished request and per dialog; no open bug blocks M1.
- **Blocks:** T-409 · **Blocked by:** T-406

---

## Milestone 2: Know when alerts are degraded

**Goal:** when a user's settings stop hooks from running, Multi-Code says so on the
contact and still alerts from the CLI's own registry.

**Tasks:** T-408

**Done when:**
- With `"disableAllHooks": true` in the user's settings, a session shows the degraded indicator with its reason on hover
- That session still chimes when it finishes and when it opens a dialog, and does not chime on Esc
- A session whose hooks work shows no indicator and never alerts from the registry

### T-408: Degraded indicator and registry fallback
- **Type:** feature
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#story-6-a-visible-fallback-when-hooks-cant-run`
- **Knowledge:** `docs/timeline/2026-10-06_attention-alerts-investigation.md#what-the-cli-itself-reports-measured-cli-21290`
- **Code:** `workspace/app/src/main/process-manager.ts`, `workspace/app/src/main/backends/claude.ts` (`findClaudeLiveSessionId` already reads `~/.claude/sessions/<pid>.json`), `workspace/app/src/renderer/components/ContactList.tsx`, `workspace/app/src/shared/types.ts`
- **Description:** If the instance was spawned without alert settings (T-402's `getAlertTarget()` was null), or no `SessionStart` delivery has arrived N seconds after the CLI's registry entry appears (both happen at the end of startup; N from T-401's timings, ~10s), mark the instance degraded, surface it on `InstanceInfo`, and show a small indicator on the contact whose tooltip names the likely cause (`disableAllHooks`, managed hooks only). While degraded, poll that pid's registry file every 500ms: `busy`→`idle` raises `waiting` unless something was written to the instance in the preceding 2s (an Esc is a write); any move to `waiting` raises `prompt` with no detail; leaving `waiting` raises `prompt-cleared`. A delivery arriving later clears the degraded state and stops the polling.
- **Acceptance:** unit tests for the registry transition mapping with an injected clock; manual run with `disableAllHooks` per M2's "Done when".
- **Blocked by:** T-405

---

## Milestone 3: OpenCode on its own plugin (Track 2)

**Goal:** OpenCode agents alert exactly like Claude ones, from OpenCode's own plugin
events instead of database polling and screen parsing.

**Tasks:** T-409, T-410, T-411, T-412 — sketched, detailed when M1 ships.

**Done when:** Story 7's acceptance criteria hold.

### T-409: OpenCode plugin spike
- **Type:** qa
- **Status:** backlog
- **Requirement:** `docs/specs/attention-alerts/prd.md#story-7-opencode-reports-through-its-own-plugin-track-2`
- **Knowledge:** `docs/timeline/2026-10-06_attention-alerts-investigation.md#opencode-source-research-anomalycoopencode-dev--652c090--11834`
- **Description:** On the then-current OpenCode (re-check the version; v2 renames events), measure the PRD's Track 2 unknowns with the plugin injected through `OPENCODE_CONFIG_CONTENT`: a user plugin and a global `AGENTS.md` both still applying; the event sequence of an API-error stop; "Allow always", reject, and multi-question dialogs; a subagent's permission request; Esc while a permission is open. Save sequences as fixtures under `workspace/app/src/main/backends/__fixtures__/opencode-plugin/`.
- **Blocked by:** T-407

### T-410: OpenCode plugin and `OPENCODE_CONFIG_CONTENT` injection
- **Type:** feature
- **Status:** backlog
- **Description:** Write a plain-JS, report-only plugin to `<userData>/opencode/multicode-plugin.js`: one named export that is the plugin function and nothing else exported; no Bun-only APIs; does nothing unless `MULTICODE_INSTANCE_ID` is set; init guarded by a `globalThis` flag (init can run twice) and kept fast (it blocks bootstrap); handlers queued FIFO; posts with `fetch` and a short `AbortSignal.timeout` to `/alert`, every error swallowed; never writes to stdout. Token read from a 0600 file, not the env. Each OpenCode spawn gets `OPENCODE_CONFIG_CONTENT={"plugin":["<pathToFileURL(file).href>"]}` merged into any value the user already set, plus `MULTICODE_INSTANCE_ID`. **Not** `OPENCODE_CONFIG_DIR`: it drops the user's global `AGENTS.md`.
- **Blocked by:** T-409

### T-411: OpenCode plugin-driven detector, old detection removed
- **Type:** refactor
- **Status:** backlog
- **Description:** Finished = the root session's `session.status` going busy→idle (ignore `session.idle`; suppress after a `MessageAbortedError` in that turn; an error followed by idle chimes). Needs you = `permission.asked`/`question.asked` from any session of the instance, subagents included (parent ids cached from `session.created`/`session.updated`). Cleared by `permission.replied`, `question.replied`/`question.rejected`, or the session going idle or erroring. Also accept the v2 names. Emit the same activity vocabulary as T-404; remove SQLite completion polling and screen-parsed dialog detection, keeping transcript and context reads.
- **Blocked by:** T-409, T-410

### T-412: Track 2 QA pass
- **Type:** qa
- **Status:** backlog
- **Blocked by:** T-411
