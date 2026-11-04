# 2026-10-20 — OpenCode 2 spike (T-601)

**Type:** investigation (measured, no Multi-Code code changed)
**Participants:** AI (T-601 lane, supervisor mode)
**Epic:** `opencode-v2`

## Summary

OpenCode 2.0.32 was run in a fully isolated setup and measured: TUI plugin loading and route
watching (G-601), free-model turns with no login (G-602), the event stream for 24 scenarios saved as
fixtures (G-603), and where Multi-Code's environment ends up (G-604, G-605). Every gap has a measured
answer. Four findings change the design:

1. A Reject or a dismissed question ends the turn as `interrupted{shutdown}`, which **keeps the
   execution claim**, so the next service start **resumes** that turn and it asks again.
2. A resumed turn's `session.synthetic` and `session.execution.started` are published before any
   subscriber can reconnect. Only the snapshot after `server.connected` shows it running.
3. A plain Reject inside a **subagent** ends only the child. The root's turn carries on and later
   ends `succeeded`.
4. A service started by a Multi-Code TUI carries `MULTICODE_*` and `OPENCODE_CLI_CONFIG_CONTENT`, and
   **subagent shells of every client** (a plain terminal too) see them, because the shell tool falls
   back to the service's own env. Even after a clean start, a Multi-Code TUI still attached respawns
   a dead service with its own env.

## Method

- **Isolation.** One wrapper, `.omt/probes/opencode-v2/oc.sh`, runs `~/.opencode/bin/opencode` under
  `env -i` with `HOME=/tmp/oc2-spike/home`, `XDG_{DATA,CONFIG,STATE,CACHE}_HOME` and `TMPDIR` under
  `/tmp/oc2-spike/`, `OPENCODE_DB=/tmp/oc2-spike/data/opencode/opencode.db`,
  `OPENCODE_DISABLE_AUTOUPDATE=1`, a minimal `PATH`, `LANG`/`LC_CTYPE`, `SHELL=/bin/zsh`. `env -i`
  keeps out the calling shell's `ANTHROPIC_*`, `AWS_*`, `CLAUDE_CODE_*`, `MULTICODE_*` and
  `OPENCODE_*`. Without it, OpenCode would pick up the builder's providers from the environment. Extra
  variables only via `oc.sh --env NAME=VALUE`. Before any service could start: `oc.sh service set port
  49411` (free per `lsof`), confirmed with `oc.sh service get port` → `49411` and the scratch
  `config/opencode/service.json` → `{"port": 49411}`.
- **Event logger** (`events.py`): reads the scratch `state/opencode/service.json` on every
  (re)connect, opens `GET /api/event` with Basic `opencode:<password>`, appends every `data:` frame,
  comment and connect/disconnect with an epoch-ms timestamp to a JSONL log, and reconnects after
  0.5 s. The password is never written; a non-loopback URL is refused.
- **TUI driver** (`tui.py` + `ctl.sh`): the TUI in a PTY (160×50, `TERM=xterm-256color`), rendered with
  pyte, driven by command files; every key is logged with its time. `wait.py`, `last.py`, `api.py`
  (snapshot reads and replies, status logged) and `mark.sh` (scenario windows) complete the harness;
  `fixtures.py` turns the logs into the fixtures, `dbdump.py` dumps DB rows.
- **TUI plugin probe**: `/tmp/oc2-spike/plugin/tui.js` posts to a local listener (`listener.py`,
  127.0.0.1:49421) on setup (options, env names, `ctx` keys, route) and on every route change, both by
  polling `ctx.ui.router.current()` every 100 ms and reactively. Minimal plugins with other entry names
  test the loader.
- **Scratch config**: V2's default agent ruleset is allow-all (see "Corrections"), so to get dialogs
  the scratch `opencode.json` had `permissions: [{action:"shell", resource:"*", effect:"ask"}]`, plus
  `question → ask` for one scenario and `shell "sleep *" → allow` for the restart scenario.
- Reproduce: create `/tmp/oc2-spike/`, `oc.sh service set port <free port>`, start `events.py` and
  `listener.py`, then `uv run --with pyte python3 -I tui.py <run> <cwd> --env
  OPENCODE_CLI_CONFIG_CONTENT=… [-- --session ses_…]`, drive with `ctl.sh <run> type|enter|send|keys|screen`.

