# Tech Conventions

Reference project: `apra-amcos-admin-msk`

## Code Style & Toolchain

| Aspect | Choice | Notes |
|--------|--------|-------|
| Language | TypeScript (strict) | target es2024, ESM |
| Package manager | pnpm + workspace | monorepo structure |
| Lint | oxlint + eslint | oxlint for fast checks, eslint for fine-grained rules |
| Type checking | tsgo | TypeScript native preview |
| Testing | vitest | with @testing-library |
| Bundler | rspack | faster alternative to webpack |
| Module type | ESM | `"type": "module"` |

## Desktop Application Framework

- Electron (confirmed)
- Frontend: React + UI library (TBD, reference project uses MUI)
- UI aesthetic: compact, information-dense, no modern bloat

## Project Structure (Expected)

```
multi-code/
├── workspace/
│   ├── app/          # Electron main process + renderer
│   └── shared/       # Shared types and utilities
├── package.json      # root workspace
├── pnpm-workspace.yaml
└── tsconfig.json     # root tsconfig
```

## Multi-Backend Pattern (added 2026-05-18)

When new logic needs different behavior per backend (claude / opencode), prefer this pattern:

```
src/main/backends/
  ├── types.ts          # Backend interface (spawn args, hook installer, resume cmd builder)
  ├── claude.ts         # Implementation for claude
  ├── opencode.ts       # Implementation for opencode
  └── index.ts          # Registry / factory
```

Anywhere in the codebase that needs backend-specific behavior, look up the backend by name and call the abstraction — never hardcode `if (backend === "claude") ... else ...` branches scattered across files. Adding a new backend should mean:

1. Drop a new file under `backends/`
2. Register it in the index
3. Add the visual treatment (new avatar shape) and the dialog option

If the abstraction starts feeling forced, fix the abstraction — don't put a third backend hack into a corner.

(source: 2026-05-18 opencode-support ideation)

## Verifying UI changes without a human (added 2026-09-15)

`osascript` cannot drive this app. `click at {x,y}` fails with
`AppleEvent timed out (-1712)` because Electron's web content doesn't accept synthetic
System Events clicks, and the accessibility tree stops at a `group`.

Use CDP instead — it clicks reliably and, more importantly, lets a change be *inspected*
rather than eyeballed:

```bash
cd workspace/app && npx electron . --remote-debugging-port=9333   # 9222 is often Chrome's
curl -s http://127.0.0.1:9333/json                                # → webSocketDebuggerUrl
```

Then `Runtime.evaluate` over that socket (`ws` is already a dependency). React's event
delegation responds to a native `click()`, so:

```js
[...document.querySelectorAll(".contact-item")]
  .find(el => el.querySelector(".contact-name")?.textContent === "portals-be")
  ?.querySelector(".start-btn").click()
```

Two related facts that make self-verification practical:

- **The dev app and a packaged build use different userData directories** (`multi-code`
  vs `Multi-Code`), so both can run at once without fighting over `contacts.json`. They
  do share port 6768; that's handled and only disables phone link. Kill the dev one with
  `pkill -f "node_modules/electron"`, which cannot match `/Applications/Multi-Code.app`.
- **Compiled main-process modules with no electron import can be required directly** from
  a plain node script — `dist/main/run-state.js`, `dist/main/backends/claude.js` — and
  paired with `node_modules/node-pty` to drive a real CLI. `backends/index.js` and
  `opencode.js` cannot: they pull in `better-sqlite3`, built for Electron's ABI.

