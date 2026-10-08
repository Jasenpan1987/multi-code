# Test plan: Voice Secretary

**Epic:** `docs/specs/voice-secretary/prd.md` v1.3 (T-508), v1.6 (T-523) · **Tasks:** `docs/specs/voice-secretary/kanban.md`

## OpenCode in Milestone 1 (T-523)

**Result: every OpenCode item passes.** One pre-existing low follow-up (T-524).

### Build, launch, sessions

- **Build:** branch `voice-secretary` at `bc99f99` plus the uncommitted T-515 and T-520..T-522
  work, `pnpm run pack`; the asar was checked to hold `readOpencodeBuilderTurn` and
  `keepsSecretaryEvents: true` in `opencode.js`.
- **Launch and isolation:** as T-508, through launchd, own userData under
  `$CLAUDE_JOB_DIR/tmp/t523/`, CDP on 9523 (`.omt/probes/voice-secretary/t523/`, `launch.sh`,
  `q.mjs`, `raw.mjs`, `quit.sh`). The builder's installed Multi-Code ran throughout, untouched.
- **Sessions:** two OpenCode 1.18.35 instances, `oc-zh` (Chinese messages) and `oc-en`
  (English), in empty projects whose `opencode.json` sets `bash: {"*": "allow", "touch *":
  "ask", "rm *": "ask"}`, as the attention-alerts spike did. Model GPT-6.1 Sol (the builder's
  OpenCode default). Speech: `https://tts.jasenpan.com`, Test OK in 3.3 s.
- **Harness artifact, not a product bug:** instances created over IPC before the page knew of
  them had no terminal to answer OpenCode's start-up terminal queries, so the TUI sat at
  33% CPU painting nothing. Restarted once the page showed them, they started normally.

### Results

| # | Check | Result |
|---|---|---|
| 1 | Bash permission, Chinese: chime and red dot at the dialog; brief in Chinese says what the command does and asks | **pass**: "oc-zh 这边需要你点头。……只会多一个空文件，不会删除或覆盖别的东西，也不会碰项目外面。要允许它执行吗？" Text +9.5 s, audio +18.3 s |
| 2 | Bash permission, English | **pass**: "oc-en is waiting on a permission. … Nothing gets deleted, and if the file already exists, only its timestamp changes. Do you want to allow it once, allow it always, or reject it?" Text +7.7 s, audio +19.2 s; the dialog stayed open 80 s untouched |
| 3 | Rejected in the terminal (Esc) before the click: the click opens nothing | **pass**: brief dropped 20 ms after the keystroke, no file created, the click opened no card |
| 4 | Question box, Chinese: briefed as a question with its options, without "Type your own answer" | **pass**: "……你喜欢茶还是咖啡。一共两个选项，选茶，或者选咖啡，没有别的。它没有给推荐。" The card read "Needs you" and played (15.8 s) |
| 5 | Answered in the terminal, then a finish: Finished brief, click plays it | **pass** (Chinese and English): "oc-en just finished. … Nothing was created or changed, and there's nothing left for you to do." |
| 6 | No residue | **pass**: no brief writer left; nothing of the QA instance left after quit |

Not re-run for OpenCode, since nothing backend-specific is in them: mode off, the server
stopped, two sessions at once, mouse motion, settings (all T-508).

**Explained:** in check 1 the dialog was approved 2.7 s after its audio was ready, before the
probe's click: the builder, seeing the test window, pressed Allow themselves (confirmed in
session). Not a product bug.

## Milestone 1 QA pass (T-508)

