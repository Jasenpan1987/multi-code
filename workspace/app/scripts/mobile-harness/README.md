# Phone dev harness

Runs the phone app against the real `RemoteServer` (`src/main/remote/ws-server.ts`,
compiled) with scripted sessions instead of agents, so a phone screen can be built
and screenshotted without the desktop app or a real Claude / OpenCode. The content is
the mockups' (`docs/specs/mobile-v2/mockups/index.html`).

## Start it

From `workspace/app`:

```bash
pnpm harness                         # builds main + the phone app, then starts
pnpm harness --scenario plan --paused
```

It prints the phone URL (open it in a browser to pair, as the QR would) and the
control URL:

```
Multi-Code phone harness · scenario home · userData /private/tmp/mc-harness-19149
  Phone app:   http://127.0.0.1:51089/#pair=eyJ2Ijoz…
  Control:     http://127.0.0.1:51090   (curl it for the commands)
```

Options: `--scenario <name>`, `--paused` (no clock: working turns move only on
`/tick`), `--port <n>` and `--control-port <n>` (default: free ports, so several
harnesses can run at once), `--host-name <name>` (default `MacBook Air`; the server
sends `Multi-Code on <name>`). Ctrl+C stops it.

`pnpm harness` gives every run its own `--user-data-dir=/tmp/mc-harness-<pid>`. To keep
a browser paired across restarts, run Electron yourself with a fixed directory and port:
`npx electron scripts/mobile-harness/main.ts --user-data-dir=/tmp/mc-harness-mine --port 7700`
(after `pnpm build:main && pnpm build:mobile`).
The harness refuses to start without a `--user-data-dir` under `/tmp`, so it never
touches Multi-Code's real data. The page is served from `dist/renderer-mobile` on every
request: after `pnpm build:mobile` (or `rspack build --watch -c rspack.mobile.config.ts`)
a reload shows the new build.

## Scenarios

Every scenario but `empty` has the same six sessions, as mockup 1A lists them; the
scenario decides which moment of `multi-code` is on screen.

| Scenario     | `multi-code` (Claude)                                                     | Mockup   |
|--------------|---------------------------------------------------------------------------|----------|
| `home`       | Needs you: Bash permission, `pnpm test:e2e`                                | 1A       |
| `finished`   | Finished: 12 tools in 2m 41s, Markdown conclusion                          | 2.1, 2.2 |
| `permission` | Needs you: `rm -rf dist && pnpm build`; `docs-site` waits on an OpenCode permission (Allow once / Always allow / Reject) | 3.1 |
| `questions`  | Needs you: two questions, the second multi-select, "Type something" rows  | 3.2      |
| `plan`       | Needs you: a plan (Markdown, long enough to scroll)                        | 3.3      |
| `terminal`   | Needs you: an MCP form the phone can't show (no `dialog`)                  | 4.1      |
| `empty`      | no sessions                                                                |          |

