# 2026-10-20 — OpenCode 2.0.32 source reading for the opencode-v2 epic

Research only; no Multi-Code code changed. The builder upgraded this machine to OpenCode 2.0.32 the same day (official installer, `~/.opencode/bin/opencode`; the npm `@opencode/cli` copy and the 1.2.15 desktop app were removed) and asked for Multi-Code to move to 2.x only. This record is what the epic's tasks build on; the design decision itself is in docs/knowledge/decisions.md (2026-10-16 entries, still valid) and docs/specs/opencode-v2/prd.md.

Sources: `git clone --depth 1 --branch v2.0.32 https://github.com/anomalyco/opencode.git` (commit `843a6c5`), read by three parallel agents, and the builder's real `~/.local/share/opencode/opencode.db` opened only with `sqlite3 -readonly`. Nothing was run except `--help` with scratch XDG dirs. Paths below are inside the clone. "Inferred" marks a claim that rests on code outside the tree (OpenTUI, Effect).

## Builder decisions on this date

- 2.x only, confirmed. Dual support was offered if cheap; it isn't (every surface changed, see the 2026-10-16 table), so 1.x is dropped.
- A stopped contact raises no alerts. Stopping closes the TUI; a turn still running finishes in the shared service silently, and the next start reopens the session with the result in it.
- The epic runs in supervisor mode: parallel worktrees after the spike, decisions logged, one cross-model review, then one commit. Through the OMT workflow (prd, kanban, work, qa).

## What is broken today

- **V2 never writes the V1 tables.** The builder's DB finished the V1→V2 migration on 2026-10-19 16:39 (kv `migration.v1-v2` = `{"phase":"completed"}`); `session`, `message` and `part` were last written 2026-10-18 13:02. Multi-Code reads only those, so OpenCode transcripts, context usage, the secretary's brief and session lookups all stopped there.
- **Multi-Code's plugin doesn't run in V2.** It is a V1 plugin (named export function); "V1 plugin implementations do not run in V2" (`services/www/src/docs/content/migrate-v1.mdx`). Every OpenCode contact shows the alerts-off bar.
- **Its `OPENCODE_CONFIG_CONTENT` reaches the shared service** whenever a Multi-Code TUI is the one that starts it (below, "Shared service").

## Shared service

- **Registration:** `<XDG_STATE_HOME or ~/.local/state>/opencode/service.json` for channels latest/dev/beta/next, `service-<channel>.json` otherwise (`packages/cli/src/services/service-config.ts:41-44`). Fields `{id?, version?, url, pid, password?}`, 0600, written atomically (`packages/client/src/effect/service.ts:142-148`, `packages/cli/src/services/service-registration.ts:24-39`). `id` is a fresh UUID per service process. Not to be confused with `~/.config/opencode/service.json`, the CLI-owned config (port, password, env).
- **Address and auth:** `url` from the registration, default `127.0.0.1:49374` (`0xc0de`). HTTP Basic, user `opencode`, the registration's password (`packages/server/src/auth.ts:20`, `packages/client/src/service-probe.ts:52,96`). 401 `UnauthorizedError` otherwise. The password survives restarts.
- **Health:** `GET /api/info` → `{version, pid, urls, paths, capabilities?}`; 503 with `retry-after: 1` while starting or stopping. No `id` in it; identity is `id`+`version`+`url`+`pid` from the registration (`service-probe.ts:44-46`).
- **Who starts it:** any client that finds none. The service is spawned detached with `{ ...process.env, ...env }` of the client that started it (`packages/client/src/service-contender.ts:19-24`), then `chdir(home)`. It reads `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_*` from that env (`packages/cli/src/server-process.ts:112-129`). `opencode service start|restart|status|stop|get|set|unset` exist; `service start` does not replace a running service of another version.
- **Version replacement:** a plain `opencode` TUI uses `mismatch: "replace"` with exact version equality (`packages/cli/src/commands/handlers/default.ts:35-47`). It SIGTERMs the old service, SIGKILLs after ~5 s, deletes the registration, spawns a new one. Running turns end `interrupted{reason:"shutdown"}` with their claim kept; the new service resumes each claimed root session at boot with a `session.synthetic` "The server restarted while you were working…" (`metadata.notice:"restart"`) and a fresh `session.execution.started` (`packages/core/src/session/execution/restart.ts:15-16,77-99`). Pending permissions and forms are in memory only and are lost; a resumed turn asks again under new ids. An SSE subscriber gets no final event; the stream just drops.
- **The TUI pushes its environment per session.** `PUT /api/session/:id/environment` with all of `process.env` except the passwords, every time a TUI routes to a session and right after it creates one (`default.ts:143`, `packages/cli/src/env.ts:15-22`, `packages/tui/src/app.tsx:495-505`). In-memory, last TUI to view a session wins, lost on restart. Used only as the base env of the shell tool (`packages/core/src/shell.ts:258-273`). So anything in a Multi-Code TUI's env (`MULTICODE_*`, `OPENCODE_CLI_CONFIG_CONTENT`) reaches the agent's shell commands for sessions that TUI views.
- **Closing a TUI** (node-pty sends SIGHUP; handled at `app.tsx:288-294`) interrupts nothing. The turn runs on; a pending permission or form stays pending until some client answers it or the service shuts down.