**Result: every M1 "done when" item passes. No bug blocks M1.** Five low-severity follow-ups
are listed under [Bugs and follow-ups](#bugs-and-follow-ups); none needs a bug task before M2.

### Build and launch

- **Build:** branch `voice-secretary` at `b6ee9e2`, `cd workspace/app && pnpm run pack`
  (`pnpm build` + `electron-builder --dir`), output
  `workspace/app/release/mac-arm64/Multi-Code.app` (0.7.1, unsigned). The asar was checked to
  hold the review fixes (`awsAuthRefresh` in `cli.js`, `redirect: "manual"` in `speech.js`,
  the mouse-motion filter in `process-manager.js`). Note: `pnpm pack` runs pnpm's own tarball
  command, not the script; it has to be `pnpm run pack`.
- **Launch, the way the Dock does:** a transient launchd agent in `gui/<uid>` runs
  `open -W -n -a <the .app> --args --user-data-dir=<tmp>/userdata --remote-debugging-port=9499`
  (`.omt/probes/voice-secretary/t508/launch.sh`, after `t501/launch-via-launchd.sh`), booted
  out after each quit. The app's main process had launchd's env only: variable names
  `COMMAND_MODE HOME LOGNAME MallocNanoZone OSLogRateLimit PATH SHELL SSH_AUTH_SOCK TMPDIR USER
  XPC_FLAGS XPC_SERVICE_NAME __CFBundleIdentifier __CF_USER_TEXT_ENCODING`,
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, no `AWS_*`, no `CLAUDE*`. Its brief writers reached
  Bedrock on all 36 calls, so the CLI's `--bare` still picks the profile up from
  `~/.claude/settings.json` `env` in the packaged app.
- **Isolation:** own `--user-data-dir` under `$CLAUDE_JOB_DIR/tmp/t508/`, four empty test
  projects beside it, quit by stopping its contacts over IPC and then SIGTERM to its own main
  process (matched on the userData dir). The builder's installed Multi-Code ran the whole time
  and was not touched. Three launches, three clean quits.

### Environment

| | |
|---|---|
| Time | 2026-10-08 02:31–03:03 AEDT (2026-10-07 15:31–16:03 UTC) |
| macOS | Darwin 27.0.0, arm64 |
| App | Multi-Code 0.7.1 packaged, Electron 35.7.5 (Chrome 134) |
| CLI | Claude Code 2.1.292; sessions on Opus 5.5 through Bedrock; brief writer `global.anthropic.claude-sonnet-5-5` |
| Speech | `https://tts.jasenpan.com` until 15:51 UTC, then only dead or stand-in addresses (the builder shut the server down for the night) |
| Sessions | `qa-en` (English messages), `qa-zh` (Chinese), `qa-mix` (Chinese with English terms), `qa-perm` (`defaultMode: default`, for Bash dialogs); the other three `acceptEdits`. All four sit under `~/.claude/`, so the CLI asks before every file write even in accept-edits, which gave extra needs-you events |
| AWS SSO | no expiry during the run |

### How it was observed

All over CDP on port 9499 (`t508/q.mjs`), with a page-side recorder installed after each
launch: every `secretary-brief` and `secretary-mode` push, every activity, red-dot change,
card open/close, attention chime, every `play()` the app calls and every event of the shared
`audio.secretary-audio` element, with wall-clock times (`$T/events.jsonl`). Alongside:
`procwatch.mjs` (every `claude -p --bare` process, its parent, every 300 ms), `countsrv.mjs`,
`hangsrv.mjs` and `netwatch.sh` (stand-in dead servers and connection counts), `residue.py`
(before/after snapshots). The brief audio played at volume 0.01 and the chime at a tenth of
its gain, so nothing spoke over the desk; playback was judged by `paused`, `currentTime`,
`duration` and the element's events.

The window was occluded (`visibilityState: hidden`) throughout. CDP `Input.dispatchMouseEvent`
blocks on such a window, so mouse motion was driven with DOM `mousemove`/`wheel` events on the
visible xterm screen, which xterm's mouse tracking turns into the SGR reports a real pointer
sends (`mouse2.mjs`); a synthetic click on the same element dropped the brief, which proves
the events reach the pty.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Mode off: red-dot clicks as before, no writer, no speech request | **pass** |
| 2 | Finished: click opens the card and plays a brief that opens with the name and retells the work | **pass** |
| 3 | Bash permission: plain-words effect, then the question; answering in the terminal drops it | **pass** |
| 4 | Language: English → English; Chinese and mixed → Chinese | **pass** |
| 5 | Two sessions waiting: each click plays only its own brief and stops the other | **pass** |
| 6 | Server stopped (refused and timing out): text with "Voice unavailable", app unchanged, no retry storm; back on the real server the next brief speaks without a restart | **pass** (two low follow-ups: B-1, B-3) |
| 7 | Answered in the terminal before the click: the click opens nothing | **pass** |
| 8 | Mode on with red dots already showing prepares their briefs at once | **pass** |
| 9 | Mode off while playing stops audio and closes the card; the mode survives a restart | **pass** |
| 10 | Mouse motion and wheel over the terminal don't drop a brief | **pass** |
| 11 | No residue: nothing from brief writing under `~/.claude/projects/`, no writers left, nothing outside the tmp dirs and userData | **pass** |
| 12 | Settings: another server without a key shows "needs its own key" and forgets the key on save; a non-local `http://` address is refused with a clear reason | **pass** (one low follow-up: B-2) |
| 13 | Finished brief restarting from 0 about 12 s after it ended | **not reproduced** |
| 14 | Timings | recorded below; all inside the PRD's 10 s text / 30 s audio / 1 s click budgets |

Extra PRD points seen on the way, all pass: a click on a contact without a red dot opens
nothing (Story 3); a brief clicked while still preparing shows "Preparing the brief…", then
the text, then plays on its own when the audio lands (Story 3); Replay and Stop (Story 3);
every brief opens with the session's name and runs under a minute (Story 4: 18.8–32.4 s
spoken); no server configured gives text with "Voice unavailable · no speech server set"
(Story 7); OFF and ON each survived a restart (Story 1).

