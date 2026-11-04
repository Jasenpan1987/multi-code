# OpenCode 2 event fixtures (T-601)

Recorded 2026-10-20 against OpenCode **2.0.32** (`~/.opencode/bin/opencode`), fully isolated: every state
path under `/tmp/oc2-spike/`, scratch service on 127.0.0.1:49411, free model
`opencode/deepseek-v4.1-flash-free`, no login. Evidence and analysis:
`docs/timeline/2026-10-20_opencode-v2-spike.md`. The probe harness (`oc.sh`, `events.py`, `tui.py`,
`fixtures.py`, `dbdump.py`) lives in the gitignored `.omt/probes/opencode-v2/` of the main tree.

## Shape

```jsonc
{
  "scenario": "permission-reject",
  "opencodeVersion": "2.0.32",
  "notes": "what was done, keys, what the TUI showed, anything surprising",
  "frames": [                       // every SSE data frame of the window, in arrival order
    { "t": 972, "event": { "id": "evt_…", "created": 1792431468449, "type": "session.created",
                           "location": { "directory": "…" }, "data": { … }, "durable": { … } } },
    { "t": 5854, "stream": "disconnect", "reason": "eof" },        // subscriber-side markers
    { "t": 6377, "stream": "connect", "status": 200, "service": { "id": "…", "pid": 2549, … } }
  ],
  "omitted": { "repeatedDeltaFrames": { "session.text.delta": 90 } },  // only the first *.delta of each type is kept
  "inputs": [ { "t": 959, "key": "Enter" }, { "t": 33, "key": { "text": "typed prompt" } } ],
  "http": [ { "t": 0, "method": "POST", "path": "/api/session/…/reply", "body": { … }, "status": 204 } ],
  "pluginRoutes": [ { "t": 11, "route": { "type": "session", "sessionID": "ses_…" } } ],  // probe TUI plugin
  "marks": [ { "t": 5789, "mark": "service restart issued" } ]
}
```

- `t` is ms since the scenario's start mark (taken just before the prompt was typed; `/new` happened
  before it). Frames are as received, except strings longer than 240 chars, cut to 200 + `…`.
- `inputs` keys: `Enter`, `Esc`, `Left`, `Right`, `Up`, `Down`, `Tab`, digits, or `{text}` for typed text.
- `http` = calls the probe made with the scratch credentials (password never stored); bodies of 4xx
  and GET responses are kept.
- Heartbeat comments (`: heartbeat`, every 15.0 s) are not in the fixtures.
- Session, request and form ids are real scratch ids; directories are the physical `/private/tmp/…`.
- `db-rows.json`: `session_v2` and `session_message` rows of five scratch sessions (four trees) plus the
  V2 DDL, for T-606's fixture DB (JSON columns parsed; stringify on insert).

Scratch config during the scenarios (V2 defaults ask for nothing, see below):
`{"model":"opencode/deepseek-v4.1-flash-free","permissions":[{"action":"shell","resource":"*","effect":"ask"}]}`,
plus `question → ask` for permission-no-save only and `shell "sleep *" → allow` for service-restart only.
TUI env: `OPENCODE_CLI_CONFIG_CONTENT={"tabs":{"mode":"off"},"keybinds":{"terminal.suspend":"none"},"plugins":[{"package":"/tmp/oc2-spike/plugin","options":{…}}]}`.

## Scenarios