## Event stream

- `GET /api/event`, SSE, `data: <JSON>\n\n` frames, no `event:` or `id:` lines (`packages/server/src/event-feed.ts:29-31`). Global across every location, no server-side filter. First frame `{"type":"server.connected"}`; `: heartbeat` comment every 15 s; the official client treats 45 s of silence as stalled (`packages/client/src/solid/connection.ts:35`). 4096-frame queue per subscriber; overflow fails that stream.
- **No replay.** No Last-Event-ID; the durable log endpoint is empty in the local service (events are persisted only in workerd). Every official client re-syncs from snapshot endpoints on each `server.connected` (`packages/tui/src/context/location.tsx:48`, `packages/client/src/solid/data.ts:635-655`).
- Envelope: `{id:"evt_…", created, type, location?:{directory, workspaceID?}, data}`; durable events add `durable:{aggregateID, seq, version}`. Route by `data.sessionID`; execution events probably carry no `location` (inferred).

### Events Multi-Code needs

| Event | Data | Notes |
|---|---|---|
| `session.created` | `sessionID, parentID?, location, title?, …` | The only event with `parentID`. Forks are roots (`fork` set, no `parentID`) |
| `session.deleted` | `sessionID` | Children first, each its own event |
| `session.execution.started` | `sessionID` | Turn begins. One per busy period |
| `session.execution.succeeded` | `sessionID` | Turn ended normally |
| `session.execution.failed` | `sessionID, error{type, message, status?}` | API error, given-up resume (`aborted`, after 10 attempts) |
| `session.execution.interrupted` | `sessionID, reason: user\|shutdown\|superseded\|inactivity` | `user` = interrupt endpoint (double Esc). `shutdown` is the default for any interrupt without a reason, **including a plain Reject of a permission and a dismissed question** (`packages/core/src/session/runner/step.ts:274-276`, `execution.ts:52`). `inactivity` = 60-minute eviction. `superseded`: no publisher found |
| `permission.asked` | `id:"per…", sessionID, action, resources[], save?[], metadata?, source?{type:"tool",messageID,id}, message?` | Ephemeral. Only when rules say "ask" |
| `permission.replied` | `sessionID, requestID, reply: once\|always\|reject` | Also published by core when a reject rejects the session's other pending requests, when an `always` auto-approves others, and on location close. **Not published when the turn is interrupted**: the request is just dropped (`packages/core/src/permission.ts:247-257`) |
| `form.created` | `form: {id:"frm_…", sessionID, title, metadata?, fields[]}` | `sessionID` may be `"global"` (MCP elicitation) |
| `form.replied` / `form.cancelled` | `id, sessionID[, answer]` | An interrupted ask cancels its form (`packages/core/src/form.ts:157-159`) |
| `location.shutdown` | `{}` with `location` | Eviction; permissions are rejected and forms cancelled first |