The other five, in every scenario: `data-pipeline` (OpenCode) needs you on one
question; `apra-portal` is working (mockup 2.3) and adds a tool every 4 s until it
finishes, about 30 s after the scenario starts; `infra-terraform` finished 15 min ago
(its conversation is mockup 4.2's); `docs-site` (OpenCode) idle since yesterday;
`multi-code (review)` stopped since Monday. `multi-code` has 13 turns, so the first
10 come with `hasEarlier`. Every terminal is 120 × 36 and repaints like a CLI.

## What the harness does as the desktop

Protocol v3 (`src/shared/remote-protocol.ts`) is the contract. The server's Tailscale
checker is replaced by one that says HTTPS is ready at `http://127.0.0.1:<port>`, so
the server makes its pairing offer for that origin and no `tailscale` command ever
runs. The server does protocol v3 itself (T-803) and Web Push's part (T-810);
`bridge.ts` gives it a `RemoteHost` over the scripted world that gates each frame as the
desktop's does:

- `subscribe` sends the last `turns` turns (default 10) with `hasEarlier`, a snapshot
  at the session's size, and the dialog in full; opening a Finished session makes it
  Idle.
- `prompt`: `not-running` for a stopped session, `dialog-open` on a dialog, else ok (a
  working session queues it). The session runs a short scripted turn.
- `answer`: `gone` unless `seq` is the open dialog's; held to the dialog by the
  secretary's `checkChoice` (`needs-confirm` for Always allow / auto-accept without
  `confirmed`, `failed` for a plan revised without feedback or a question unanswered,
  `unsupported` for what doesn't fit, or a dialog without `dialog`). Then the session
  moves on: allowed calls run, a revised plan comes back under a new `seq`.
- `interrupt`: `dialog-open` on a dialog, `not-working` outside a turn, else the turn
  stops and the session is Idle (OpenCode too: two Escs, G-303).
- `push-subscribe` acks ok and is stored on the device; `auth-ok` carries the server's
  VAPID key (kept in the harness's userData) and whether this phone subscribed. Nothing
  is ever pushed: the harness's host never asks the server to, and its plain-http
  origin couldn't be a VAPID subject.
- A `clientMsgId` already handled gets the same ack again and isn't acted on (last 200
  per device).
- Terminal keys (`input`) act as the CLI's would: text is typed, Return sends it (or
  picks the highlighted option of a dialog), Esc stops a turn or declines a dialog.

## Control channel

`curl <control>` lists the commands. The useful ones:

```bash
C=http://127.0.0.1:51090
curl -XPOST $C/scenario/questions        # start a scenario over (?live=0 freezes it)
curl -XPOST $C/tick                       # one step of every working turn
curl -XPOST $C/desk-answer/multi-code     # the builder answered at the desk
curl -XPOST "$C/resize/multi-code?cols=100&rows=30"
curl -XPOST $C/drop                       # cut every socket (reconnect)
curl -XPOST $C/half-open                  # open sockets go quiet, pings included
curl -XPOST $C/offline; curl -XPOST $C/online   # the Mac unreachable, then back
curl $C/log                               # every prompt / answer / interrupt / input and its ack
```

## Screenshots

```bash
pnpm harness:shot --control $C --scenario plan --route '#/s/multi-code' --out /tmp/plan
# → /tmp/plan-dark.png, /tmp/plan-light.png
```

WebKit as an iPhone 15 Pro from the Home Screen: 393 × 852, device scale 3, touch,
mobile, dark and light (`--scheme dark|light|both`). It pairs from the harness's URL,
then sets the route. `--scenario` starts that scenario over, paused, so the shot is the
same every time (`curl -XPOST $C/resume` restarts its clock). `--tap <selector>` taps
before the shot (repeatable), `--wait <ms>` (default 1000) waits for the frames.
Playwright is pinned to 1.64.1, whose WebKit (`webkit-2370`) is the one in
`~/Library/Caches/ms-playwright`; on another machine run `npx playwright install webkit`.

## A test client

```bash
node scripts/mobile-harness/client.ts '<phone url>' --control $C
```

pairs, authenticates and prints the sessions of every scenario. `HarnessClient`
(`client.ts`) is also what `harness.test.ts` drives the harness with in `pnpm test`.

## Files

- `main.ts`: the Electron entry; loads the compiled server from `dist/`.
- `bridge.ts`: the only file that touches the server: the fake `RemoteHost`, and what
  is the harness's own (the log, half-open sockets), grafted onto its private members by
  bracket access so `pnpm type` checks every name.
- `world.ts`: the sessions as they change. `scenarios.ts`: what they start as.
- `control.ts`, `screenshot.ts`, `client.ts`, `harness.test.ts`.
- `push-check.ts`: notifications and the Home Screen hand-off (T-811) in WebKit or
  Chrome, with the Home Screen, permission, PushManager and clipboard stubbed; its
  header says how to run it.

The files run on Node's type stripping (Electron 44's Node 24, or Node ≥ 22.18), so
they import each other with their `.ts` names and use only erasable syntax (no enums,
no parameter properties), and import types from `src/` with `import type` only.
`pnpm type` checks them; nothing here is part of the app bundle.