## G-602: free models, no login (answered: yes)

`oc.sh models` started the scratch service (pid 83849, `http://127.0.0.1:49411`) and listed 12 models,
all `opencode/*`: `big-pickle`, `cat-jam-free`, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`,
`ll-alpha-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`,
`muse-spark-1.3-contributor-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`,
`nemotron-3.5-super-vl-free`, `space-bunny-free`. Mechanism: with no key, the `opencode` provider is
enabled with `apiKey: "public"` and every model with a non-zero input cost is disabled
(`packages/core/src/plugin/provider/opencode.ts:347-371`).

`oc.sh run -m opencode/deepseek-v4.1-flash-free "Reply with exactly the word: pong"` printed `pong`
(04:23:03 → 04:23:16, exit 0); every `session.step.ended` in the spike has `cost: 0`. The model was set
as scratch default (`"model": "opencode/deepseek-v4.1-flash-free"`); it ran shell, question and
subagent tools reliably. The TUI showed a "Getting started" panel ("OpenCode includes free models…").

## G-601: TUI plugin (answered: loads, sees the route, gets its options)

- **Entry file:** a directory entry loads `<dir>/tui.js`, `<dir>/tui.mjs` or `<dir>/tui.ts` (all three
  measured; `Bun.resolveSync(<dir>/tui)` tries the extensions, `packages/plugin/src/host.ts:43`).
  `<dir>/index.js` does **not** load as a TUI plugin: `index` is the *server* entry. T-605: write
  `tui.js` (plain ESM, `export default {id, setup}`).
- **Options:** `{"package": "/tmp/oc2-spike/plugin", "options": {"probe": "x"}}` → `ctx.options`
  = `{"probe":"x"}`. A bare path entry loads too, with `ctx.options` = `{}`.
- **What the plugin sees:** it runs in the TUI process (`process.pid` = TUI pid 87691), with the TUI's
  env (names: `HOME, LANG, LC_CTYPE, LOGNAME, OPENCODE_CLI_CONFIG_CONTENT, OPENCODE_DB, …`), `fetch`
  works. `ctx` keys: `app, attention, client, data, keymap, location, markdown, options, renderer,
  storage, theme, themeMode, ui`; `ctx.ui`: `dialog, format, model, panel, router, slot, tabs,
  toast`. `ctx.app` = `{version:"2.0.32", channel:"latest"}`, `ctx.location.directory` =
  `/private/tmp/oc2-spike/projects/g601` (physical path). The cleanup returned by `setup` ran when the
  TUI got SIGHUP.
- **Route values** (fresh project, `--session ses_eaacb88b6ffeaRj2qqoGNRF9Sg` minted by the probe with
  the `identifier.ts` algorithm; delays from the Enter key to the reactive report):

  | Moment | `ctx.ui.router.current()` | Delay |
  |---|---|---|
  | start, minted id not yet in DB | `{type:"home"}` | at setup |
  | first prompt | `{type:"session", sessionID:"ses_eaacb88b…"}`; DB row under that id 11 ms after Enter | 18 ms |
  | `/new` | `{type:"home", location:{directory}}` | 16 ms |
  | prompt after `/new` | `{type:"session", sessionID:<new id minted by the TUI>}` | 15 ms |
  | `/sessions`, Down, Enter | `{type:"session", sessionID:<chosen>}` | 11 ms |
  | `/clear` | `{type:"home", location:{directory}}` | 15 ms |
  | start with `--session <existing id>` | `{type:"session", sessionID}` | at setup |

- **Watching the route:** both ways work. Reactive: inside `ctx.ui.slot({append:"app", render() {
  createEffect(() => report(ctx.ui.router.current())); return null }})`, with `createEffect` from
  `solid-js`. A static `import { createEffect } from "solid-js"` and `await import("solid-js")` both
  resolve to the host's copy from a plain JS file outside any `node_modules`. It fired 11-18 ms after
  Enter. Polling every 100 ms reported 25-95 ms after Enter. Recommendation: reactive, and copy the
  fields (the route is a store proxy).
- **No server event marks a route change.** `/sessions` and `/clear` produced no frame at all.
  `session.viewed {sessionID, idle}` is published after a turn ends in the session the TUI shows, so it
  cannot stand in for the plugin.
- **`tabs.mode:"off"`:** no tab bar. Control run without it: a tab row (`Gamma  +`) on the top line.
- **`keybinds["terminal.suspend"]:"none"`:** Ctrl+Z (`0x1a`) does nothing, the prompt keeps working,
  `ps -o stat` = `SNs+`. Control run with the default binding: Ctrl+Z runs `renderer.suspend()` and
  `process.kill(0,"SIGTSTP")`. In a PTY child the process group is orphaned, so the process is **not**
  stopped (`ps` still `SNs+`). The renderer stays suspended, though: the tty went back to cooked mode
  and echoed keys (`^Z^[[122;5uyz` on the input line), and nothing was processed until `kill -CONT`.
  So the TUI freezes, but `ps` can't detect it.
- **`plugins` in the env var vs `cli.json`:** with a dummy plugin in the scratch `cli.json` `plugins`:
  env var without `plugins` → the dummy loads; env `plugins:[probe]` → the dummy does **not** load
  (arrays replace); env `plugins:[dummy, probe]` → both load. Plugins discovered from
  `<config>/plugins/<dir>/` (and per the source `<project>/.opencode/plugins/<dir>/`) load whatever the
  env list says. T-605 has to copy only the user's `cli.json` `plugins` entries.

## G-603: event orders (fixtures in `workspace/app/src/main/backends/__fixtures__/opencode-v2/`)

24 fixtures, one per scenario, README there. The orders that decide T-604's rules:

| Scenario | What the subscriber gets |
|---|---|
| plain finish | `execution.started` … `execution.succeeded`, then `session.viewed` |
| API error (bad model id, via `opencode run`) | `execution.started`, `execution.failed{error:{type:"provider.no-route", message:"Model unavailable: …"}}` 1 ms later; no `status` |
| double Esc | `execution.interrupted{reason:"user"}`; first Esc shows "esc again to interrupt" |
| Allow once / Always allow | `permission.asked` → `permission.replied{once\|always}` → tool frames → `execution.succeeded`. `always` saves `{project_id, action:"shell", resource:"touch *"}` in the DB `permission` table |
| Reject, root (Right Right Enter, or Esc) | `permission.replied{reject}`, then 1 ms later and in one ms: `session.tool.failed{aborted}`, `session.step.failed`, `session.execution.interrupted{reason:"shutdown"}`. **The reply comes first.** No reason step for a root session |
| Reject with reason, API (root) | `permission.replied{reject}` (the message is not in the event), the turn continues, `execution.succeeded` |
| Reject with reason, TUI (subagent only, `permission.tsx:248`) | child `permission.replied{reject}`, child continues and succeeds, root succeeds |
| Reject without reason in a subagent | only the child: `execution.interrupted{shutdown}` on the child; root's subagent tool fails, the **root carries on** (it spawned a second subagent that asked again) and ends `succeeded`. In a subagent, Esc also opens the reason step |
| permission with no `save` | the question tool's own permission check (`question.ts:64`) made to ask: `permission.asked` has **no `save` key**; dialog "Allow once / Reject" |
| interrupt while a permission is open (`POST /api/session/:id/interrupt`) | `execution.interrupted{user}` and **no `permission.replied`**. `GET …/permission` → `[]`, a reply → 404. The TUI kept showing the stale dialog until a key; Enter closed it with no event |
| question answered (keys or API) | `form.created{form:{metadata:{kind:"question"}, fields:[{key:"q0", type:"string"\|"multiselect", options, custom:true}]}}` → `form.replied{answer}` → `execution.succeeded` |
| question dismissed (Esc) | in one ms: `form.cancelled`, `session.tool.failed{aborted "The user dismissed…"}`, `session.step.failed`, `execution.interrupted{shutdown}`. **`form.cancelled` comes first** |
| question dismissed by API (`DELETE …/form/:id`) | `form.cancelled`, `execution.interrupted{shutdown}` |
| subagent asks a permission | child `session.created{parentID:<root>, agent:"general"}` and its own `execution.started`; `permission.asked.sessionID` = the **child**; child `succeeded`, root `succeeded` 3.4 s later. The child's dialog shows in the parent's TUI view |
| two roots in one TUI | both in `GET /api/session/active`; B's turn started and ended inside A's; `session.viewed` only for the one on screen |
| service restart mid-turn | stream EOF (no `interrupted` frame arrives), reconnect after 523 ms to the new registration (`id` 702ee1b8… → f125a3de…, `pid` 2180 → 2549, same URL), `server.connected`, then the resumed turn's step frames and one `execution.succeeded`. The resume's `session.synthetic` (DB row 353 ms before the reconnect) and `execution.started` are never received |
| service restart, rejected turns | the new service resumed every root whose last turn ended `interrupted{shutdown}` by Reject, Esc or dismiss (4 sessions, each with a synthetic restart row). They asked their permission or question again under new ids; no `execution.started` arrived for them. Turns that ended `interrupted{user}` were not resumed (`packages/core/src/session/execution/restart.ts`: graceful shutdown keeps the claim on purpose; budget 10 resumes, then `execution.failed{aborted}`) |

Replies: permission reply → 204, again → 404 `PermissionNotFoundError`. Form reply → 204, again → 409
`FormAlreadySettledError`. `DELETE` form → 204, again → 409. The TUI closes its own dialog or form when
another client answers.

## G-604: who starts the service (recommendation: Multi-Code, from a clean env)

| Setup | Service env (`ps eww`) | Root session's shell (`env` run by the agent) | Subagent's shell |
|---|---|---|---|
| E1: TUI with `MULTICODE_INSTANCE_ID=probe-instance`, `MULTICODE_SPAWN_ID=probe-spawn`, `OPENCODE_CLI_CONFIG_CONTENT` starts the service (pid 2835, parent = the TUI) | `MULTICODE_INSTANCE_ID=probe-instance`, `MULTICODE_SPAWN_ID=probe-spawn`, `OPENCODE_CLI_CONFIG_CONTENT` present | sees all three | not measured in E1 (see dirty case below) |
| E2: `oc.sh service start` from the clean wrapper (pid 3003, parent 1), same TUI | none of them | still sees all three (the TUI pushes its env) | **none** (service env) |
| Dirty service (started by TUI E3, which then closed), a plain TUI with no `MULTICODE_*` | `MULTICODE_*` and `OPENCODE_CLI_CONFIG_CONTENT` | clean | **`MULTICODE_INSTANCE_ID=probe-instance`, `MULTICODE_SPAWN_ID=probe-spawn`, `OPENCODE_CLI_CONFIG_CONTENT`** |

The shell tool's base env is the session's pushed environment, else the service's own `process.env`
(`packages/core/src/shell.ts:258-263`). TUIs push env only for the root session they route to, so
subagents, resumed turns before any TUI re-pushes, and API-only sessions all run with the service's
env. A dirty service breaks Story 10 for plain `opencode` and VS Code.

Respawn: with S1 (a TUI whose env had `OPENCODE_CLI_CONFIG_CONTENT`) attached, `oc.sh service stop`
→ about 5.5 s later S1 had started a new service (pid 2732, parent S1) carrying S1's env.

**Recommendation:** before spawning an OpenCode TUI, if no live registration answers, Multi-Code runs
`opencode service start` itself with the environment it would give the TUI minus `MULTICODE_*`,
`OPENCODE_CLI_CONFIG_CONTENT` and `CLAUDE_CODE_SSE_PORT`, so the shared service gets the user's
environment. Trade-offs: it is one more process Multi-Code launches (a start of a missing service, not a
restart or replacement, so inside Story 10). It is not airtight: if the service dies while a Multi-Code
TUI is attached, that TUI respawns it with its env (5.5 s). T-603's client sees the drop at once and can
run the same clean `service start` first. `service start` does not replace a running service of
another version (source), so it is harmless when one is up. The alternative, accepting the leak, means
Multi-Code's ids reach subagent shells of the builder's plain terminals until the next service restart.

## G-605: the agent's shell env (answered: yes for root sessions; matters little)

Yes. Every TUI pushes its full env (minus passwords) for the root session it shows, so the agent's
shell commands in a Multi-Code contact's root session see `MULTICODE_INSTANCE_ID`, `MULTICODE_SPAWN_ID`
and `OPENCODE_CLI_CONFIG_CONTENT`, whoever started the service (E1 and E2 above). It can't be filtered
from outside. It matters only for a nested `opencode` TUI in the agent's shell, which would load
Multi-Code's plugin with the contact's ids and report its route as the contact's. A cheap guard for
T-605: pass Multi-Code's own pid in the plugin options and let the plugin stay inert unless
`process.ppid` matches (node-pty's child's parent on macOS still to be confirmed in T-605). Otherwise
accept it.

## Other facts measured

- `GET /api/event`: first frame `server.connected` with no `location`; `: heartbeat` every 15.0 s
  (160 heartbeats, median gap 15 002 ms); chunked transfer, so read decoded lines, not the raw socket.
- `session.execution.*` frames carry no `location`; `permission.asked`, `form.created` and most other
  session frames do. Execution events have `durable` set.
- `session.inbox.enqueued` carries the typed prompt (`item.payload.text`, `delivery:"steer"`) at once.
- `GET /api/session/:id` → `{data: {id, parentID?, agent, model, outcome, time{created,updated,idle},
  title, location}}`; unknown → 404 `SessionNotFoundError`. `GET /api/session/active` → `{data: {}}` when
  idle; a session waiting on a permission is listed as running. `GET /api/info` → `{version, pid, urls,
  paths:{tmp}, capabilities:{persistentPty:true}}`.
- Scratch DB after the spike: 13.4 MB + 1.6 MB WAL, of which 6.5 MB is the `models-dev:catalog` kv
  entry; 40 sessions, 165 messages (`assistant` 75, `user` 43, `idle` 42, `synthetic` 5). Not
  committed; `db-rows.json` in the fixtures holds five sessions (four trees) and the DDL.
  `json_extract(json_extract(value,'$.body'), '$."opencode".models."deepseek-v4.1-flash-free".limit')` →
  `{"context":200000,"output":32000}`.
- V2 DDL as observed: `session_v2` (`id, project_id, workspace_id, parent_id, fork_session_id,
  fork_boundary, slug, directory, path, title, version, share_url, summary_*, metadata, cost,
  tokens_{input,output,reasoning,cache_read,cache_write}, revert, permission, agent, model,
  time_created, time_updated, time_idle, time_viewed, idle_outcome, time_compacting, time_archived,
  time_suspended, resume_attempts`), indexes on `project_id`, `workspace_id`, `parent_id`,
  `time_suspended`. `session_message` (`id, session_id, type, seq, time_created, time_updated, data`),
  indexes `(session_id, seq)` unique, `(session_id, type, seq)`, `(session_id, time_created, id)`,
  `(time_created)`. Full text in `db-rows.json`.
- A subagent's first row is a `user` row holding the parent's prompt ("You are a subagent spawned by
  another session…"), so "typed = `user` rows" holds only for root sessions.
- A turn that ended `interrupted{shutdown}` has no `idle` row until its resume really ends (the
  rejected session: rows `user`, `assistant` (tool error), `synthetic` restart, `assistant`, then
  `idle{outcome:"interrupted"}` only after the final interrupt).

## Where the source-reading timeline was wrong or incomplete

- **Defaults:** V2's default agent ruleset is `* * allow` plus `read *.env` ask
  (`packages/schema/src/agent.ts:46-51`), so with no config nothing asks; the T-601 brief's "no allow
  rules, so a write asks" did not hold.
- **Reject/dismiss = `shutdown`:** correct, but the consequence was missed. The claim is kept and the
  turn is resumed at the next service boot. "Neither should chime, which happens to be right for both"
  holds only until the service restarts.
- **Resume events:** the synthetic notice and the fresh `execution.started` exist (DB rows confirm), but
  a subscriber never receives them, and it receives no `interrupted{shutdown}` for the cut turn either.
- **Ctrl+Z:** "SIGTSTP … freezes a node-pty child" gives the right outcome by a different mechanism. The
  process isn't stopped (orphaned process group); the renderer is suspended until SIGCONT.
- **Plugin `plugins` arrays replace:** true for `cli.json` entries only; discovered plugin directories
  load anyway.
- **Route type:** `home` after `/new` or `/clear` carries `location:{directory}`, which the declared
  `Route` type doesn't list.
- **Not in the event table:** `session.viewed`, `session.inbox.enqueued/delivered`, `shell.created/exited`,
  `session.tool.*`, `session.step.*`. A plain Reject in a subagent doesn't end the root. Esc in a subagent
  dialog opens the reason step (in a root, Esc rejects). A permission without `save` has no `save` key
  (not `[]`). The TUI respawns a dead service with its own env.
- Confirmed as read: `permission.replied` absent for an interrupted ask; `parentID` only on
  `session.created` and `Session.Info`; reply status codes; `ses_` ids minted outside are accepted;
  question form shape; physical `/private/tmp` directories; `always` saved per project.

## Consequences for the epic (for the supervisor)

- T-604: Story 3's rule "Reject without reason → nothing" holds for the root at the time. But a
  subagent Reject lets the root finish (Finished chime), and a service restart revives rejected or
  dismissed turns, which then raise Needs-you again. This needs a decision (e.g. a session whose last
  turn Multi-Code saw end as reply-reject/cancel + `interrupted{shutdown}` stays silent when it
  reappears after a re-sync). Re-sync on `server.connected` is the only way to see resumed turns.
- T-603: reconnect by re-reading the registration (the URL stayed the same, `id`/`pid` changed); 15 s
  heartbeat confirmed.
- T-605: entry `tui.js`; reactive route watch; copy `cli.json` plugins; the route is `home` until the
  first prompt even with `--session`; G-604 clean `service start`.
- T-606: the DDL above; the `user` row of a child session is not typed text.
- T-607: API replies close the TUI's own dialog; 404 and 409 are "already handled"; a reason exists
  for root permissions only through the API.

## Safety check (builder's real OpenCode)

| | Before (04:20:10) | After (05:02:23) |
|---|---|---|
| `~/.local/state/opencode/` listing | 8 entries, `service.json` 03:37 | identical |
| `service.json` (keys `id, password, pid, url, version`) | `face275c-…`, pid 55216, `127.0.0.1:49374`, 2.0.32 | identical |
| `~/.config/opencode/{service,cli,opencode}.json` mtimes | 03:37:17 / 03:37:17 / Oct 13 | identical |
| real DB mtime | 1792428821 (03:53:41) | 1792431224 (04:33:44) |
| `max(time_updated)`, rows in `session_v2` | 1792428142064, 461 | 1792428142064, 461 |

The DB mtime change is the builder's own service (pid 55216, running since 03:37): kv
`models-dev:catalog` `time_updated` = 1792431224509, the same second, and a WAL checkpoint at 04:43:18.
No session or message row changed (newest `session_message` 03:42:22). Every probe process had
`OPENCODE_DB` and the XDG dirs on scratch. The real log has no line mentioning `oc2-spike` or 49411.

One slip: before the wrapper existed, `opencode --version` ran once with the real environment
(04:20:10). It started nothing and touched no DB, state or config, but appended one `cli starting …
args=["--version"]` line (run `75c05c16`) to `~/.local/share/opencode/log/opencode.log`.

No process of the spike is left: the scratch services (83849, 2180, 2549, 2732, 2835, 3003, 3600) were
stopped by `oc.sh service restart` (83849, 2180) or `oc.sh service stop` (the rest), every TUI got SIGHUP, the logger and listener were killed by pid.
Only the builder's service 55216 and TUI 54907 run, untouched.

## Decisions made in the spike

- `env -i` wrapper instead of unsetting a list: the calling shell had Bedrock/Anthropic credentials.
- `OPENCODE_DISABLE_AUTOUPDATE=1` and a scratch `TMPDIR`: the binary and `/var/folders` are shared.
- Ask rules added to the scratch config, because V2's defaults ask for nothing.
- api-error driven by `opencode run -m <bad id>`: the TUI keeps its own model choice.
- Reject with a typed reason done in a subagent: the TUI offers it nowhere else.
- Five extra fixtures (permission-esc, question-api-dismiss, interrupt-pending-permission,
  subagent-reject-noreason, service-restart-resumes-rejected) because they settle open questions.
- Fixtures drop repeated `*.delta` frames (first kept, count recorded) and add `inputs`, `http`,
  `pluginRoutes`, `marks`.
- The scratch DB is not committed (13 MB, mostly the model catalog); `db-rows.json` replaces it.
- The four sessions resumed by the first restart were stopped with the interrupt API.