`session.status`, `session.idle` and `session.updated` are declared but never published. Busy and idle come only from `session.execution.*` and the snapshot.

OpenCode's own reference for these: the built-in notifications plugin maps `form.created` → "Input needs response", `permission.asked` → "Permission needs input", `execution.succeeded/interrupted/failed` → "Session done" (`packages/tui/src/feature-plugins/system/notifications.ts:44-74`).

### Subagents

`parentID` on `session.created` (`packages/schema/src/session-event.ts:56`) and on `Session.Info`. A dialog inside a child carries the child's `sessionID`; the permission to spawn a subagent is asked on the parent. Walk `parentID` to the root. Children inherit the parent's location.

### Snapshot endpoints

- `GET /api/session/active` → `{data: Record<sessionID, {type:"running"}>}`, process-wide. A session waiting on a permission is still active.
- `GET /api/session/:id/permission` → `{data: Request[]}`; `GET /api/session/:id/form` → pending forms. No cross-location list of either.
- `GET /api/session/:id` → `Session.Info {id, parentID?, fork?, location:{directory}, title?, model?, outcome?: succeeded|failed|interrupted, time{created, updated, idle?, …}, tokens, cost, …}`; 404 `SessionNotFoundError`.

## Answering dialogs through the API

- **Permission:** `POST /api/session/:sessionID/permission/:requestID/reply`, body `{decision: "once"|"always"|"reject", message?}`, 204. `reject` with `message` sends the reason to the model and the turn continues; without it the step ends. Unknown, already answered or other session's request → 404 `PermissionNotFoundError` (the official client treats 404 as done). Use the request's own `sessionID`.
- **"Always allow"** exists only when `save` is non-empty (`packages/tui/src/routes/session/permission.tsx:232-240`); the TUI labels are "Allow once" / "Always allow" / "Reject". `always` persists `save` per **project**, in the `permission` table, with no expiry (`packages/core/src/permission.ts:299-305`). With an empty `save`, `always` acts as `once`. Saved allows never override a configured `deny`.
- **Question:** the question tool asks through a form: `metadata: {kind: "question", tool: {messageID, id}}`, one field per question, `key: q<index>`, `title: header`, `description: question`, `type: "multiselect"` when `multiple`, else `"string"`, `options[].value = label`, `custom: true` (`packages/core/src/tool/plugin/question.ts:74-86,119-131`).
  `POST /api/session/:sessionID/form/:formID/reply`, body `{answer: {q0: "<label>"}}` for one pick, `{q0: ["A","B"]}` for multi-select, `{q0: "own text"}` for a custom answer. 204; 404 unknown; 409 `FormAlreadySettledError`; 400 bad answer.
  Dismiss: `DELETE /api/session/:sessionID/form/:formID[?message=…]`. Without a message the step is interrupted; with one the model sees it.

## Locations and the 60-minute eviction

A location is a directory string (no realpath). It is evicted after 60 minutes without a durable session event carrying its location (`packages/core/src/location-activity.ts:25,33-43`). Permission and form events are ephemeral and don't count; nor do SSE subscribers or API reads; there is no keep-alive. Eviction interrupts running sessions with `inactivity` (claim released, not resumed), rejects pending permissions, cancels forms and publishes `location.shutdown`. So a dialog left unanswered for an hour kills its turn.

## TUI

