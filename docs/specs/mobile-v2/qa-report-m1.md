# QA Report: mobile-v2
**Date:** 2026-10-29
**Scope:** the whole epic (T-801..T-812 and the epic review-loop), against PRD v1.0
**Build:** `mv2/t-813` = `feat/mobile-v2` at 143274a plus this ticket's fixes, `pnpm build`.
Phone side: the harness (`pnpm harness`, real `RemoteServer`, scripted sessions) and
Playwright WebKit as an iPhone 15 Pro from the Home Screen (393 × 852, scale 3, touch,
dark and light). Desktop side: an isolated dev build (`--user-data-dir=/tmp/mc-t813-1`,
`MULTICODE_DEV_REMOTE_PORT=7821`, `MULTICODE_DEV_REMOTE_CHECKS` saying Tailscale runs and
HTTPS is ready at `http://127.0.0.1:7821`, CDP on 9481) with one real Claude contact
(Claude Code 2.1.312, Haiku 4.5 on Bedrock) in `/tmp/mc-t813-proj`, whose
`.claude/settings.json` has the `ask` rule `Bash(touch:*)`. The phone for the live runs
was the same WebKit profile, paired from the Phone panel's IPC.

OpenCode was not started: it would attach to the builder's one shared OpenCode service.
Its paths are covered by unit tests (recorded OpenCode 2.0.32 events and database
fixtures) and by the harness's OpenCode sessions. Tailscale was only read, never changed;
no real push was sent (pushes went to a fake push service on 127.0.0.1). Every contact was
stopped before its instance quit.