| Fixture | Done | Keys / API | Key frames, in order |
|---|---|---|---|
| plain-finish | one short prompt | type, Enter | `execution.started` … `execution.succeeded`, `session.viewed` |
| api-error | `opencode run -m opencode/no-such-model-t601` (not the TUI) | none | `execution.started`, `execution.failed{error:{type:"provider.no-route",message}}` 1 ms later |
| interrupt-esc | long story, double Esc while streaming | Esc, Esc (250 ms) | `execution.interrupted{reason:"user"}` only |
| permission-once | shell `touch` asks | Enter | `permission.asked{save:["touch *"]}`, `permission.replied{once}`, tool runs, `execution.succeeded` |
| permission-always | shell `touch` asks | Right, Enter | `permission.replied{always}`; rule saved per project in DB `permission` |
| permission-reject | root dialog, Reject | Right, Right, Enter | `permission.replied{reject}`, then (+1 ms, same ms together) `tool.failed{aborted}`, `step.failed`, `execution.interrupted{shutdown}` |
| permission-esc | root dialog, Esc | Esc | same as permission-reject |
| permission-reject-reason | reason typed in the TUI; only offered for a **subagent's** request | Right, Right, Enter, type reason, Enter | child `permission.replied{reject}` (no message in the event), child continues and `succeeded`, root `succeeded` |
| permission-no-save | `question` permission made to ask by a config rule | Enter, then digit 2 on the form | `permission.asked` with **no `save` key**; dialog shows Allow once / Reject only |
| permission-api-once | answered by API | `POST …/permission/:id/reply {decision:"once"}` → 204; again → 404 | TUI dialog closes by itself |
| permission-api-reject-reason | root, reject with message by API | `{decision:"reject",message}` → 204; again → 404 | turn continues, `execution.succeeded`, no interrupted |
| question-single | 3 options | Down, Enter | `form.created{metadata.kind:"question"}`, `form.replied{q0:"Banana"}` |
| question-multi | multiselect | Enter, Down, Down, Enter, Tab, Enter | `form.replied{q0:["Cheese","Olives"]}` |
| question-two | two fields, one form | 2, 1, Enter | digits pick and advance; `form.replied{q0:"Coffee",q1:"Small"}` |
| question-dismiss | Esc on the form | Esc | same ms: `form.cancelled`, `tool.failed`, `step.failed`, `execution.interrupted{shutdown}` |
| question-api | answered by API | `POST …/form/:id/reply {answer:{q0:"Saturn"}}` → 204; again → 409 | TUI shows the answer |
| question-api-custom | typed answer by API | `{answer:{q0:"Autumn, my own answer"}}` → 204 | `form.replied` carries the text |
| question-api-dismiss | extra: dismiss by API | `DELETE …/form/:id` → 204; again → 409 | `form.cancelled`, `execution.interrupted{shutdown}` |
| interrupt-pending-permission | extra: interrupt while a permission is open | `POST /api/session/:id/interrupt` → 200 | `execution.interrupted{user}` and **no `permission.replied`**; snapshot empty, reply → 404; TUI keeps a stale dialog until a key |
| subagent-permission | root spawns a `general` subagent whose shell asks | Enter | child `session.created{parentID}`, child `execution.started`, `permission.asked` with the **child's** sessionID, child `succeeded`, root `succeeded` |
| subagent-reject-noreason | extra: plain Reject inside a subagent | Right, Right, Enter, Enter (empty reason); later Esc, reason, Enter | only the **child** is `interrupted{shutdown}`; the root carries on, spawns a new subagent that asks again, and ends `succeeded` |
| two-roots | A running, `/sessions` to B, prompt in B | `/sessions`, Down, Enter, type, Enter | both in `/api/session/active`; B starts and ends inside A's turn; `session.viewed` only for B |
| service-restart | `opencode service restart` during shell `sleep 30` | none (CLI) | stream EOF (no interrupted frame), reconnect +523 ms to a new id/pid, `server.connected`, resumed steps, one `execution.succeeded`. The resume's `session.synthetic` and `execution.started` never arrive |
| service-restart-resumes-rejected | extra: what the first restart did | interrupt API ×4 to clean up | the new service resumed the four roots that had ended `interrupted{shutdown}` by Reject/Esc/dismiss; they asked again (`permission.asked`, `form.created`) with no `execution.started` seen |

## Surprises worth a test

- A Reject or a dismissal ends the turn as `interrupted{shutdown}`, which keeps the execution claim, so
  the **next service start resumes that turn** and it asks again.
- A resumed turn's `session.synthetic` and `session.execution.started` are published before any
  subscriber can reconnect: only `GET /api/session/active` after `server.connected` shows it running.
- A plain Reject inside a subagent does not end the root's turn.
- An interrupted turn drops its pending permission without a `permission.replied`.
- `permission.asked` and `form.created` carry `location`; `session.execution.*` do not.