### 1. Mode off

Mode off, speech address pointed at the counting stand-in `https://127.0.0.1:19501` with a
dummy key, so any speech attempt would be counted. Four events in mode off (15:33:08–15:34:35
UTC): a needs-you (the write permission in `qa-en`) and three finishes (`qa-en`, `qa-zh`,
`qa-mix`). Each chimed and raised the red dot. Clicking `qa-en`'s red dot selected it and
cleared the dot; no card, no audio element, `getSecretaryBriefs()` `{}`, no `secretary-brief`
push at all. `procwatch`: zero `claude -p --bare` processes from start-up until the mode was
switched on at 15:35:03. `countsrv`: zero connections.

### 2. Finished

`qa-en`: "Append a second haiku, this one about oolong tea, to tea.md, then tell me how many
lines the file has now." After the write permission was answered in the terminal, the turn
finished (15:43:18.396). Text +3.9 s, audio +12.1 s; the click 60 s later opened the card and
playback started 17 ms after the click; it played to its end (19.6 s).

> qa-en is done. It added a second haiku, about oolong tea, to the tea file, with a blank line separating it from the green tea one. The file now has seven lines: two haiku of three lines each, plus the blank line between them. Nothing else is left for you.

### 3. Bash permission

`qa-perm`: "Use the Bash tool to run: touch probe.txt && chmod 600 probe.txt in this directory.
Then tell me the file permissions." The CLI raised a real Bash dialog (manual mode). Text
+4.0 s, audio +14.8 s; the click opened a "Needs you" card and played 17 ms later.

> qa-perm needs your approval for a shell command. To answer your request about file permissions, it wants to create an empty file called probe in the current directory, make it readable and writable by you only, and then list it to show the permissions. It only touches that one new file, and nothing is deleted or sent outside the project. Allow it?

Six seconds in, "1" written to the session: within 2 ms the brief was dropped, the card closed
and the audio element emptied (stopped at 6.04 s of 27.84 s). The same happened for the write
permission in `qa-en` (dropped at 24.9 s in). A second Bash dialog (`rm -f probe.txt`) was
briefed as deleting:

> qa-perm is waiting on a permission. Following your request, it wants to delete the probe file in the current directory, then list it to confirm it's gone. It only removes that one file, which it created earlier, and nothing outside the project is touched. The listing is expected to report that the file no longer exists. Do you want to allow it?

### 4. Language

All 36 briefs in the run: every `qa-en` and `qa-perm` brief English, every `qa-zh` and
`qa-mix` brief Chinese, the `language` field matching the text each time. The mixed session
kept the English terms as written (useEffect, cleanup, React, DOM, bug). `qa-zh` asked in pure
Chinese ("用两三句话给我讲讲乌龙茶和绿茶的区别。不要创建或修改任何文件。"):

> qa-zh 那边回答完了，没有创建或修改任何文件。它说两者最大的区别是发酵程度：绿茶不发酵，采下后很快炒或蒸，所以颜色绿，味道清爽，带点草香。乌龙茶是半发酵，先让叶子部分氧化再炒，味道介于绿茶和红茶之间，更香更醇，常有花香或果香。没有需要你处理的事。