## Summary
- **Unit tests:** `pnpm test` 1974 passed, 28 skipped (102 files). `pnpm type` clean,
  `pnpm lint` 0 warnings and 0 errors, `pnpm build` passes. This ticket added 6 tests
  (4 for the dialog settle wait, 2 for New code's revoke) and moved the existing tests to
  `createPairingOffer`'s new shape.
- **Harness + WebKit:** 137 checks, 136 pass (`h1`…`h5`). The one failure is the 44 pt
  touch-target audit (Bug 2). `push-check.ts` (notifications and the Home Screen hand-off
  with the Home Screen, permission, PushManager and clipboard stubbed): 26/26 in WebKit,
  27/27 in Chrome (Chrome also delivers a real push event to the real service worker).
- **Live (real Claude, isolated dev build):** 101 checks, 100 pass (`live1`…`live7`). The
  one failure was my script counting the CLI's `api-request-blob` copy of a prompt as a
  second delivery; `live4` re-checked delivery-once with the user records only: 6/6.
  Plus timing probes (`race.mjs`, `race-plan.mjs`, `repro-plan.mjs`) that found Bug 1.
- **Criteria:** 67 rows (56 story rows, 7 NFR rows, 4 technical constraints). A
  criterion with one half only the iPhone can check, or with two parts, has a row per
  half; Story 10's two share one. **59 pass, 1 FAIL, 7 iPhone-only.** Rows marked pass with an iPhone step in the plan are checked again
  there on the real device.
- **Bugs:** 2 found. Bug 1 (medium, a plan answered too fast was lost) is fixed with
  tests and re-checked live. Bug 2 (low, touch targets) needs the builder's call.
  1 observation, low.
- **iPhone test plan:** `test-plan-iphone.md`, about 60 minutes; it closes
  G-302, G-305, G-306 and the 10-minute part of G-301.

Scripts (not committed; `.omt/` is ignored), in the T-813 worktree under
`.omt/probes/mobile-v2-qa/`: `lib.mjs`, `cdp.mjs`, `live-lib.mjs`, `h1-list-chat.mjs`,
`h2-reply.mjs`, `h3-dialogs.mjs`, `h4-term-offline.mjs`, `h5-shots-a11y.mjs`,
`live1-chat.mjs` … `live7-term-perf.mjs`, `race.mjs`, `race-plan.mjs`, `repro-plan.mjs`;
results as `*-results.json`, screenshots in `shots/` (every phone screen in dark and
light, the live chat and terminal, the desktop panel's states).

Measurement mistakes in the first runs, fixed in the scripts (not app defects): bubble and
full-width checks measured against the chat's padding box; the finished scenario's
conclusion is shorter than the screen, so its landing ends at the scroll limit; a
synchronous read right after Send ran before React rendered; the harness clock is paused,
so a revised plan comes back only on `/tick`; Playwright's route can't see a probe the
service worker handles; a numbered list in the scrollback looked like dialog options; a
second prompt asking to `touch` the same file was answered from memory; the desktop
window's xterm doesn't repaint while the window is in the background, so the CLI's screen
was read from the phone's terminal instead.

## Results

Evidence names: `h1:…` etc. are the QA scripts' checks; test names are `file › test`.

| # | Story | Criterion | How checked | Result |
|---|-------|-----------|-------------|--------|
| 1 | 1 | Served at `https://<machine>.<tailnet>.ts.net` by `tailscale serve`; a Home Screen app (standalone, own icon, name "Multi-Code") | The offer's origin is `https://<dnsName>` (`ws-server.https.test.ts › carries the HTTPS origin once ready`); the serve command and every serve state from recorded `serve status --json` (`tailscale.test.ts`, 15 cases). Manifest: `name`/`short_name` "Multi-Code", `display: standalone`, `id`/`scope`/`start_url` `/`, icons 180/192/512, `apple-touch-icon`, `apple-mobile-web-app-title`. The real serve and the Home Screen need the iPhone (plan §1) | iPhone-only |
| 2 | 1 | Opens with no connection, shows the last content, says which side can't be reached | `h4`: with the harness's port closed, a reload opened from the service worker in 53–72 ms with the cached list and "Can't reach your Mac. Showing what it said just now."; a 502 from the reachability probe (Multi-Code down behind `tailscale serve`) read "Your Mac is on, but Multi-Code isn't answering."; the phone offline read "This phone is offline." `sw.test.ts › opens from the cache when Multi-Code is down behind tailscale serve (a fast 502)`. Tailscale off on either side and the Mac asleep: plan §7 | pass |
| 3 | 1 | Connects by itself within 3 s of unlock / being shown | `h4`: sockets cut, back in 573–597 ms; hidden then shown (visibilitychange), closed on hide and back in 32–34 ms; a half-open socket found by the ping after 20.0 s and replaced in 0.5 s; the Mac back after offline, connected in 0.6 s with no tap. `transport.test.ts › closes when the page is hidden and dials at once when it is shown`. Real lock/unlock: plan §8 | pass |
| 4 | 1 | The port takes connections from this Mac only; the tailnet only through `tailscale serve` | `ws-server.https.test.ts › listens on 127.0.0.1 only`; `lsof` on the live build: `127.0.0.1:7821 (LISTEN)`, and the iPhone script's dry run `127.0.0.1:6799` | pass |
| 5 | 1 | A v1 phone is not migrated; the desktop says so | `live6`: "A phone paired with an earlier Multi-Code (an http://…:6768 address) must be paired again: remove its old Home Screen icon, then scan a new code." Protocol v3 refuses v1 (`ws-server.test.ts › refuses a protocol version mismatch`) | pass |
| 6 | 2 | Groups Needs you, Working, Finished, Idle; empty ones hidden; counts | `h1`: order and "NEEDS YOU · 2 \| WORKING · 1 \| FINISHED · 1 \| IDLE · 2"; the Working group went away when its turn ended | pass |
| 7 | 2 | Row: backend mark, name, state, age, one line per state | `h1`: Claude/OpenCode marks, ages (2m, 3m 20s ticking, Yesterday, Mon), "Bash: pnpm test:e2e", the question text, the running tool, the conclusion's first sentence, the last line. Live: "Bash: touch /tmp/mc-t813-proj/yes-….txt" (`live2`), "The ocean covers about 71% of Earth's surface." (`live1`). `ws-server.test.ts › instance states and previews` (10 tests) | pass |
| 8 | 2 | Header: the Mac's name and connection state | `h1`: `data-state="connected"`, "MacBook Air" | pass |
| 9 | 2 | The Manager is not in the list | `ws-server.test.ts › leaves the Manager out, and lists stopped instances as Idle` (the harness has no Manager) | pass |
| 10 | 2 | The list updates live | `h1`: the working row's tool changed on the next tool; `live1`: Idle → Working in 0.9 s → Finished | pass |
| 11 | 3 | My messages right-aligned bubbles; agent text full width, Markdown | `h1`: bubbles flush right, agent text the chat's full width, headings, lists, tables, code blocks; `live1`: Claude's numbered list as `<ol>` | pass |
| 12 | 3 | A finished turn folds into one line with counts and duration; the conclusion always shown | `h1`: "12 tools · 6 read · 3 edited · 2 commands", "2m 41s", the conclusion under it. `turns.test.ts › the fold line` | pass |
| 13 | 3 | Tapping the fold: one line per tool, action, target, result | `h1`: 12 lines; Edit/Write "+48", "+12−30"; Bash "✗ failed" / "✓"; others "✓" | pass |
| 14 | 3 | A Working turn's fold is open, grows, running tool marked | `h1`: open and live, one running line, a line added on the next tool | pass |
| 15 | 3 | Opening a finished session lands on the start of its conclusion | `live1`: a real 40-line answer, the conclusion's top 9 px below the chat's top (the margin is 8). `turns.test.ts › landingOf` | pass |
| 16 | 3 | Last 10 turns first; "Earlier turns" loads 10 more | `h1`: 10 of 13, then 13 | pass |
| 17 | 3 | Works the same for Claude and OpenCode | Claude live (`live1`–`live3`). OpenCode: `opencodeDb.test.ts › reads every turn with ids, times, outcomes and line counts, in both vocabularies`, `… › selects the last turns and says earlier ones exist`, `turns.test.ts › reads OpenCode's names the same, a !command (shell) as a command`; harness OpenCode rows and dialogs (`h1`, `h3`). Not run against a live OpenCode (the builder's shared service) | pass |
| 18 | 4 | One compose box; only Send sends; Return makes a new line | `h2`: Enter put a newline, nothing sent; `Compose.test.tsx › never sends on Return, plain, modified or from a composing IME` | pass |
| 19 | 4 | A Chinese IME's Return never sends; dictation works | The textarea has no key handler at all (unit test above). The real IME and dictation: plan §3 | iPhone-only |
| 20 | 4 | A sent message shows at once, marked until the Mac confirms | `h2`: the bubble on the next frame (3–14 ms), "Sending…" then confirmed; no frame without it (`flicker.mjs`, 8 sends) | pass |
| 21 | 4 | While Working the message still goes, and the box says "Queued until this turn ends" | `h1`: placeholder and hint; `ws-server.test.ts › is still sent while the agent works (the CLI queues it)` | pass |
| 22 | 4 | No compose box while a dialog is open; the Mac refuses a message sent anyway | `h2` and `live2`: no textarea with a dialog up; a raw client's prompt got `dialog-open` ("Answer the dialog first"), and the text never reached the CLI's transcript | pass |
| 23 | 4 | Offline: waits ("Waiting to send"), can be cancelled, sent once on reconnect; never twice | `h2`: two queued, one cancelled, the other survived a reload and went once, also after another reconnect; the cancelled one never went. `live4`: with the link off, delivered once on reconnect, with the app open and with the app closed meanwhile (1 user record each, also after a further reconnect). `ws-server.test.ts › acks are kept per device` (5 tests) | pass |
| 24 | 4 | A refused message says why and keeps its text | `h2`: "✗ A dialog is open: answer it first, so the text doesn't land in it." with the text, Open terminal and Dismiss | pass |
| 25 | 4 | The draft survives the app being closed | `h2`: after a reload, and in a new page of the same storage; `drafts.test.ts`. A real app kill: plan §3 | pass |
| 26 | 5 | Permission: a card with tool, command or file, the CLI's description, one button per option with the CLI's label | `h3` (harness: Claude's three options, OpenCode's Allow once / Always allow / Reject). `live2`: "Bash command", `touch …`, "Create file at specified path", and the CLI's own two options for an `ask`-rule dialog, Yes and No, read from the CLI's screen. (2.1.312 offers no "don't ask again" for a call an `ask` rule caught; the three-option card was answered live in T-808.) | pass |
| 27 | 5 | "No…" and "Reject" open a reason field, sent with the denial | `h3`: `{effect: "deny", feedback}` for both. `live2`: the reason reached Claude and it answered as told; the command didn't run | pass |
| 28 | 5 | Question box: every question, one page each, radio / check boxes, "Type something", answered ones fold with Edit, one Submit | `h3`: pages "1 / 2 · pick one", "2 / 2 · pick any", folds with Edit, editing keeps the rest, one frame `[{question 1, picks [1]}, {question 2, picks [1,3], text}]`. `live3`: a real two-question box with a multi-select; Claude repeated "Blue … Cheese and Olives" | pass |
| 29 | 5 | Plan: in full as Markdown, scrollable, the CLI's three options; "No, tell Claude what to change" opens a field | `h3`: headings, list, table, code, scrolls, pulls down and back. `live3`: the CLI's own three labels; revised ("what to change" reached Claude), the revised plan came back as a new dialog and was approved; the file has the revised content. Found Bug 1 here, fixed | pass |
| 30 | 5 | "Always allow" / "don't ask again" and "auto-accept edits" ask "Are you sure?" first | `h3`: all three; nothing sent before; `confirmed: true` after. A raw `allow-always` without it got `needs-confirm` | pass |
| 31 | 5 | An answer for a dialog that has gone is refused and the phone says so; nothing pressed | `h3`: the desk answered while the phone's tap was on its way (frames held in the page): `gone`, "This dialog was already answered."; a stale seq from a client: `gone`, the dialog left open. `ws-server.test.ts › is refused as gone for a seq that isn't the live dialog's, or with none open` | pass |
| 32 | 5 | The card goes when answered on either side | `h3` (desk-answer), `live2` (phone) | pass |
| 33 | 5 | A dialog the phone can't show says to use the terminal and offers it | `h3`: "The phone can't show this dialog. Answer it in the terminal." and Open terminal (one tap). `ws-server.test.ts › has no dialog for one the desktop can't answer, so the phone offers the terminal` | pass |
| 34 | 5 | Dialogs can't be answered with no connection | `h3`: every option disabled, "No connection to your Mac. You can answer once it's back." Answers are never queued (`outbox.test.ts › puts prompts back in the queue when their socket drops, and marks answers and interrupts unknown`) | pass |
| 35 | 6 | While Working: a bar with the running tool, the turn's time, Stop | `h1`; `live3`: "Bash sleep 45 && echo slept-… · 2s" | pass |
| 36 | 6 | Stop asks "Stop this turn?", then does what Esc does: the turn ends, the session stays running | `h1` (one `interrupt`, acked); `live3`: the turn ended 336 ms after the tap ("Request interrupted by user"), the session still running and Idle. OpenCode's two Escs: `process-manager.secretary.test.ts › writes OpenCode's two Escs, 250 ms apart` | pass |
| 37 | 6 | No Stop while a dialog is open | `h1`, `h3` (no bar); `live2`: a raw `interrupt` got `dialog-open` ("A dialog is open; Esc would answer it") | pass |
| 38 | 7 | A push for every Finished and Needs you, every session but the Manager, at the desk or not | `live5`: a Finished and a Needs you push from a real session, with the session open at the desk the whole time; `ws-server.test.ts › sends nothing for a restated dialog, or for the Manager` | pass |
| 39 | 7 | Delivered with the app closed and the phone locked | Needs the iPhone and Apple's push service (G-302, plan §10) | iPhone-only |
| 40 | 7 | Title: name and state; body: what the dialog asks / the conclusion's first sentence | `live5`, decrypted: "qa-claude · Finished" / "Fine thanks, all 74171 done."; "qa-claude · Needs you" / "Bash: touch /tmp/mc-t813-proj/push-74171.txt" | pass |
| 41 | 7 | Tapping it opens that session | `live5`: `navigate` = `https://qa-mac.example.ts.net/#/s/t813-a`; `push-check`: a tapped notification opens its session; `sw.test.ts › opens the session a tapped notification is about when the app isn't open`. On iOS: plan §10 | iPhone-only |
| 42 | 7 | A newer push for a session replaces its older one | `live5`: every push for the session carries `tag: t813-a` and the same `Topic` header. What iOS shows: plan §10 | pass |
| 43 | 7 | The icon's badge is the number of sessions that need me | `live5`: `app_badge` 1 with the dialog up, 0 after; `push-check`: `setAppBadge` follows the list and a desk answer. The real icon: plan §10 | iPhone-only |
| 44 | 7 | No push to a phone that has the app open and connected | `live5`: a phone pinging every 4 s got none for a Finished, the same phone closed got the next; `ws-server.test.ts › skips a phone with the app open, until it has gone quiet` | pass |
| 45 | 7 | Turning notifications on is one tap, only from the Home Screen icon; Safari says so | `h4`: in Safari step 3's button is disabled with "Only works from the Home Screen icon."; `push-check` (Home Screen stubbed): one tap asks, subscribes with the Mac's VAPID key, sends it, acked; denied says how to allow. The real prompt: plan §10 | pass |
| 46 | 7 | The desktop can send a test push to each phone | `live5`: Send test → "Multi-Code · Test" decrypted at the fake service; `live6`: a phone without a subscription says why | pass |
| 47 | 8 | One tap opens the terminal at the Mac's width; it scrolls sideways | `h4`: 120 cols × 36 rows, 775 px wide in a 393 px box, scrolls; `live7`: the PTY's 66 × 48, rows equal to the desk's | pass |
| 48 | 8 | Key row: Esc, Tab, Shift+Tab, ↑ ↓ ← →, Space, Return, Ctrl+C | `h4`: each key's bytes (`\x1b`, `\t`, `\x1b[Z`, `\x1b[A`…`\x1b[C`, space, `\r`, `\x03`); `live3`: Shift+Tab from the row put the real CLI in plan mode | pass |
| 49 | 8 | Tapping a key doesn't close the keyboard | `h4`: the focus stayed on the line through all ten keys (WebKit). The real keyboard: G-305, plan §5 | iPhone-only |
| 50 | 8 | A line sends typed text as typed, no Return added | `h4`: "abc 你好" sent as is; the keyboard's Return sent nothing | pass |
| 51 | 8 | One tap back to the chat | `h4`, and the terminal kept alive (same xterm, no replay) | pass |
| 52 | 9 | Three checks, each with what it means and its fix (Open Tailscale; admin console link; Set up HTTPS showing its command; push) | `live6` with the checks forced into each state: running / stopped (Open Tailscale) / missing (Get Tailscale); certs off (Open admin console); serve missing (Set up HTTPS → "Multi-Code runs: tailscale serve --bg --https=443 http://127.0.0.1:7821", Run it ran nothing with the dev checker and said so); conflict (explained, nothing offered); push ready. The buttons that open Tailscale, the browser, and the real serve were not pressed: plan §0 | pass |
| 53 | 9 | The pairing QR only when every check passes | `live6`: no QR while any check fails; a QR on screen goes when a check stops passing | pass |
| 54 | 9 | Each phone: name, last seen, push on/off, Send test, Revoke | `live6`: "qa panel phone · connected · push off", "never connected · push off", Send test, Revoke | pass |
| 55 | 9 | Revoking disconnects at once, refuses the token, stops pushes | `live6`: closed 4003 after 6 ms, the row gone, the token refused; `live5`: a revoked phone's subscription got nothing | pass |
| 56 | 10 | Steps: paired, add to Home Screen (with Share), notifications (only from the icon); which is done and which next | `h1`/`h4` in Safari: "done:Paired · next:Add to Home Screen (Tap ⇪ … "Add to Home Screen") · later:Turn on notifications"; `push-check` with the Home Screen stubbed: step 2 done, step 3 one tap, "All set." The real Share sheet: plan §1 | pass |
| 57 | NFR | The list within 1 s of opening when the Mac is reachable; cached at once otherwise | Harness reloads 53–58 ms; live 53–221 ms; offline from the cache 53–72 ms (`h1`, `live7`, `h4`) | pass |
| 58 | NFR | A push within 5 s of the event | `live5`: sent 31 ms after the Stop hook's activity reached the desk (to the fake service; Apple's leg is the iPhone's, plan §10) | pass |
| 59 | NFR | Security: tailnet only, HTTPS; port on this Mac only; a token per phone; the key pinned; push end to end encrypted; keys and tokens 0600 | Row 4; `transport.test.ts › refuses a desktop whose key isn't the pinned one, and stops`; `ws-server.test.ts › rejects an unknown device token`; `live5`: `Content-Encoding: aes128gcm`, the body opens only with the subscription's keys and doesn't contain the name in clear; `remote-identity.json`, `remote-devices.json`, `remote-push.json` all 0600; the renderer's status carries no key and no subscription | pass |
| 60 | NFR | Compatibility: iOS 27 Safari and the Home Screen | The whole iPhone plan | iPhone-only |
| 61 | NFR | Compatibility: desktop Safari and Chrome for development | Every phone script in Playwright WebKit (Safari's engine); `push-check` 27/27 in Chrome | pass |
| 62 | NFR | Touch targets at least 44 pt | `h5`, hit areas measured (a control's `::after` counts): the terminal's keys 32 × 36 (Shift+Tab 42 × 36), the terminal line and its Send 36 tall, the compose box's text area 40 tall. The fold line was 43 tall and is now 45 (fixed). Everything else, list rows, cards, sheets, Stop, setup, is 44 or more | **FAIL** (Bug 2) |
| 63 | NFR | Text follows the system's dark or light setting | `h5`: every screen in both; body `rgb(20,21,24)`/`rgb(232,234,237)` dark, `rgb(240,244,250)`/`rgb(26,26,26)` light; screenshots in `shots/` | pass |
| 64 | Tech | The Mac holds all state; the phone only a cache and its outbox | The phone's storage holds `multicode.pairing`, `.cache`, `.outbox`, `.drafts`; everything else comes from the Mac (`cache.test.ts`, `outbox.test.ts`) | pass |
| 65 | Tech | No relay; push from the Mac straight to Apple's service | `live5`: `web-push` from main to the subscription's endpoint, nothing else contacted; no server of ours in the code | pass |
| 66 | Tech | Dialogs answered with the secretary's key flows (Claude) and OpenCode's API; the phone knows no key binding | `ws-server.test.ts › goes through to answerDialog with the secretary's keys, and acks ok`, `… › sends a denial's reason after the keys (Claude) or with the Reject (OpenCode)`; `opencodeAttention.test.ts › answer` (4 tests); the phone sends effects and 1-based picks only (`h3`) | pass |
| 67 | Tech | Report-only hooks and plugins stay as they are | `git diff master...feat/mobile-v2` leaves `claudeHooks.ts` and `opencodePlugin.ts` untouched; the phone path adds no hook and no plugin | pass |

## Edge cases
| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 1 | A plan approved 40–100 ms after it opened | The CLI takes it | Lost before the fix (Bug 1); taken after, 5 of 5 (3 raw, the phone UI's fast tap, `live3`) |
| 2 | A permission answered 0, 40, 100 ms after it opened | Taken | Taken, 7 of 7 (`race.mjs`) |
| 3 | The desk answers while the phone's tap is on its way | `gone`, nothing pressed in the next dialog | pass (`h3`) |
| 4 | A prompt while an answer's keys still go in | Refused | pass (`ws-server.test.ts › is refused while an answer's keys are still going in`) |
| 5 | A CLI still showing a dialog whose event a key cleared (Bug 1's state) | No text lands in it | pass in the one case seen: a phone prompt was refused "A dialog is open in its terminal; answer it there first" (from the CLI's own session state) |
| 6 | The phone link turned off and on with the phone open | Offline banner, then connected, nothing resent | pass (`live3`, `live4`) |
| 7 | A message queued, the app closed, the Mac back before it reopens | Nothing sent while closed; sent once on opening | pass (`live4`) |
| 8 | Two codes, one used by a phone, then New code | The used one kept, the unused one revoked | pass (`live6`) |
| 9 | Done with a code shown | The code kept (paste hand-off) | pass (`live6`) |
| 10 | The push service answers 500, then 201, then 410 | Error shown, cleared, then the subscription dropped | pass (`live5`) |
| 11 | A revoked phone with a subscription | No push | pass (`live5`) |
| 12 | Pinyin text through the terminal's line | Sent as typed | pass (`h4`, "abc 你好") |
| 13 | Opening the terminal and going back | Same xterm, no resubscribe | pass (`h4`) |
| 14 | Sheets pulled down and up | Bar, then the sheet | pass (`h3`) |
| 15 | The Phone panel with the checks moving under a shown QR | QR goes | pass (`live6`) |

## Issues found
| # | Criterion / case | What went wrong | Severity | Fix |
|---|------------------|-----------------|----------|-----|
| 1 | Story 5 (plan), edge 1 | Steps: plan mode, ask for a plan, answer its ExitPlanMode dialog within about 100 ms of the phone receiving it (revise first, then approve the revised plan as it appears, as a quick tap or a finger already on the sheet would). Expected: the CLI approves. Actual: the CLI dropped the key; our first key had already cleared the needs-you event, so the phone showed the compose box and the desk listed the session as Idle while the CLI kept waiting on the dialog. Measured on 2.1.312 with a raw client: lost at 40 ms (3 of 3) and 100 ms (1 of 1) after the `prompt-state`, taken at 250 ms; a fresh plan at 40 ms was lost too (2 of 2); a permission took a key at 0–100 ms (7 of 7). Through the phone UI: lost 3 of 3 (the CLI's screen still showed the dialog 45 s later). A phone prompt sent while it was stuck was refused ("A dialog is open in its terminal"), so no text landed in it that time | medium | **Fixed.** `process-manager.ts` `answerDialog`: the first key waits until the dialog is `dialogSettleMs` (500 ms) old (`AnswerTiming`), then checks again that the instance, its PTY and the very event are still there (else `stopped` / `answered`). Phone and secretary both go through it. Tests: `process-manager.secretary.test.ts › waits until a dialog that has just come up is old enough for its first key`, `… writes at once to a dialog that has been up long enough`, `… writes nothing when the dialog is answered at the desk while it waits`, `… writes nothing when the process exits while it waits`. Live after the fix: fresh plan at 0 and 40 ms, revised plan at 40 ms, the phone UI's fast tap: all taken; `live3`'s plan path passes |
| 2 | NFR accessibility | Under 44 pt to tap: the terminal's ten keys (32 × 36, Shift+Tab 42 × 36), the terminal line and its Send (36 tall), the compose box's text area (40 tall; its Send is 44). The fold line was 43 and is fixed (its `::after` hit area, 35 → 45) | low | Builder's call, since mockups 2.1 and 4.1 drew these sizes: keys and the terminal line 44 tall (the row grows 8 pt each); ten keys can't be 44 wide on a 393 pt screen, so either two rows, a row that scrolls sideways, or accept about 35 pt wide keys; the compose text area `min-height: 44px`. The plan's §5 asks how the keys feel |

Also seen, low, not filed: an acked phone message whose text the CLI recorded differently
(text half-typed at the desk got prefixed to it) stays as a bubble at the chat's end until
the outbox drops it an hour later (`outbox.ts`, supervisor call #54). It happened here
only because a probe typed a stray `2` into the desk's prompt.

## Fix made in this ticket (asked for)
"New code" in the Phone panel revokes the code it replaces when no phone has used it;
Done keeps it. The renderer passes the shown code's row (`RemotePairing.deviceId`, new) to
`remote-create-pairing`, which makes the new code and then calls
`RemoteServer.revokeUnusedDevice(id)`: revoked only while the row has never been heard
from and no socket has authenticated with it, checked and done in one synchronous step in
main (the first version decided in the renderer from a status snapshot; the GPT review
showed a phone authenticating between that read and the revoke would lose its new
pairing). `createPairingOffer()` returns `{ offer, deviceId }`; the offer (the QR) is
unchanged. Tests: `ws-server.test.ts › names the row each code made, and revoking it
cancels that code only`, `… › revokes a replaced code only while no phone has used it`;
live: `live6` (unused revoked, used kept, Done kept). The panel's caption now says so.

## Recommendation
Every criterion automation can reach passes except the 44 pt audit, which needs a design
call. Bug 1 would have left a plan approved from the phone silently unapproved; it is
fixed and re-checked live. The epic is ready for the builder's iPhone test
(`test-plan-iphone.md`, `workspace/app/scripts/mobile-qa/iphone-qa.sh`), which covers the
7 iPhone-only rows and closes G-302, G-305, G-306 and the 10-minute part of G-301.

## After QA: found on the builder's iPhone (2026-10-30)

Using the dev build on the real phone turned up four bugs the automated checks missed. All
were fixed and merged before 0.10.0; the fixes were checked live against Claude 2.1.312 and
in the harness, and each has unit tests. 2023 tests pass on the release.

| Gap | Bug | Fix |
|-----|-----|-----|
| G-321 | A session read on the phone stayed unread (red dot) on the desk | `instance-read-on-phone(id)` from main; the renderer clears the count (56616a3) |
| G-322 | `/new` sent from the phone left the old chat on the phone | SessionStart moves the session at once; transcripts carry `session`; the phone starts afresh (0085331, 4ca5ce7) |
| G-323 | `/token` and the CLI's "Unknown command" reply never reached the phone | `TranscriptEntry.local`, shown as grey lines (0085331, 4ca5ce7) |
| G-324 | Opening the keyboard pushed a short chat out of view | The session screen follows `visualViewport` while a field has focus; a short chat sits above the compose box (4ca5ce7) |

The harness's keyboard simulation (`pnpm harness:shot --focus <selector> --keyboard 336 --pan 336`)
reproduced G-324 on the build before the fix, so it is worth using for future keyboard
work. Still open after the release: G-325, G-326, and the iPhone-only rows above.