- **`--session <id>` / `-s`:** "Session ID to continue, or to create if it does not exist" (`packages/cli/src/commands/commands.ts:52-56`). If missing, the TUI opens on home and the first prompt creates the session under that id (`packages/tui/src/context/args.tsx:18`, `component/prompt/index.tsx:1232-1243`). Only the `ses` prefix is validated. The native format is `ses_` + 12 hex + 14 base62 (30 chars), time-descending (`packages/schema/src/identifier.ts`), so a caller can mint its own.
- **`--continue`:** newest root session for the exact directory, by `time_updated` (`app.tsx:655-680`).
- **Resume elsewhere:** `opencode -s <id>`, from any directory; the TUI prints `Continue  opencode -s <id>` on exit (`packages/tui/src/util/presentation.ts:32`).
- **`OPENCODE_CLI_CONFIG_CONTENT`:** read only by the CLI/TUI process, merged over `~/.config/opencode/cli.json` with the env winning (`packages/cli/src/config/config.ts:31-34,64-66,118-138`). Objects deep-merge, **arrays replace**: a `plugins` list here drops the user's own TUI plugins unless they are copied in. A value that doesn't parse or decode is dropped silently. Keys used: `tabs.mode: "off"` (auto = off only under `HERDR_ENV=1`), `keybinds["terminal.suspend"]: "none"` (default `ctrl+z` sends SIGTSTP to the process group, which freezes a node-pty child, `app.tsx:1160-1171`), `plugins`.
- **TUI plugins:** entries are directories (file targets are skipped) whose entrypoint is `<dir>/tui`, or npm specs, or `{package, options}` (`packages/tui/src/plugin/context.tsx:290-341`, `packages/plugin/src/host.ts:43`). Default export `{id, setup(ctx)}`. `ctx.ui.router.current()` returns the live route, `{type:"home"} | {type:"session", sessionID} | {type:"plugin", …}`, updated by `/new`, `/clear`, `/sessions`, `/open` (`packages/plugin/src/tui/context.ts:142-150,496-500`). Plain JS in the Bun process: `fetch`, `fs`, `process.env` available. Cleanups run on shutdown. Watch the route reactively through `ui.slot` + `createEffect` as the built-in stats plugin does (`packages/tui/src/feature-plugins/system/stats.tsx:190-213`), or poll it.
- **Nothing else tells an outside process which session a TUI shows**: no API lists clients, the OSC title is `OC | <title>` with no id, `tabs.json` is shared per cwd.
- **Slash commands:** `/rename <title>` sets the title in one go (bare `/rename` regenerates it with the model); `/new` goes home and the next prompt makes a session; `/clear` closes the tab, then as `/new`; `/compact`; `/sessions`, `/open`, `/cd`; **no `/cost`** (`/stats` opens a usage page).
- **Permission dialog keys:** left/right (or h/l), Enter; Esc rejects; no digits; opens on "Allow once"; a Reject in a subagent session opens a reason step. **Question form:** up/down, digits 1–9 pick, Enter, space toggles in multi-select, Tab between questions, a Submit tab when there are several fields, a "Type your own answer" row.
- **Terminal:** bracketed paste supported (3+ lines or 150+ chars fold to `[Pasted ~N lines]`); `@` opens file autocomplete; mouse capture on by default; kitty keyboard requested; OSC 0 title.
- **VS Code extension** (`sdks/vscode/src/extension.ts`): opens a terminal with env `OPENCODE_CALLER=vscode` (read by nothing) and types `opencode`. No args, no session id, never talks to the server.
- `CLAUDE_CODE_SSE_PORT` in the TUI's env makes it connect to that Claude-style IDE socket (`packages/tui/src/context/editor.ts:117`).

## Database

Same file as V1: `$OPENCODE_DB`, else `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db` (`packages/cli/src/database-path.ts:4-13`).