`qa-mix` asked "帮我解释一下 React 的 useEffect cleanup function 是干什么的，两三句话就行，不要写任何文件。":

> qa-mix 那边已经回答完了，没有改任何文件。它的解释是：useEffect 里返回的那个函数就是 cleanup，专门用来收拾残局。组件卸载时，或者 effect 下一次重新执行之前，React 会先调用它，把定时器、事件监听、网络订阅这类东西关掉。不清理的话，它们会一直在后台跑，造成内存泄漏或者重复触发的 bug。你没有需要处理的事。

The agent itself replied in Chinese to English questions (the builder's output style); the
English briefs stayed English regardless, as the rule says.

### 5. Two sessions waiting

Three red dots, three ready briefs (`qa-perm`, `qa-mix`, `qa-zh`). Click `qa-zh` (15:48:30.937):
playing its 18.8 s wav. Four seconds later click `qa-mix`: in the same 4 ms the `qa-zh` source
was emptied (stopped at 3.9 s), the card switched to `qa-mix` and its 27.12 s wav started
(`playing` 64 ms after the click). One audio element, one source at a time throughout: 10
`play` events in the run, each preceded by the app's own `play()`.

### 6. Server stopped

| Address | Briefs | Connection attempts | Voice reason on the card | Unavailable after |
|---|---|---|---|---|
| `https://127.0.0.1:9` | 4 | none: fetch refuses port 9 itself | unreachable (bad port) | at once |
| `https://127.0.0.1:19509` (nothing listening: refused) | 4 | refused | unreachable (ECONNREFUSED) | < 10 ms |
| `https://127.0.0.1:19501` (accepts, resets) | 4 | **4** | unreachable (ECONNRESET) | < 10 ms |
| `https://10.255.255.1` (non-routable: times out) | 1 | **1** SYN (netstat) | unreachable (UND_ERR_CONNECT_TIMEOUT) | 10.55 s |
| `https://127.0.0.1:19502` (accepts, never speaks TLS) | 4 | **4**, closed by the app at its timeout | unreachable (UND_ERR_CONNECT_TIMEOUT) | ~10.5 s |
| `http://127.0.0.1:19503` (takes the request, never answers) | 4 | **4** requests | timed out after 30 s | 30.0 s |
| none set | 3 | 0 | no speech server set | at once |

One speech request per brief, never retried. The card showed the text with "Voice unavailable"
and the reason after a dot, Replay and Stop disabled; with the voice pending it read "Voice on
its way…" and Stop stayed enabled
(`t508/card-voice-unavailable-badport.png`, `t508/card-no-server.png`). Every one of the 15
activities in the run chimed and raised its red dot, stopped server or not; terminals kept
taking input. No dialog: CGWindowList showed only the main window for the app's pid.

Back to the real server (`setSpeechServer` with the key, no restart): the next event
(`qa-en`, 15:49:55) had text at +3.5 s, audio at +12.2 s and played 17 ms after the click:

> qa-en just finished. You asked what matcha is in one sentence, without touching any files. It answered that matcha is shade-grown green tea leaf ground into a very fine powder, whisked straight into water so you drink the whole leaf. No files were changed, and nothing is left for you to do.

### 7. Answered before the click

- **Finished:** `qa-zh` finished (15:56:56), brief ready; with another contact shown, "x" and a
  backspace written to `qa-zh`: the brief dropped 1 ms after the "x". The red dot stayed (IPC
  writes don't acknowledge it, as a phone answer wouldn't), and clicking it switched to
  `qa-zh` and opened nothing.
- **Needs-you:** `qa-perm` Bash dialog for `rm -f probe.txt` (15:57:20), brief ready; Esc
  written: dropped 1 ms later, red dot still on, click opened nothing; `probe.txt` still there.

### 8. Mode on with red dots already showing

Mode switched on through the toolbox switch at 15:35:03.097 with three live events (red dots
on `qa-zh` and `qa-mix`; `qa-en`'s dot already cleared by its click). All three went
"preparing" within 2 ms, three writer processes appeared at once, text at +3.1 / +4.0 / +4.5 s,
audio at +9.1 / +15.3 / +17.4 s. Clicking `qa-en` (live brief, no red dot) opened nothing, as
Story 3 says.

### 9. Mode off while playing, and restarts

While `qa-mix` played (4.15 s in), the toolbox switch went OFF: in 3 ms the card closed, the
audio element emptied, and all four briefs were dropped. Mode on then off within 1.3 s, with a
writer mid-call: the CLI was gone 0.34 s after the switch, with no registry entry or plugin
marker left for its pid. Restarts: OFF saved, quit, relaunch → `secretaryMode: false`; ON set
through the switch, quit, relaunch → `secretaryMode: true` and the switch reads ON; a finish
after that restart was briefed at once (text +3.7 s).

### 10. Mouse motion

During playback of the `qa-en` write-permission brief: 25 `mousemove` and 3 `wheel` events on
the terminal (xterm in mouse-tracking mode, `enable-mouse-events` set): brief `5 ready ready`
before and after, card open, audio running 9.8 s → 11.8 s. Repeated on an idle session, then
the control: a synthetic mousedown/mouseup on the same element dropped the brief within 0.8 s.

### 11. No residue

`residue.py` before (15:31:50 UTC) and after the last quit:

- `~/.claude/projects/`: four new directories, exactly the four test sessions'
  (`-Users-jasenpan--claude-jobs-286e3c8b-tmp-t508-proj-{en,zh,mix,perm}`). None for the brief
  writer's cwd (`$TMPDIR`). Other changes are the builder's live sessions' own transcripts.
- `~/.claude/sessions/`: no entry for any of the 36 writer pids. Plugin `.in_use` markers: none
  new, none named after a writer pid.
- `~/.claude.json`: new project keys only for the four test projects.
- `~/Library/Preferences`, `Saved Application State`, `Caches`, `HTTPStorages`, `WebKit` for
  `com.multicode.app`, and both real userData folders: no change.
- `$TMPDIR`: one new entry, the Swift interpreter's own temp dir from this pass's window probe
  (removed); nothing from the app.
- Processes: 36 brief writers in the run, all children of the QA main process, one per
  "preparing" push (36), lifetime 1.4–5.9 s (median 3.7 s); none in the mode-off phase; none
  left after mode off or after any of the three quits; no test session left either.

### 12. Settings section

Driven through the section's own fields and buttons (`t508/section-needs-own-key.png`,
`t508/section-http-refused.png`):

- Key saved for `https://127.0.0.1:19501`. Changing only the path (`…:19501/v1`): no hint.
  Changing to `https://speech.example.com`: "A different server needs its own key: saving
  forgets the one saved now." Save: the key placeholder went to "not set", `hasSpeechKey`
  false, and the `speech-key` file was gone.
- `http://speech.example.com`, Save & test: "Needs an https address: plain http would send the
  key unencrypted" (amber). Saved anyway (B-2); a brief with it saved got the same reason as
  "Voice unavailable", with no request made.
- `http://127.0.0.1:19503` (loopback): allowed; Test reached the stand-in's `/health` (no key
  sent there) and reported "Health check: timed out after 5 s".