(source: 2026-09-15, verifying the manager agent's dispatch path)

Three additions from the same day, each after the naive approach cost real time:

- **To exercise a first-run path, launch an isolated instance**:
  `electron . --remote-debugging-port=9444 --user-data-dir=/tmp/mc-test`. Electron makes
  `app.getPath("userData")` follow that flag, so it comes up with no contacts and no
  manager directory — which is the only clean way to test "+ Manager" or a trust dialog.
  The alternative was tried first: moving the user's real `manager/CLAUDE.md` aside, with
  the backup in `/tmp`. They then rebooted, and `/tmp` is cleared on reboot.
- **A CDP helper must check `exceptionDetails`.** Reading only `result.result.value`
  returns `undefined` for an expression that threw, so a probe that never ran looks like a
  finding about the app. Also don't pass the expression through `execSync` +
  `JSON.stringify` — the shell mangles the newlines. Write it to a file, or hold one
  persistent websocket.
- **Read terminal contents from `.xterm-rows`' `innerText`**, not `.xterm-screen`'s
  `textContent`. The latter includes the `<style>` block xterm injects, which is thousands
  of characters of CSS before any output.

## Tests must not read the real HOME (added 2026-09-15)

Two tests were found reading the developer's own files through a default parameter, which
makes them pass or fail depending on whose machine runs them:

- `contextUsage.test.ts` picked up the real `~/.claude/settings.json` once
  `readClaudeContextUsage` gained a `settingsPath` default, and started asserting against
  whatever model that machine had configured. Fixed by pinning every call to a path that
  cannot exist.
- `process-manager.write-gate.test.ts` wrote `contacts.json` **into the repo**: `store.ts`
  computes `STORE_PATH` at *import* time, when the mocked `app.getPath("userData")` is
  still `""`, so `path.join` yields a relative path. Fixed by mocking `./store`.

So: when a reader gains a config-path parameter, give every existing test an explicit
unreachable path in the same commit, and mock `./store` in any test that imports
process-manager.

## Seeded files are versioned by content hash (added 2026-09-15, code retired 2026-11-01)

The manager agent's `CLAUDE.md` was seeded by `manager-workspace.ts`, which kept the sha256
of every version it had written: a match was ours to upgrade, anything else was the user's
edit and never touched. Changing the template meant adding the outgoing hash in the same
commit, or existing installs stopped upgrading (the manager went on reading a version that
listed only its read tools). The code went with the manager; the rule stands for any file
Multi-Code seeds into a place the user can edit.

## A session id is not stable for the life of a process (added 2026-09-17)

`/new` and `/clear` move a running CLI to a fresh transcript under a new id and never
write to the old file again. Measured 2026-09-17 against 2.1.274: after `/new`, a new
jsonl appeared and the previous one did not gain a single byte, while the CLI's own
context readout went from `19.9k` to `0`. `/new` is an alias for `/clear`; the
transcript records the latter.

So a session id captured once at spawn goes stale, and **everything that reads a
session goes through it**: context usage, `readTranscript`, and the completion
detector behind notifications, phone prompt detection and the write-safety gate. The
symptom that gets reported is only the frozen context percentage; the rest fails
silently.

`~/.claude/sessions/<pid>.json` is the authoritative answer. It is maintained by the
CLI, keyed on the pty child's pid, and its `sessionId` is rewritten on the change —
verified moving from `89f7d163…` to `75e23772…` for one unchanged pid.
`Backend.findLiveSessionId(cwd, pid)` wraps it, and process-manager re-checks every
running instance every 4s.

Two things a change here must preserve:

- **Check the cwd as well as the pid.** Pids are recycled, and a stale entry from a
  dead process would point every read at an unrelated session.
- **A detector must attach at the transcript's current end, not its beginning.**
  `ClaudeCompletionDetector` takes `stat.size` in its constructor (`claude.ts:279`).
  Rebuilding a detector against a session that already has content would otherwise
  replay its entire history as fresh activity, firing a notification per past turn.

## A hook is how the manager's own tool calls become visible (added 2026-09-16)

The Manager feed records everything passing through our MCP server, which is every
dispatch — but the manager's own `Bash`/`Edit`/`Write` go from its CLI straight to the
machine and touch nothing of ours. The CLI's `PreToolUse`/`PostToolUse` hooks are the only
seam that reports them, so the manager spawns with a generated `--settings` file whose
hooks POST to a `/hook` path on the same server (see `manager-mcp/hook-activity.ts`).

This is not the "hooks middleware" the architecture rules out: nothing here decides
anything, the hook never blocks or rewrites a call, and its failure changes nothing about
what the manager can do. Three things measured against CLI 2.1.273 that a future change
must preserve:

- **Both deliveries for one call share a `tool_use_id`.** That is what makes a two-phase
  entry (running → finished) possible at all.
- **A hook command's argv is `ps`-visible**, so a bearer token can never go on it — and an
  environment variable is no better, because the shell expands it into that argv before
  exec. Use a `curl -K <file>` config at 0600.
- **End the hook command with `|| true`.** A `PreToolUse` hook exiting 2 blocks the call it
  is reporting on. Exit 7 (connection refused) was measured not to block, but a reporting
  path that can disarm the manager is worse than no reporting.

## The write-safety gate is not the place to fix a timing bug (added 2026-09-15)

When a write to a session gets refused, check the caller's timing before touching
`run-state.ts`. Measured: the manager called `start_session` and `send_task` in the same
turn (the model issues them in parallel), the dispatch landed two seconds into the CLI's
startup and was swallowed, and the gate then correctly refused the retry because nothing
had reacted. The gate was right; the caller was writing at a moment when writes get lost.
The fix belonged in the tool — wait for the target to settle — and loosening the silence
guard to make that case pass would have removed the only protection against a write
landing on a dialog.

## Agent state comes from the agent, never from terminal timing (added 2026-10-06)

Months of notification bugs came from inferring "finished" and "waiting on you" from
the terminal and the transcript: an `end_turn` row plus a timer, an unpaired `tool_use`
plus 800ms of PTY silence. Measured 2026-10-06 against CLI 2.1.290, neither holds. The
TUI repaints exactly once a second while background work runs and goes 0.9s between
frames during ordinary tool calls, so silence fires mid-work; a Bash permission dialog
repaints every 0.6s, so the real dialog is never silent; `end_turn` is written when the
agent hands work to a background subagent, long before it is done. Evidence and the
probe method: `docs/timeline/2026-10-06_attention-alerts-investigation.md`.

The CLIs report their own state: Claude Code through hooks (`Stop`, `PermissionRequest`,
`StopFailure`) and the `status`/`waitingFor` fields of `~/.claude/sessions/<pid>.json`;
OpenCode 2 through its shared service's event stream (`session.execution.*`,
`permission.asked`, `form.created` and their replies) plus Multi-Code's TUI plugin for the
session each terminal shows. Epic `attention-alerts` moved detection onto those for Claude
Code (`backends/claudeHooks.ts`, fixtures from the real CLI in
`backends/__fixtures__/claude-hooks/`, 2026-10-07), and epic `opencode-v2` for OpenCode 2
(`backends/opencodeAttention.ts`, fixtures recorded from 2.0.32 in
`backends/__fixtures__/opencode-v2/`, 2026-10-20). Change a rule there
only with a fixture that shows the CLI doing it, and fix a wrong alert by reading more of
what the CLI reports, not by tuning a timing constant or adding a text match.

