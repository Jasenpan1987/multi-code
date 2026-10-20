# Test plan: OpenCode 2

**Epic:** `docs/specs/opencode-v2/prd.md` v1.1 · **Tasks:** `docs/specs/opencode-v2/kanban.md` (T-611)
**Run:** 2026-10-20, branch `oc2/t-611` at `7b94fa5` (the epic's integration commit)

## Result

**Three bugs, none of them in the alert path.** Every Finished / Needs-you row that ran passed on
a real OpenCode 2.0.32. What failed:

- **B-1 (medium):** the toolbox's **Clear** and **Compact** do nothing on OpenCode 2. The command
  lands in the input box and never runs.
- **B-2 (low):** the context figure doesn't reset after a compaction. It shows the old figure
  until the next turn.
- **B-3 (low):** a contact with no session on record gets a fresh session when another contact
  holds the directory's newest one. The PRD says it should open the newest one nobody holds.

**After the run (supervisor, 2026-10-20):** B-1 fixed (`sendSlash` types an OpenCode command, then
sends its Enter 250 ms later, the way `run_command` did in row 8.5); not yet re-run live. B-2 left
open as a known limit: the figure corrects itself on the next turn. B-3 kept as is, for parity
with Claude (a held newest session gives a fresh one), and PRD Story 1 reworded to match.

Stories 5 and 6 (phone, secretary) ran semi-live. The answer paths were called in the main
process with real dialogs and a real service, but with no phone, no speech server and no reply
interpreter. Everything that wasn't run says why.

`pnpm test` on the same build: 1358 passed, 28 skipped.

**After the cross-model review (2026-10-20):** the accepted findings fixed (list in the decision log), then a live re-run
of every changed path on the same isolated setup: all pass, B-1 included. See "Cross-model review
and live re-run" below. `pnpm test`: 1377 passed, 28 skipped.

## Setup

### Isolation

- **Scratch root** `/tmp/oc2-qa/`. Fake `HOME` `/tmp/oc2-qa/home`. Its `.zshrc` is the login
  shell Multi-Code reads. It exports the four `XDG_*` under `/tmp/oc2-qa/`,
  `OPENCODE_DB=/tmp/oc2-qa/data/opencode/opencode.db`, `OPENCODE_DISABLE_AUTOUPDATE=1`,
  `TMPDIR=/tmp/oc2-qa/tmp`, a marker `QA_LOGIN_SHELL_MARK=oc2-qa-zshrc` (to tell the login
  shell's env from any other), and
  `PATH=/tmp/oc2-qa/shim:/Users/jasenpan/.opencode/bin:/usr/bin:/bin:/usr/sbin:/sbin`.
  `/tmp/oc2-qa/shim` is empty except during the 1.x check.
- **Scratch service** on port 49431. Set with `opencode service set port 49431` under the scratch
  env (wrapper `qoc.sh`, `env -i` as the spike's `oc.sh`), confirmed with `service get port` →
  `49431`, before anything could start a service.
- **Scratch `opencode.json`:** model `opencode/deepseek-v4.1-flash-free`; `permissions`:
  `shell *` ask, `shell sleep *` allow, `shell env*` allow. Free model only: every
  `step.ended` cost 0.
- **The dev build** was the worktree's Electron binary, run under `env -i`. Its env:
  - `HOME=/tmp/oc2-qa/home`, `USER`, `LOGNAME`, `SHELL=/bin/zsh`, `LANG`, `TMPDIR`
  - the four `XDG_*`, `OPENCODE_DB`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `MULTICODE_DEBUG=1`
  - launchd's bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, as a Dock launch has

  Flags: `--inspect=127.0.0.1:9612 . --user-data-dir=/tmp/oc2-qa/userdata
  --remote-debugging-port=9611`. `MULTICODE_DEBUG` was there only for the trace log, which lands
  in the scratch `TMPDIR`. No `CLAUDE_CODE_SSE_PORT`, no other `MULTICODE_*`, no `OPENCODE_*`
  config variable. CDP's `/json` showed
  `file:///Users/jasenpan/code/apra/multi-code-t611/workspace/app/dist/renderer/index.html`.
- **The worktree had no Electron binary.** Electron 44.7.2 was extracted from the local download
  cache with the package's own `install.js`. Nothing was downloaded.
- **Audio** was muted with `webContents.setAudioMuted(true)`, so chimes were counted, not played.
  Background throttling was turned off: xterm paints nothing while the window is hidden behind
  others.

### Harness

The scripts are in the main tree's gitignored `.omt/probes/opencode-v2/qa/`.

| Script | What it does |
|---|---|
| `launch.sh`, `setup.sh` | Start the dev build and prepare it (mute, throttling off, recorder) |
| `q.mjs` | CDP to the renderer (9611) or the main process's inspector (9612); fails on `exceptionDetails` |
| `rec.js` | Logs every `instance-activity`, `instance-session-id`, `instance-alerts-degraded`, `instance-exit` and `unread-update` the renderer gets, with ms timestamps |
| `create.sh`, `start.sh` | The New Instance dialog with OpenCode selected; the contact's ▶ button |
| `type.sh` | `window.electronAPI.writeToInstance`: the text, then Enter 0.8 s later |
| `screen.js` | Reads `.xterm-rows` innerText |
| `mcp.sh` | The manager tools over the isolated app's MCP server. The token comes from the main process into a 0600 file and is never printed. The server writes no `manager-mcp.json` without a manager, and none was made, since a manager would run on Bedrock |
| `events.py` | Service SSE logger, the spike's, on the scratch registration. Ground truth for what OpenCode did |
| `api.py` | Scratch-service API calls, to act as "another client" |
| `tui.py` / `ctl.sh` | The spike's PTY driver, for plain `opencode` terminals under the scratch env |
| `err400.py` | A local stand-in provider that answers HTTP 400 |
| `squat.py` | Holds the service's port |

**Phone and secretary, semi-live.** The phone's tap path is `processManager.answerPhoneChoice`,
what `remote/ws-server.ts` `choose` calls. The secretary's apply path is
`processManager.answerDialog` with an `{answer}` plan, what the interpreter's output is fed to.
Both were called through the main process's inspector, on real dialogs.

### Contacts

| Contact | Project | Used for |
|---|---|---|
| `alpha` | `projects/alpha` | Most rows |
| `alpha 2` | `projects/alpha` | Duplicate of alpha, so two contacts on one project |
| `delta` | `projects/delta` | Project config pointing at a dead endpoint |
| `epsilon` | `projects/epsilon` | Project config pointing at `err400.py`, for the API error |
| `gamma` | `projects/gamma` | Plugin rows and some answer rows |

Plain `opencode` terminals ran in `projects/plain` and in `projects/alpha` (the VS Code-like one).

## Results

Times are epoch ms from the SSE log (`events.py`) and the renderer recorder.

### Story 1: an OpenCode contact starts on 2.x

| # | Check | Result |
|---|---|---|
| 1.1 | A new contact made in the New Instance dialog (OpenCode) starts the 2.x TUI in its directory, on the scratch service | **pass**: pty pid 44025 `opencode --session ses_ea944f370ffe7iNO3Gu9lNeLVB`. Screen: OpenCode 2.0.32 home, `/…/oc2-qa/projects/alpha`, "DeepSeek V4.1 Flash Free" |
| 1.2 | No service running: the pty's clean start starts it, with none of Multi-Code's variables and the login shell's PATH | **pass**: service pid 44027, parent 1. Its env (`ps eww`): no `MULTICODE_*` (not even `MULTICODE_DEBUG`, which the app had), no `OPENCODE_CLI_CONFIG_CONTENT`, `QA_LOGIN_SHELL_MARK` present, PATH = the `.zshrc` one plus the install dirs. Same at the second launch (pid 84219) |
| 1.3 | The session id Multi-Code minted is the one the first prompt creates | **pass**: `session.created ses_ea944f37…` at the first Enter (…536988) |
| 1.4 | Restart reopens the same session | **pass**: stop + ▶ → `--session` with the contact's current id, and the screen shows its last turn. After a stop mid-turn, the next start showed that turn's finished answer ("survived") |
| 1.5 | A duplicated contact gets a fresh session | **pass**: "alpha 2" spawned with a newly minted `ses_ea937fb0…`, absent from the DB until its first prompt created it |
| 1.6 | Two contacts on one directory don't share | **pass**: alpha 2's turn created its own session and chimed alpha 2 only. Alpha's id was unchanged |
| 1.7 | No session on record → the directory's newest root session no other contact holds, else fresh | **fail, B-3**. Between launches, `sessionId` was removed from both alpha contacts in the scratch `contacts.json`. Alpha 2, started first, got the newest root (`ses_ea938943…`), as it should. Alpha got a fresh minted id, although four older root sessions nobody held were there (`ses_ea9348ff…` "third", and others). The two contacts did stay apart |
| 1.8 | No tab bar; Ctrl+Z harmless | **pass**: the top line is the logo. A plain TUI under the same scratch env shows a tab row (`! Env variable grep via subagen +`). After `0x1a`, typed text appeared in the input box; `ps` stat `Ss+`. **Changed 2026-10-20 (PRD v1.3): tabs stay on.** Re-run: alpha shows its tab row; a mouse click on a tab switches it and the plugin reports the route; alpha 2 (same project) and alpha share their tabs live, and opening alpha 2's session in alpha's terminal leaves both contacts on their own sessions but makes both alert for it; `ctrl+tab` does nothing (xterm.js 5.5 sends it as a plain Tab) |
| 1.9 | The user's own settings apply: config, providers, TUI plugins | **pass**. The scratch config's model and ask rules applied. A project config's own provider applied (epsilon, delta). A TUI plugin in the scratch `cli.json` (`{package, options:{mine:true}}`) loaded in the contact's TUI (pid 89276) with its options, and Multi-Code's plugin reported beside it (spawn env `plugins: [dummy, multicode]`). Server plugins were not tried: Multi-Code passes nothing to the server (no `OPENCODE_CONFIG_CONTENT`) |
| 1.10 | Found when Multi-Code is launched from the Dock | **pass, as simulated**. The app's PATH was launchd's, and its `HOME` had no `~/.opencode/bin`, which is the case of an npm-under-nvm install. The binary was found through the login shell's PATH. Not an actual Dock launch; Homebrew and npm installs were not tried |
| 1.11 | The OpenCode terminal gets the login-shell environment | **pass**: `QA_LOGIN_SHELL_MARK` in the TUI's env and the service's. A subagent's `env` printed `QA_LOGIN_SHELL_MARK=oc2-qa-zshrc` |
| 1.12 | New Instance dialog, first open in a run, no OpenCode contact yet | **as decided** (`.omt/opencode-v2-decisions.md`, T-605: "may show missing on the very first open"). It said "`opencode` not found on PATH" at 0.3, 1 and 3 s, although the login shell had been read in 33 ms; it is checked only on open or backend change. Toggling the radio cleared it. With OpenCode contacts present (second launch) the first check was right. It only shows for an OpenCode that the login shell alone finds; the official installer's `~/.opencode/bin` is always searched |
| 1.13 | Sessions made under 1.x reopen | **not tested**: the scratch DB has no migrated sessions, and the builder's real DB is out of bounds for this run. Unit test `opencodeDb.test.ts` "reads a migrated session's 1.x tool names and keys"; T-606's read-only smoke on the real DB |

### Story 2: 1.x is refused

The fake 1.x was `/tmp/oc2-qa/shim/opencode`, first on the login PATH. It prints `1.18.35` for
`--version` and logs any other run.

| # | Check | Result |
|---|---|---|
| 2.1 | The New Instance dialog says so and names the upgrade command | **pass**: "OpenCode 1.18.35 found. Multi-Code needs OpenCode 2: run `curl -fsSL https://opencode.ai/v2/install \| bash`" |
| 2.2 | Starting an existing contact on 1.x launches nothing; its page says why | **pass**: overlay "OFFLINE / Multi-Code needs OpenCode 2 (found 1.18.35). Upgrade with: curl -fsSL https://opencode.ai/v2/install \| bash". The contact stayed stopped with no pty. The fake was never run beyond `--version`. The contact kept its session: with the fake removed, ▶ started that same session |
| 2.3 | No 1.x code path remains | **pass** (grep of non-test sources): no `FROM session `, `FROM message`, `FROM part`, `OPENCODE_CONFIG_CONTENT`, `question.v2` or `permission.v2`. `multicode-plugin.js` appears only in `manager-mcp/config.ts`'s cleanup of the old file |

### Story 3: Finished and Needs-you from the service

| # | Check | Result |
|---|---|---|
| 3.1 | Plain finish: one Finished within 1 s, with red badge, Dock count and acknowledge | **pass**: `execution.succeeded` …538845 → renderer `waiting` …538876 (31 ms). Badge "1", `app.dock.getBadge()` "1". A click in the page cleared both |
| 3.2 | API or model error: Finished, same chime | **pass**: epsilon on `err400.py`: `execution.failed {provider.invalid-request, 400}` …009350 → `waiting` …009351. A refused connection (delta, port 9) is retried by OpenCode ("Retrying in 6s · attempt 4") and raises nothing until the turn ends |
| 3.3 | Double Esc: nothing | **pass**: `interrupted {user}`, no activity (alpha, and delta mid-retry) |
| 3.4 | Reject without a reason: no Finished | **pass**: Right Right Enter in the terminal → `replied {reject}`, `interrupted {shutdown}`. Only `prompt` then `prompt-cleared` |
| 3.5 | Dismissed question: nothing | **pass**: Esc → `form.cancelled`, `interrupted {shutdown}`. Only the question's own `prompt` |
| 3.6 | Service restarted mid-turn (`opencode service restart`): no chime at the restart, the resumed turn finishes once, no bar | **pass**: stream EOF …665641. New service (`61cd6b2e…`, pid 76761) …666244; Multi-Code reconnected about 0.5 s later. The resumed turn ran its shell call again; `succeeded` …690011 → one `waiting` …690016. No degraded event |
| 3.7 | A permission or question: one Needs-you within 1 s, root or subagent | **pass**: `permission.asked` …667736 → `prompt` …667737; `form.created` …746320 → …746322. A subagent's permission raised `prompt` with the child session in its `DialogRef` |
| 3.8 | Answered anywhere clears Needs-you; so does the turn ending unanswered | **pass**, each `prompt-cleared` at the service's reply. Sources: Enter in the terminal; another client (`api.py` reply, 204); the phone path; the secretary path. With a permission open, `POST …/interrupt` from another client → `interrupted {user}` with no reply → `prompt-cleared`, no Finished |
| 3.9 | A subagent's end raises nothing; after a subagent's Reject the root's finish raises one | **pass**: child `succeeded` → nothing, root → one `waiting`. Phone Reject on a child's request → child `interrupted {shutdown}`, the root carried on ("subagent was refused") → one `waiting` |
| 3.10 | Sessions no running contact owns raise nothing | **pass**. A plain TUI in `projects/plain` (a subagent, two permissions, two turns) and a VS Code-like plain TUI in alpha's directory: no activity, no `/alert` delivery. Stopped contacts: see 11.2 |
| 3.11 | Connection dropped and back: state matches within 5 s, no second chime for a dialog already reported | **pass**: with a permission open, Multi-Code's own stream was cut through the inspector (`stream.abort`). It reconnected in about 0.5 s; the same request stayed the live prompt; no second `prompt` |
| 3.12 | A dialog unanswered for 60 min: Finished | **not tested live** (an hour). Unit test `opencodeAttention.test.ts` "a turn evicted after 60 minutes of inactivity finishes" |
| 3.13 | attention-alerts Stories 4 and 5 hold: `wait_for_idle`, write-safety gate, context refresh | **pass**. `wait_for_idle` returned at the turn's end (10 s, "alpha 2 finished after 11s"). `send_task` and `run_command` were refused while blocked ("waiting on a decision from you…"). The context figure moved after a turn (5,289 → 5,478) |
| 3.14 | A turn in a session the contact has left (`/new` mid-turn) still raises its Finished | **pass**: two `waiting` events, one per session (new …402862, left-behind …405883) |
| 3.15 | A session two contacts have both shown | **as decided** ("Left as is" in `.omt/opencode-v2-decisions.md`): alpha's `/sessions` into alpha 2's session; one turn there → `waiting` on both contacts, so two chimes for one turn. See "For the supervisor" |

### Story 4: following the shown session

| # | Check | Result |
|---|---|---|
| 4.1 | `/new` + prompt: the contact moves to the new session within 2 s | **pass**: `session.created` …272264, route …272272, renderer `instance-session-id` …272273. `contacts.json` updated |
| 4.2 | Context figure, `read_session`, `list_sessions` follow it | **pass**: figure 5,263 (the new session's); `read_session` showed only the new session's two entries |
| 4.3 | The next start reopens the new session | **pass** |
| 4.4 | `/sessions` to another root: adopted | **pass**: 4 ms after the route report |
| 4.5 | A session another running contact holds is not taken over | **pass**: alpha's `/sessions` into alpha 2's session → route reported, alpha's id unchanged (alerts: 3.15) |
| 4.6 | `/clear` + prompt: on the new session | **pass**, once `/clear` actually ran (B-1): the next prompt created `ses_ea9348ff…` and alpha 2 moved to it |
| 4.7 | A VS Code-like terminal on the same project keeps its own session | **pass**: its turn created `ses_ea93741b…`. Neither contact moved or chimed |

### Story 5: the phone, semi-live

No phone was paired. These rows call `processManager.answerPhoneChoice`, the method the phone's
`choose` frame reaches.

| # | Check | Result |
|---|---|---|
| 5.1 | A permission offers OpenCode's options | **pass**: the live prompt was "Allow once / Always allow / Reject" with a `DialogRef`. "Always allow" reads "OpenCode saves "touch *" for this project and allows it from now on". The two-option case wasn't raised live; unit test `opencodeAnswer.test.ts` "answers a two-option permission, with no always, by label and not by position" |
| 5.2 | A tap answers that exact request; an answered one is refused | **pass**. Index 1 on a permission → `reply: always`, and a `permission` row `{shell, "touch *"}` for the project. Index 0 on a subagent's request → answered on the child. Index 2 → reject. A tap with the buttons of a request another client had answered → `false`, which the phone shows as "That choice is no longer available" |
| 5.3 | A single-select question: one tap | **pass**: index 1 → `form.replied {q0: "Coffee"}`; the TUI closed its form, "You chose Coffee." |
| 5.4 | A multi-select question is read-only | **pass**: the tap returned `false` on "Question (multi-select)" |
| 5.5 | No keystrokes reach the TUI | **pass**: the instance's write counter didn't move (51 → 51) |
| — | For the builder by hand | Pair the phone. Answer a permission with each of the three buttons and a single-select question. Tap a dialog already answered at the desk and check the "no longer available" message. Check a multi-select box shows read-only |

### Story 6: the secretary, semi-live

No speech server, and no reply interpreter: it would run on the builder's Bedrock. These rows feed
`processManager.answerDialog` the plan the interpreter would produce.

| # | Check | Result |
|---|---|---|
| 6.1 | Reject with a reason the agent receives | **pass**: plan `{answer: {permission, reject, message}}` → `reply: reject`; the tool failed with the message, and the agent replied "secretary said no" → Finished |
| 6.2 | "Always" described as OpenCode 2 does it | **pass**: the option's description above. Unit tests `secretary/dialog.test.ts` "reads a three-option permission, saying how far Always allow reaches", `replyInterpreter.test.ts` "passes an option's description, which says how far OpenCode's Always allow reaches" |
| 6.3 | Questions: multi-select, several questions, typed answers | **partly live**: multi-select `{q0: ["Red","Blue"]}` → recorded as such, "Your choices: Red and Blue." Several questions and typed text: unit tests in `secretary/dialog.test.ts` "a question box" |
| 6.4 | Applied only while the dialog is still open | **pass**: an old seq → `{ok: false, reason: "answered"}` |
| 6.5 | No keystrokes | **pass**: write counter unchanged (56 → 56) |
| — | For the builder by hand | With Secretary Mode on: allow always (confirm, then a bare yes), reject with a spoken reason, a multi-select, a two-question box, and a typed answer of your own |

### Story 7: transcript, brief and context figure

| # | Check | Result |
|---|---|---|
| 7.1 | `read_session` shows typed text, assistant text and tool calls with a one-line summary | **pass**: 24 entries, e.g. `tool shell: touch allowed.txt`, `tool question: Do you prefer tea or coffee?`, `tool subagent: Run env grep command` |
| 7.2 | Migrated 1.x sessions read the same | **not tested**: no migrated data in isolation (see 1.13) |
| 7.3 | The secretary's brief uses only what the builder typed | **pass**: `readOpencodeBuilderTurn` on a session holding the restart's synthetic row ("The server restarted while you were working…") took the typed prompt as the latest message and left the synthetic text out |
| 7.4 | The figure is the newest step's input side, and resets after a compaction | **input side: pass. Reset: fail, B-2**. After `/compact` the reader returned `null`, but the list and `list_sessions` kept the old 5,264 ("as of 11:48:47") until the next turn |
| 7.5 | A percentage for a model the catalog knows | **pass**: "3%", title "5,264 tokens in context · of 200,000 · deepseek-v4.1-flash-free". A model nobody knows (bare count) wasn't raised live; unit-tested |
| 7.6 | Stopped contacts show their last figures and transcript, with no OpenCode process | **pass**: alpha 2 stopped: `list_sessions` "status=stopped context=5871/200000", `read_session` 14 entries, no TUI process |
| 7.7 | Multi-Code never writes to OpenCode's database | **by code only**: every read opens the DB read-only and closes it. Writes to the scratch DB can't be told apart by writer |
| — | Phone transcript, "which call is still running" | **not tested** (no phone) |

### Story 8: quick actions

| # | Check | Result |
|---|---|---|
| 8.1 | Rename Session sets the title in one step | **pass**: `session_v2.title` = "QA renamed twin" after one Rename |
| 8.2 | Resume Elsewhere copies a command that opens the session anywhere | **pass**: copied `opencode -s ses_ea937fb02ffew3HVbJXR1Ruyak`. The copy was intercepted in the page, so the real clipboard was untouched. `opencode -s ses_ea9348ff…` run from another directory opened that session |
| 8.3 | Clear and Compact work | **fail, B-1** |
| 8.4 | Show Cost disabled, with its reason | **pass**: disabled, "OpenCode has no inline cost command; its /stats page shows usage" |
| 8.5 | The manager's `run_command` and `send_task` | **pass**: `run_command /compact` ran a compaction. `send_task` ran a turn. Both refused while blocked |

### Story 9: the alerts-off bar

| # | Check | Result |
|---|---|---|
| 9.1 | Service lost for more than 15 s → bar with the reason | **pass**: `service stop`, then `squat.py` held 49431 so no TUI could respawn it. All four running contacts went degraded "service" 15.0 s after the EOF (…718129 → …733130). Bar: "Multi-Code can't reach OpenCode's background service, so it can't tell you when this session finishes or needs you…" |
| 9.2 | The bar goes away by itself | **pass**: port freed → a terminal respawned the service; the bar went 2.8 s later, degraded=false on every contact |
| 9.3 | An outage under 15 s shows no bar | **pass**: `service stop` with only Multi-Code's TUIs attached → four of them raced to respawn; alpha 2's won after about 5 s; no degraded event |
| 9.4 | The plugin didn't load → the plugin bar | **pass**: unparseable `cli.json` → the spawn had no `plugins` (tabs and Ctrl+Z settings kept), and the plugin bar came about 10 s after the spawn. The contact's own session still chimed |
| 9.5 | The plugin bar goes away by itself | **pass**: the late report in O-3 cleared it at once ("alerts on again") |
| 9.6 | Service unreachable within 15 s of a contact's start | **not run separately**: the same `unreachable` path as 9.1 |

### Story 10: nothing of Multi-Code reaches plain OpenCode

| # | Check | Result |
|---|---|---|
| 10.1 | Multi-Code writes no file the user owns | **pass**. Scratch config dir: `opencode.json` and `cli.json` (both written by the tester, the latter unchanged by Multi-Code) and `service.json` (OpenCode's own). No `.opencode/` in any project. The real config's mtimes are unchanged (Safety) |
| 10.2 | Multi-Code's TUI plugin only in its own terminals, report-only | **pass**: two plain TUIs, no deliveries. The plugin posted only `multicode.init` and `multicode.route` |
| 10.3 | A service Multi-Code starts has the login-shell env and none of Multi-Code's variables | **pass**: 1.2. In a plain terminal, a subagent's `env` showed `QA_LOGIN_SHELL_MARK=oc2-qa-zshrc` and no `MULTICODE_*` or `OPENCODE_CLI_*`; its root's showed none of the three |
| 10.4 | The service password is never logged, written, or sent to the renderer | **pass**: no hit for the password or its Basic header in either trace log, `electron.log` or `userData`, nor in the renderer's DOM, recorder, `localStorage` or `listInstances()`. The phone side was not checked (no phone) |
| 10.5 | Multi-Code never restarts, replaces or stops the service, and starts one only when none runs | **pass**: started only by the pty's clean start, twice. The service outlived the quit (78787 ran on). A terminal's own respawn, which is OpenCode's doing, carried `OPENCODE_CLI_CONFIG_CONTENT` but no `MULTICODE_*` (O-2) |

### Story 11: stop and quit

| # | Check | Result |
|---|---|---|
| 11.1 | Stopping mid-turn doesn't interrupt the turn | **pass**: stopped at …034358; `tool.success` …045748, `succeeded` …047491. The next start showed the answer |
| 11.2 | A stopped contact raises nothing | **pass**: only the `exit` event after the stop |
| 11.3 | Quit doesn't warn about OpenCode contacts mid-turn | **pass**. With alpha busy mid-turn, `unfinishedInstances()` returned `[]`. `app.quit()` during the turn: no dialog, the app gone within 4 s. The turn succeeded in the service 9 s later. Multi-Code's spawn files were removed. Claude contacts are still warned about: not run (no Claude contact in isolation); the filter only skips `backend === "opencode"` |

## Bugs

### B-1: Clear and Compact don't run on OpenCode 2 (medium)

**Fixed and re-run live (2026-10-20): pass** (R-2, R-3 under "Cross-model review and live re-run").

- **Steps:** an OpenCode contact on a session with turns → Toolbox, Quick Actions, **Compact**
  (or **Clear**).
- **Expected:** the session compacts, or the TUI goes to a fresh session.
- **Actual:** `/compact` (or `/clear`) sits in the input box with the slash menu open. Nothing
  runs: no `session.compaction.*` frame, no route change.
- **Evidence (alpha 2):**
  - After the click, the screen showed the menu (`/compact  Compact session`, `/review …`) and
    `/compact` in the box.
  - One more Enter ran it (`compaction.started` / `ended`, `execution.succeeded`).
  - Typing `/compact`, then Enter in a separate write 1 s later, ran it with one Enter.
  - The manager's `run_command /compact` (text, wait, Enter, wait, Enter) ran it.
  - Rename Session works only because text follows the command (`/rename <name>`), which closes
    the menu.
- **Suspect:** `sendSlash` in `renderer/components/QuickActionsSection.tsx` writes `cmd + "\r"` in
  one write, and OpenCode's menu takes that Enter. A fix would type the command and send Enter
  after a pause, as `processManager.tryRunCommand` does.
- **Status:** fixed after the run: for OpenCode, `sendSlash` writes the command, then `\r` 250 ms
  later. Not re-run live; the same sequence is what row 8.5's `run_command` passed with.

### B-2: the context figure doesn't reset after a compaction (low)

- **Steps:** an OpenCode contact with turns → `/compact` → look at the contact list's figure or
  `list_sessions`.
- **Expected (PRD Story 7):** the figure resets.
- **Actual:** it keeps the pre-compaction value until the next turn's step.
- **Evidence (alpha 2):** after the compaction, `readOpencodeContextUsage` returned `null`, which
  is right: the completed `compaction` row is newer than any step. Yet `instance.contextUsage`
  stayed `{inputTokens: 5264, updatedAt: …327512}`, and the list showed "3% · as of 11:48:47".
- **Suspect:** `ProcessManager.refreshContextUsage` keeps the last figure whenever a read comes
  back `null` (meant for a locked or unreadable transcript), so the reader's "reset" can't reach
  it. The backend needs a way to say "reset" that isn't "unreadable".
- **Status:** open, accepted as a known limit (low): the next turn's step corrects it. A fix
  needs a "reset" answer from the backend distinct from "unreadable", for one figure on screen.

### B-3: no session on record, the newest held → fresh instead of the newest unheld (low)

- **Steps:** two contacts on one project, neither with a `sessionId` in `contacts.json` (a contact
  from before session ids were kept). Start one, then the other.
- **Expected (PRD Story 1, kanban T-605 "the directory's newest root session no other contact
  holds"):** the second opens the newest root session nobody holds.
- **Actual:** the second gets a freshly minted session.
- **Evidence:** alpha 2 opened `ses_ea938943…` (newest). Alpha opened a new
  `ses_ea9296e22ffe…` (not in the DB). Meanwhile `ses_ea9348ff…`, `ses_ea937fb0…`,
  `ses_ea93741b…` and `ses_ea944f37…`, all roots in that directory, were held by no one.
- **Suspect:** `ProcessManager.sessionStartFor` turns a held latest into `{kind: "fresh"}`, and
  `opencodeBackend.findLatestSessionId` and the spawn host's `latestRootSession` are called
  without the `isClaimed` callback that `opencodeDb.latestRootSession` takes for this purpose.
  This may be deliberate, for parity with Claude's `--continue`; if so the PRD wording should say
  so.
- **Status:** kept, for parity with Claude, whose `--continue` can't skip a held session. PRD v1.2
  Story 1 now says "the directory's most recent root session, else a fresh one when another
  contact holds it". It only reaches contacts with no session on record: every OpenCode contact
  names its session from its first start.

## Other observations

- **O-1, two contacts chime for one turn** (3.15). This is the documented "Left as is" in
  `.omt/opencode-v2-decisions.md`. To the builder it reads as two Finished for one turn, against
  Story 3's "exactly one". Only after one contact's terminal has shown a session another contact
  holds.
- **O-2, where Multi-Code's variables still go.** The plugin's deletion of `MULTICODE_*` from the
  TUI's `process.env` works for a service the TUI respawns: alpha 2's respawned service had none.
  It still carried `OPENCODE_CLI_CONFIG_CONTENT`, which names Multi-Code's plugin directory, so
  every client's subagent shells see that variable until a clean restart. That consequence is in
  decisions.md 2026-10-20.

  The deletion does not keep the ids out of the contact's root shell. The agent's `env` in alpha
  showed `MULTICODE_INSTANCE_ID`, `MULTICODE_SPAWN_ID`, `MULTICODE_ALERT_FILE` and
  `OPENCODE_CLI_CONFIG_CONTENT`; the TUI apparently pushes its env from before the plugin's setup. So the
  comment in `opencodePlugin.ts` ("an `opencode` the agent runs would otherwise load this plugin
  with the same ids") claims more than it does. A nested TUI in the agent's shell still gets the
  ids, as G-605 already accepted.
- **O-3, a 60 s start stall, seen once, not reproduced in two tries.** The sequence: gamma
  started with an unparseable `cli.json` and ran a turn; it was stopped; `cli.json` was deleted;
  ▶ again. The new TUI showed nothing for 60 s ("Starting OpenCode…"), between OpenCode's own
  log lines "update check skipped" (00:57:48.929) and "event stream connecting" (00:58:48.189).
  The plugin bar came at 10 s. Then the TUI started normally, the plugin reported, and the bar
  cleared. The stall is inside OpenCode, and Multi-Code recovered.
- **O-4, "busy" when nothing runs.** Run state stays `busy` after a turn that ended interrupted
  (double Esc, Reject, dismissed question, an API interrupt), since nothing marks that end, and
  it is `busy` from the first write of the renderer's terminal replies. So `list_sessions` showed
  delta "busy" with nothing running, and `wait_for_idle` on it would wait out its timeout. This
  is the same model as Claude's; noted in case the manager needs better for OpenCode.
- **Harness notes, not product bugs:**
  - `restartInstance` called on a running contact over IPC left the renderer showing it OFFLINE
    while it ran: the old pty's exit lands after the new start. No UI path does this, since
    Restart is disabled while running.
  - After an API interrupt the TUI kept showing the stale permission dialog (spike-documented),
    and it swallowed the next typed prompt.

## Cross-model review and live re-run

The review (gpt-review 1.4.0, `gpt-6.1-sol`) and its findings are in
`.omt/opencode-v2-decisions.md`, "Cross-model review". The fixes were then run live, from the
main tree (the T-611 worktree is gone), on the same scratch setup, with two differences:

- `launch2.sh`: the dev build's own env has **no** `XDG_*` and no `OPENCODE_DB`. Only the fake
  `.zshrc` sets them, so OpenCode's paths can come only from the login shell (fix 1).
- The dev build's phone server was started on port 46768 (the builder's app holds 6768) and
  paired with a test phone, `phone.mjs`: the real handshake and sealed frames, commands on stdin.
  Stopped afterwards, its device revoked and the offer file deleted.

| # | Row | Result |
|---|---|---|
| R-1 | OpenCode paths from the login shell (fix 1) | **pass**: with the app's env bare, the DB, config and registration paths resolved to `/tmp/oc2-qa/…`; starting alpha, Multi-Code started the scratch service (49431) and connected; no bar after 20 s; nothing created under the fake HOME's `.local` |
| R-2 | B-1, Compact | **pass**: `session.compaction.started{manual}` → `ended` → `execution.succeeded` 3 s later; one Finished |
| R-3 | B-1, Clear | **pass**: the TUI went to its home screen; the plugin reported the home route; the contact kept its session until the next prompt |
| R-4 | Context figure on a session change (Story 4) | **pass**: the sidebar figure changed 51 ms after `instance-session-id`, 12 s before the turn's end |
| R-5 | Restated dialog, no second chime | **pass**: alpha blocked on a permission in session S2; another owned root (S1, driven through the API) finished: the renderer got `waiting` only (unread +1), main logged `prompt (restated)`, alpha stayed `blocked` on S2's request, the secretary's event was set again; answering it from another client cleared it, and S2's own end chimed |
| R-6 | Plugin route retry | **pass**: the dev build's `/alert` answered 503 to alpha's next two posts; the plugin sent the new session's route at +6 ms, +506 ms and +1002 ms, the third landed and the contact moved to the session |
| R-7 | Phone tap held to its prompt | **pass**: A answered at the desk, B open; a tap with A's `promptId` and a tap with none were both refused ("That choice is no longer available"), B still pending; a tap with B's id allowed B within 5 ms |
| R-8 | Restated dialog on the phone | **pass**: after the other root's finish, the phone got `activity: waiting`, then the same dialog's buttons under a new `promptId` and no second `activity: prompt` (no second vibration); a tap with the new id answered it |

Not run: a physical phone (vibration itself), and the 28 skipped tests (live secretary, the real
DB smoke).

**Observed, not changed:** a session's turn that ends before its route reaches Multi-Code is not
the contact's yet, so it raises no Finished. R-6 shows the window: about 1.5 s with two lost
posts. Before the retry, such a route was never delivered at all.

**Safety:** `baseline.sh` before (23:23:01) and after: the builder's service (pid 55216, same id
and url), `~/.config/opencode/*`, the real `contacts.json`, and the real DB's `session_v2` and
`session_message` maxima and counts all identical; no `opencode.log` line names `oc2-qa` or 49431.
One write to the real DB meanwhile: `project.time_active` of `apra-amcos-cc-marketplace` at
23:26:08, the builder's own session there. The dev build, the scratch service and the event logger
were stopped by pid; ports 9611, 9612, 46768 and 49431 were free afterwards.

## Safety check (the builder's real OpenCode and Multi-Code)

| | Before (11:30:03) | After (12:12:36) |
|---|---|---|
| `~/.local/state/opencode/` listing | 8 entries, `service.json` 03:37 | identical |
| `service.json` keys and id/pid/url | `id, password, pid, url, version`; `face275c-…`, pid 55216, `127.0.0.1:49374`, 2.0.32 | identical |
| `~/.config/opencode/*` mtimes | `cli.json` and `service.json` 03:37:17, `opencode.json` Oct 13 | identical |
| `~/Library/Application Support/multi-code/contacts.json` mtime | Oct 18 22:09:14 | identical; its `opencode/` folder identical too |
| Real DB, `session_v2` `max(time_updated)` and rows | 1792428142064, 461 | 1792458753237, 473 |
| Real `opencode.log` lines naming `oc2-qa` or 49431 | | 0 |

The real DB's changes are the builder's own sessions while QA ran: 13 rows, in
`/private/tmp/pstack-vs-omt-ws`, `/private/tmp/gpt-review-v2-test/repo` and
`apra-amcos-cc-marketplace`, plus the kv `models-dev:catalog` refresh. None in a `/tmp/oc2-qa`
directory. Every QA process had the scratch `XDG_*` and `OPENCODE_DB`.

The builder's service 55216 and TUI 54907 ran untouched throughout. So did an
`opencode serve --port 53192` (pid 88396, started 12:07 in `apra-amcos-cc-marketplace` with the
real `HOME`): not QA's, left alone.

Cleanup:

- Before the quit, every isolated contact was stopped (no dialog possible), then the app quit
  itself.
- The scratch service was stopped with `qoc.sh service stop`.
- `events.py`, `err400.py`, the squatter and the PTY drivers were ended by pid.
- `/tmp/oc2-qa/` is kept as evidence (scratch only).
- The extracted Electron stays in the worktree's `node_modules` (gitignored).