- Earlier in the run, moving the address from the live server to a dead one also dropped the
  key (`hasSpeechKey: false`), so pointing back required typing it again.

### 13. Restart from 0 after the end

Not reproduced. Ten playbacks, four of them to their natural end; after each end nothing
played again for at least 42 s (60 s for three of them), and all 10 `play` events were
preceded by the app's own `play()`. `navigator.mediaSession.playbackState` was "none" and the
app sets no media-session handlers. The builder was away (02:30 local), so no media key,
headphone or Control Center input happened; that fits the T-507 guess (a system "play"
command sent to the app as the last Now Playing source restarts an ended element from 0), but
this pass can't confirm it. Worth one manual try: play a brief to its end, then press the
keyboard's play key.

### 14. Timings (live speech server)

"Event" is the brief's "preparing" push, which main sends in the same millisecond as the
activity. Audio is the wav ready in main.

| Session | seq | Kind | Text | Audio | Click → playing | Spoken |
|---|---|---|---|---|---|---|
| qa-en | 2 | finished (mode-on catch-up) | 3.1 s | 9.1 s | not clicked (no red dot) | – |
| qa-zh | 4 | finished (catch-up) | 4.5 s | 15.3 s | 43 ms | 25.1 s |
| qa-mix | 3 | finished (catch-up) | 4.0 s | 17.4 s | 19 ms | 32.4 s |
| qa-en | 5 | needs-you, write | 5.4 s | 15.4 s | clicked at +1.1 s while preparing; played 21 ms after the audio | 25.4 s |
| qa-en | 6 | finished | 3.9 s | 12.1 s | 17 ms | 19.6 s |
| qa-perm | 7 | needs-you, Bash | 4.0 s | 14.8 s | 17 ms | 27.8 s |
| qa-perm | 8 | finished | 3.9 s | 14.0 s | not clicked | – |
| qa-mix | 9 | finished | 4.0 s | 14.7 s | 64 ms | 27.1 s |
| qa-zh | 10 | finished | 3.6 s | 11.8 s | 23 ms | 18.8 s |
| qa-en | 11 | finished, after the server came back | 3.5 s | 12.2 s | 17 ms | 21.0 s |