- **`session_v2`:** `id` PK, `parent_id`, `fork_session_id`, `directory` (stored directly, the TUI's physical cwd: 44 `/private/tmp/…` rows, 0 `/tmp/…`), `title`, `model` JSON `{id, providerID, variant?}`, cumulative `tokens_*`, `time_created/updated/idle/archived/suspended` in ms (`packages/core/src/session/sql.ts:22-77`). No index on `directory` or `time_created`; full scans are fine at a few hundred rows.
- **`session_message`:** `id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data` JSON (the message minus `id` and `type`). **Order by `seq`**: unique per session, not contiguous; `time_created` is rewritten. Indexed `(session_id, seq)` and `(session_id, type, seq)`.
- **Row types** (`packages/schema/src/session-message.ts:297-322`):
  - `user {text, files?, agents?, skills?}`: what was typed. Attachments are separate arrays. Command templates are expanded into `text` unmarked, as in V1.
  - `synthetic {text, description?}`, `system {text}`, `skill`: injected by OpenCode (plan reminders, background results, subagent completions, restart notices, migrated "user opened the file" reminders).
  - `shell {command, status, exit?, output?}`: a `!command` the human ran in the TUI.
  - `assistant {agent, model{id, providerID}, content[], tokens?, cost?, error?, finish?, time}`: one row per model step. `content[]` items: `text {text}`, `reasoning`, `tool {id, name, state{status: streaming|running|completed|error, input, …}}`. Running = `streaming` or `running`. A pending question shows as a running `question` tool.
  - `compaction`, `idle {outcome}`, `agent-switched`, `model-switched`, `location-switched`: bookkeeping.
- **Tokens:** `{input, output, reasoning, cache{read, write}}`, `input` excluding cache. A step still running has no `tokens`. Context = input + cache.read + cache.write of the newest assistant row with tokens (OpenCode's own UI also adds output and reasoning). A newer completed `compaction` makes older usage stale.
- **V2 tool names and inputs:** `shell {command}`, `read/write/edit {path}`, `patch {patchText}`, `grep/glob {pattern, path?}`, `webfetch {url}`, `websearch {query}`, `subagent {agent, description, prompt}`, `question {questions[]}`, `skill {id}`, `execute {code}`. No todo tool.
- **Migration** (`packages/core/src/database/v1-migration.bun.ts`): runs on server start until done, keeps **session ids and message ids unchanged** (460/460 sessions, 16692/16698 messages on this machine), turns running tools into `error`, and **keeps V1 tool names and keys** in migrated rows (`bash`, `task`, `apply_patch`, `todowrite`, `filePath`). Readers must accept both vocabularies.
- **Context window:** nothing per message or session. The models.dev catalog is cached in the same DB, kv key `models-dev:catalog`, value `{updatedAt, digest, body:"<api.json>"}`, readable with `json_extract(json_extract(value,'$.body'), '$."<provider>".models."<model>".limit')` (`packages/core/src/models-dev.ts:300-303`). The effective limit is that merged with the config's override (`packages/core/src/config/plugin/provider.ts:93-99`). Unknown models default to 200 000 in OpenCode.
- **Config:** `$OPENCODE_CONFIG_DIR`, else `<XDG_CONFIG_HOME or ~/.config>/opencode/opencode.json(c)`. V2 key `providers.<id>.models.<id>.limit.context`; the V1 key `provider` is still read and migrated (`packages/core/src/config/normalize.ts:168-176`), with two provider renames (`azure-cognitive-services`→`azure`, `google-vertex-anthropic`→`google-vertex`). The builder's config uses the V1 key.
- On this machine: 461 sessions in `session_v2` (254 roots), 17 182 messages.

## Consequences for the design

- Multi-Code mints `ses_` ids itself and always passes `--session`; discovery by polling the DB goes away.
- "Which session is this terminal on" needs the TUI plugin; nothing else answers it.
- State comes from one SSE connection to the service, re-synced on every connect; the service password stays in main.
- A Reject or dismissal ends the turn as `interrupted{shutdown}`, the same as a real service shutdown. Neither should chime, which happens to be right for both; the dialog's own reply event, or the request vanishing, tells them apart where it matters.
- A turn's end must close every dialog of its tree, because an interrupted permission sends no reply.
- Phone and secretary answers go through the reply endpoints; the arrow-key code goes.
- `OPENCODE_CLI_CONFIG_CONTENT` must carry the user's own `cli.json` plugins as well as Multi-Code's, or Multi-Code's TUIs lose them.