## An agent's report names its spawn, not just its instance (added 2026-10-07)

Whatever reports an agent's state from inside its process (Claude's alert hooks,
OpenCode's plugin) sends two ids with every delivery: `MULTICODE_INSTANCE_ID`, the
contact, and `MULTICODE_SPAWN_ID`, minted per spawn (`backends/instance-env.ts`). Both
reach the reporter through the agent's own env and travel as `X-Multicode-Instance` /
`X-Multicode-Spawn`. A restart keeps the instance id, and the old process's async
reporters can still deliver after the new one is up; `handleAlertDelivery` drops any
delivery whose spawn id isn't the instance's current one. Every env Multi-Code builds
strips inherited values of both first, so a dev build launched from inside a session
doesn't hand its parent's ids to everything it starts. A new reporter that sends only the
instance id would have every delivery dropped.

A reporter loaded through the environment must also take the ids out of its own process's
env once read. OpenCode's TUI plugin is named by `OPENCODE_CLI_CONFIG_CONTENT` and deletes
the ids after setup, against a nested `opencode` and a service the TUI restarts. It can't
stop the TUI from pushing its env to the session it shows (OpenCode 2 does that for every
root session), so the agent's shell in a contact's root session sees `MULTICODE_*`, as a
Claude contact's Bash does; the shared service itself is started without them
(docs/timeline/2026-10-20_opencode-v2-spike.md, G-604/G-605).