Without the live server, text took 3.3–6.0 s over 25 more briefs (a 26th was the one aborted
on purpose by mode off). Every brief stayed under the 10 s text budget and every audio under
30 s; synthesis took 6–13 s per brief.

## Bugs and follow-ups

None blocks M1. Each is low severity.

- **B-1 (low, cosmetic): an unreachable host shows Node's error code.** A non-routable address
  or a server that accepts TCP but never finishes TLS fails after ~10 s (undici's connect
  timeout, before the app's own 30 s) with "unreachable (UND_ERR_CONNECT_TIMEOUT)". Repro: set
  `https://10.255.255.1`, mode on, any event. Behaviour is right, and earlier than the PRD's
  30 s; only the wording is a library code. Suggest mapping it to "no answer (connect timed
  out)" in `failureReason` (`main/secretary/speech.ts`).
- **B-2 (low, UX): a non-local `http://` address is saved without a word.** Save accepts it;
  the refusal appears only on Test or as each brief's "Voice unavailable" reason. Repro: type
  `http://speech.example.com`, press Save (not Save & test): no message. From the code, a key
  typed with it is stored too (never sent). The key never travels, so the security intent
  holds; suggest the same inline hint as "needs its own key", or refusing at save.
- **B-3 (low, prompt): numbers and trivia meant for the eye.** "set its permissions to 600"
  will be read "six hundred"; several `qa-perm` finishes spent a sentence on the `@` mark in
  the `ls -l` listing. Same family as T-504's known "hello.txt" weakness; prompt work, separate
  task.
- **O-1 (observation): the Secretary section doesn't follow changes made outside it.** It
  re-reads on expand only, so a mode or address set over IPC left its switch label stale, and a
  click on it then sent the opposite of what it showed. Nothing but the section changes these
  settings today, so this only bit the test harness. Matters if anything else ever toggles the
  mode (the phone, the manager).
- **O-2 (observation): a 2 ms "Voice on its way…" before "Voice unavailable"** when the address
  fails validation (http, bad port), since only "no server set" skips "pending". Invisible.

Not seen: any brief dropped without a write or a mode change (the T-503 to-do about xterm's
automatic replies to terminal queries); every one of the run's drops follows a write, a mode
change or the deliberate synthetic click.

## Blocked

Nothing. The live speech server was needed until 15:51 UTC and every check that needs it was
done by then; the builder then shut it down for the night, and the rest ran on stand-ins.

## Leftovers

- The four test sessions' transcripts in
  `~/.claude/projects/-Users-jasenpan--claude-jobs-286e3c8b-tmp-t508-*` and their keys in
  `~/.claude.json`. Safe to remove.
- `workspace/app/release/mac-arm64/Multi-Code.app` was rebuilt (gitignored); launching it
  registers it with LaunchServices beside `/Applications/Multi-Code.app` (same bundle id), as
  earlier release builds at that path already were.
- Probe scripts and screenshots: `.omt/probes/voice-secretary/t508/` (gitignored). Raw logs:
  `$CLAUDE_JOB_DIR/tmp/t508/` (`events.jsonl`, `procs.jsonl`, `countsrv.jsonl`,
  `hangsrv.jsonl`, `netwatch.log`, `residue-*.json`).