## OpenCode 2's shared service belongs to the user (added 2026-10-20)

Every `opencode` of a user talks to one background service, and the service keeps the
environment of whichever client started it. Multi-Code starts it only when none is
running, from the builder's login-shell env minus its own variables, and never restarts,
replaces or stops it. Its password (`~/.local/state/opencode/service.json`) stays inside
`backends/opencodeService.ts`. The event stream has no replay: re-sync from the snapshot
endpoints after every connect. OpenCode's database is read only, from `session_v2` and
`session_message` ordered by `seq`; migrated 1.x rows keep 1.x tool names and keys, so
readers accept both.


## Servers and model serving follow the vendor's documented method (added 2026-10-07)

When something has to run outside the app, such as the secretary's speech server, every
layer is installed and launched the way its vendor documents it, with the doc cited
beside the command: the distribution's driver tool, Docker's and NVIDIA's install guides,
the model's recommended server (vLLM-Omni for Qwen3-TTS, per Qwen's README) with its
published image and launch command. Don't wrap a model library in a hand-written HTTP
server to get it running sooner: the builder rejected exactly that on 2026-10-07 and asked
for "最正确、最官方的方案". If a shortcut is ever worth it, say so before taking it. The
reference setup is `deploy/tts-server/`. (source:
docs/timeline/2026-10-07_voice-engine-hosting.md)

## A one-shot CLI call must not log the builder in (added 2026-10-08)

Every `claude -p` Multi-Code runs on its own, with nobody at the screen, passes
`--settings '{"awsAuthRefresh":"false"}'` (`secretary/cli.ts`, `NO_AUTH_REFRESH_SETTINGS`).
The builder's `~/.claude/settings.json` has an `awsAuthRefresh` of `aws sso login …`, and
the CLI runs it when the Bedrock token has expired, `-p --bare` included: measured against
2.1.292 in a fake HOME, it ran the user's refresh command once and then failed. For an
interactive session that's a login page the builder expects; for a brief written while they
are away it's a browser window opening on an empty desk. With the override the call fails at
once with the credential error, which is the right outcome. It must stay the call's only
`--settings`, since a second one replaces the first. (source:
docs/timeline/2026-10-08_brief-writer-spike.md, T-504 addendum)

## Verifying the phone app without an iPhone (added 2026-10-30)

There is no iOS Simulator here (no Xcode). Phone screens are checked against the dev
harness (`workspace/app/scripts/mobile-harness/README.md`), which runs the real compiled
`RemoteServer` under Electron with scripted sessions and an isolated `/tmp` userData:

```bash
cd workspace/app
pnpm harness                       # free ports, its own /tmp/mc-harness-<pid>; prints the URLs
pnpm harness:shot --control http://127.0.0.1:<control-port> --scenario short --route '#/s/multi-code' --out /tmp/shot
```

To keep one userData across runs (a page stays paired), start it as `npx electron
scripts/mobile-harness/main.ts --user-data-dir=/tmp/mc-harness-mine --port 7700`. Shots are
Playwright WebKit at 393 × 852, scale 3, touch, dark and light; read every PNG.
`--focus <selector> --keyboard 336 --pan 336` simulates the iOS keyboard (a shorter `visualViewport`
and iOS's page pan): it reproduced the "keyboard pushes the chat away" bug (G-324) on the
build before its fix, so use it for any layout near the compose box.

What WebKit can't show, only the iPhone can: the Home Screen app's own storage, real
notifications, the real keyboard and IME, lock/unlock. The builder prefers to install the
packaged release and use it rather than run a long scripted checklist against a dev build;
real use found four bugs the automated checks missed (`docs/specs/mobile-v2/qa-report-m1.md`,
"After QA"). (source: mobile-v2, T-802, G-321..G-324)
