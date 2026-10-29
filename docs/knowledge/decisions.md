# Decisions Log — Multi-Code

Append-only log of architectural and product decisions. Each entry: date, decision, rationale, source. Newest first.

---

## 2026-10-30 — A session read on one side is read on the other

**Decision:** Reading is shared between the desk and the phone. Opening a session on the phone, a Finished or Needs-you reported while a phone that is looking (an authenticated socket heard from in the last 20 s) has that session open, and a quiet phone resuming with it open, all clear the desk's unread for it: main sends `instance-read-on-phone(id)` and the renderer drops the count and any pending increment, without acknowledging back. Reading it at the desk (the renderer's `markRead`) makes it Idle on the phone (`instance-acknowledged(id)`, G-304). The desk chime is unchanged.

**Why:** The builder found on the iPhone that a session read there stayed unread on the desk (G-321). Only the other direction had been built.

**Consequences:** With Secretary Mode on, a session read on the phone has no red dot, so a click at the desk no longer opens its brief by itself; the header's Secretary button still does. An OpenCode finish in a background session isn't cleared by a phone watching the contact's own session.

**Source:** builder's iPhone test, 2026-10-30 (G-321); fix 56616a3
**Affects:** `main/remote/ws-server.ts` (`isReading`, the subscribe and resume paths), `main/process-manager.ts` (`reportActivity`, `readOnPhone`), `main/remote/index.ts`, `renderer/hooks/useNotifications.ts`, `renderer/App.tsx`

---

## 2026-10-30 — The phone follows the CLI's session, and sees the CLI's own lines

**Decision:** Every transcript sent to the phone names the CLI session it comes from (`TranscriptFrame.session`). A Claude SessionStart hook (as after `/new` or `/clear`) moves the contact to its new session at once, without waiting for the 4 s registry poll, and the phone gets the new session's transcript right away, empty until it has entries; the phone then drops the old chat, shows "New session" and settles bubbles sent before the change. A slash command the builder runs and the CLI's own reply to it (`<local-command-stdout>`, "Unknown command: /token") reach the phone as `local` entries, shown as grey lines; they start no turn, stay out of fold counts and are never a turn's conclusion. `readTranscript` and `readBuilderTurn` (manager, secretary) are unchanged.

**Why:** On the iPhone, `/new` sent from the phone left the old chat on screen though the desk had cleared, and `/token` showed nothing on the phone while the desk said the command was unknown (G-322, G-323). The turn reader had left all local rows out on purpose.

**Consequences:** OpenCode records no comparable rows, and its `/new` makes no session until the next prompt, so there the old chat stays until then. Bash mode (`!cmd`) and other CLI notices still don't reach the phone (G-325).

**Source:** builder's iPhone test, 2026-10-30 (G-322, G-323); fixes 0085331, 4ca5ce7
**Affects:** `shared/remote-protocol.ts` (`TranscriptEntry.local`, `TranscriptFrame.session`), `main/backends/claudeTranscript.ts`, `main/backends/recentTurns.ts`, `main/process-manager.ts` (`handleAlertDelivery`, `readRecentTurns`), `main/remote/remote-host.ts`, `renderer-mobile/state.ts`, `renderer-mobile/turns.ts`, `renderer-mobile/screens/SessionScreen.tsx`

---

## 2026-10-30 — The phone's chat follows the keyboard

**Decision:** While the compose box (or a dialog's text field) has focus, the session screen is sized and placed to `visualViewport`, so iOS has nothing to pan out of view; a chat shorter than the screen sits right above the compose box, as in a messaging app. The same hook (`renderer-mobile/keyboard.ts`) serves the terminal's key row. Sizing applies only while a field has focus, because in a standalone app `visualViewport.height` can stay about 68 pt short after the first keyboard (WebKit 322900).

**Why:** On the iPhone, opening the keyboard in a short chat pushed every message out of view; the builder thought the chat was empty (G-324).

**Source:** builder's iPhone test, 2026-10-30 (G-324); fix 4ca5ce7
**Affects:** `renderer-mobile/keyboard.ts`, `renderer-mobile/screens/SessionScreen.tsx`, `session.css`, `components/DialogSlot.tsx`, `screens/TerminalScreen.tsx`

---

## 2026-10-29 — A Claude plan dialog gets 500 ms before the first key

**Decision:** `answerDialog` writes no key until the dialog it answers is 500 ms old (`AnswerTiming.dialogSettleMs`), then checks that the instance, its terminal and the same needs-you event are still there. This holds for the phone and the secretary.

**Why:** At QA, Claude Code 2.1.312 dropped an ExitPlanMode answer written 40 or 100 ms after the dialog's PermissionRequest hook (5 of 5); one at 250 ms was taken. The first key clears the needs-you event, so a dropped key left phone and desk showing Idle over a dialog still waiting (G-320).

**Consequences:** A tap on a plan right after it opens takes up to half a second to land. This is the knob if it ever feels slow.

**Source:** mobile-v2 T-813 QA (`docs/specs/mobile-v2/qa-report-m1.md`, Bug 1)
**Affects:** `main/process-manager.ts` (`answerDialog`, `ANSWER_TIMING`)

---

## 2026-10-29 — A pairing code is one phone's secret, and the Home Screen app is paired by paste

**Decision:** Each "Pair a phone" or "New code" mints a device row with its own token at once, valid until the builder revokes it, so a code can be used later. "New code" revokes the code it replaces when no phone ever connected with it; "Done" keeps the shown code. After pairing in Safari, the phone's setup screen offers "Copy pairing link" (rebuilt from the stored pairing); the Home Screen app, when unpaired, offers "Paste pairing link" (one tap, iOS's Paste bubble) and empties the clipboard after. The desktop's Phone panel has its own "Copy pairing link", which Universal Clipboard carries to the iPhone.

**Why:** A scanned QR always opens Safari, and an iOS Home Screen app may keep its own storage apart from Safari's, so a pairing made in Safari may never reach it (G-306). Pasting works either way. A code shown and then replaced before any phone used it is a secret nobody needs; one already used is a phone.

**Consequences:** The pairing link holds the device token, so it sits on the clipboard until the paste empties it. Rows for codes never used ("New device · never connected") stay until revoked, unless "New code" replaced them.

**Source:** supervisor calls, mobile-v2 (`.omt/mobile-v2-decisions.md`, T-806 "Worth your review", #65, #100); T-811, T-812, T-813
**Affects:** `main/remote/ws-server.ts` (`createPairingOffer`, `revokeUnusedDevice`), `main/ipc-handlers.ts` (`remote-create-pairing`), `renderer/components/PhoneSection.tsx`, `renderer-mobile/screens/SetupScreen.tsx`, `renderer-mobile/pairing.ts`

---

## 2026-10-29 — Only typed messages wait for the connection; answers and Stop are sent once or not at all

**Decision:** A message typed on the phone gets a `clientMsgId`, waits in an outbox kept in `localStorage` while there is no connection ("Waiting to send", cancellable until it goes out), and is resent on every connect until the Mac acks it. The Mac keeps the last 200 `clientMsgId`s per device, with their acks, in memory: a resend gets the same ack and isn't acted on again. Answers and Stop are never queued offline (the phone disables them) and never resent: one whose socket dropped before its ack says "may not have arrived" and asks the builder to check the session.

**Why:** A message is the same message an hour later; the CLI queues it behind a running turn. An answer or a Stop is about the screen at that moment: resent after a reconnect it could land on a newer dialog or stop a newer turn.

**Consequences:** A Multi-Code restart between a send and its ack could deliver a message twice (the dedupe is in memory); rare, and visible in the transcript.

**Source:** builder, 2026-10-29 ideation (mockups: messages queue offline, dialogs can't be answered offline); supervisor calls, mobile-v2 (`.omt/mobile-v2-decisions.md` #6, #54); `shared/remote-protocol.ts` (`AnswerFrame`)
**Affects:** `renderer-mobile/outbox.ts`, `renderer-mobile/store.ts`, `main/remote/ws-server.ts` (acks, `ACKS_KEPT`)

---

## 2026-10-29 — Phone answers go the secretary's way, named by a seq that never repeats

**Decision:** A dialog answered from the phone goes through the same path as the secretary's: `checkChoice` on the dialog the Mac has, then `answerDialog`, which presses Claude Code's measured key flows only while that same dialog is still open, and answers OpenCode through its API by request id. The phone never knows a key binding. Each dialog is named by the secretary event's `seq`, which is `max(previous + 1, Date.now())`, so it never repeats across launches without being persisted. An answer whose `seq` isn't the live dialog's is refused (`gone`) and presses nothing. "Always allow", "don't ask again" and auto-accept edits need the phone's own "Are you sure?" (`confirmed`), else `needs-confirm`.

**Why:** The key flows are already measured against the real CLIs and guard against the dialog changing under the keys. A seq that restarted at 0 on each launch would let a card shown before a restart answer a different dialog after it.

**Alternatives considered:** the v1 path (`choose`, one digit per question), deleted with its helpers.

**Consequences:** A backward clock step across a relaunch could in theory repeat a seq (accepted: it also needs a dialog in the same millisecond and an answer to a pre-restart card). Phone answers don't wait for a PostToolUse record (`answerDialog` without `expect`), which sessions' alert hooks never send. The first key waits until the dialog is 500 ms old (`dialogSettleMs`): Claude Code 2.1.312's plan box dropped an approve written 40 or 100 ms after its PermissionRequest hook, while that key had already cleared the needs-you event, so phone and desk showed Idle over a waiting dialog; 250 ms was taken (T-813 QA, Bug 1).

**Source:** PRD `docs/specs/mobile-v2/prd.md` Technical Constraints; supervisor calls, mobile-v2 (`.omt/mobile-v2-decisions.md` #33, #34, #35, #39, #95), T-803; `docs/specs/mobile-v2/qa-report-m1.md` Bug 1
**Affects:** `main/remote/remote-host.ts`, `main/process-manager.ts` (`secretarySeq`, `answerDialog`), `main/secretary/dialog.ts`

---

## 2026-10-29 — The phone replies, answers and stops; everything else stays on the desk

**Decision:** From the phone the builder can send a message to a session, answer its dialog, and stop its running turn, plus the terminal fallback's keys and typed text. Starting, stopping, creating and renaming sessions stay on the desktop, and the Manager and the secretary are not on the phone (phase 2). The Mac refuses a message while a dialog is open (`dialog-open`), so text never lands in a dialog, and refuses Stop while a dialog is open (Esc would answer it) or with no turn running (`not-working`). A second Stop for the same turn within 3 s is refused.

**Why:** Phase 1 solves opening, typing, answering and being told. Esc on a Claude dialog denies it, and a double Esc on an idle Claude opens its rewind menu.

**Consequences:** OpenCode's Stop is two Escs 250 ms apart, sent only while its terminal shows the running session (G-303). The terminal's keys go in as typed, as the builder's own typing at the desk does.

**Source:** builder, 2026-10-29 ideation (G-315, G-316); supervisor calls, mobile-v2 (`.omt/mobile-v2-decisions.md` #11, #36, #37), T-803
**Affects:** `main/remote/remote-host.ts` (`prompt`, `interrupt`), `main/backends/types.ts` (`interrupt`), `renderer-mobile/screens/SessionScreen.tsx`

---

## 2026-10-29 — A push for every Finished and Needs you, except to a phone that is looking

**Decision:** Every Finished and every Needs you of every session but the Manager sends a push to each phone that turned notifications on, whether or not the builder is at the desk, except to a phone that has the app open and connected at that moment (an authenticated socket heard from in the last 20 s). Title `<name> · Finished` or `<name> · Needs you`, body the session's one line (at most 180 characters). One tag and Topic per session, so a newer push replaces the older one; the Home Screen badge is the number of Needs-you sessions. A restated dialog sends nothing. Urgency high, TTL 1 hour.

**Why:** The builder chose "every time". A phone with the app open shows the change itself. 20 s and not the 45 s heartbeat, because a locked phone's half-open socket would otherwise hold its pushes back.

**Alternatives considered:** a push only when the desktop is idle or locked (not chosen).

**Consequences:** Nothing is pushed when a Needs you clears; the badge is corrected by the next push or when the app opens. A subscription the push service says is gone (404/410) is deleted; any other failure is the phone's `lastPushError` until a push works.

**Source:** builder, 2026-10-29 ideation (G-313); supervisor calls, mobile-v2 (`.omt/mobile-v2-decisions.md` #8, #9, #42, #44, #45, #48), T-810
**Affects:** `main/remote/ws-server.ts` (`LOOKING_MS`, the push trigger), `main/remote/push.ts`, `renderer-mobile/sw.ts`, `renderer-mobile/push.ts`

---

## 2026-10-29 — Multi-Code runs `tailscale serve` only on the builder's button, and never removes it

**Decision:** The only thing in Multi-Code that changes Tailscale is the Phone panel's "Set up HTTPS". It shows `tailscale serve --bg --https=443 http://127.0.0.1:6768` first, and on a second press checks again that nothing serves port 443 and runs it. If 443 already serves anything else (another port or host, Funnel, an extra mount), the panel says so and changes nothing. Multi-Code never removes the serve, even with the phone link off; the panel shows how (`tailscale serve --https=443 off`). Everything else only reads: `tailscale status --json`, `tailscale serve status --json`.

**Why:** The serve config is the builder's Tailscale configuration, and the serve command replaces whatever is mounted at `/` without asking. Funnel would make Multi-Code public.

**Consequences:** A writer racing the button in the same milliseconds isn't guarded (the CLI has no conditional write). With the phone link off the serve answers 502. Tests and the harness inject a checker and never run the CLI; a dev build reads its checks from `MULTICODE_DEV_REMOTE_CHECKS`. A serve set up for a dev build's port shows as a conflict to the release on 6768 until the builder removes it.

**Source:** supervisor calls, mobile-v2 (`.omt/mobile-v2-decisions.md` #3, #16, #17, #19), T-805, T-812
**Affects:** `main/remote/tailscale.ts`, `main/remote/dev-overrides.ts`, `main/ipc-handlers.ts` (`remote-setup-https`), `renderer/components/PhoneSection.tsx`

---

## 2026-10-29 — The phone server listens on 127.0.0.1

**Decision:** The phone link's server (port 6768) binds to 127.0.0.1. The tailnet reaches it only through `tailscale serve`, which proxies `https://<machine>.<tailnet>.ts.net` to it. The pairing offer carries that HTTPS origin and nothing else, and no offer is made unless the HTTPS check is ready.

**Why:** Only `tailscale serve` should reach it. Listening on every interface put the phone's socket on the home LAN and on any network the Mac joins, and an `https://` page can't open a `ws://` LAN socket anyway.

**Consequences:** The phone no longer works on the home WiFi without Tailscale. The NaCl seal and per-phone tokens stay inside TLS.

**Source:** supervisor calls, mobile-v2 (`.omt/mobile-v2-decisions.md` #1, #2), T-805
**Affects:** `main/remote/ws-server.ts` (`start`, `createPairingOffer`)

---

## 2026-10-29 — The phone app is a PWA served by `tailscale serve`, with Web Push from the Mac

**Decision:** The phone client is a web app on the iPhone's Home Screen, served by Multi-Code at `https://<machine>.<tailnet>.ts.net` through `tailscale serve`, which supplies the certificate. Notifications are Web Push messages the Mac sends itself (VAPID keys in `userData/remote-push.json`, encrypted to each phone) straight to Apple's push service. No native app, no relay or cloud service of ours, no path to the Mac without Tailscale. The tailnet's HTTPS Certificates are enabled for it. Protocol v3; phones paired with v1 are not migrated and pair again once.

**Why:** v1 stopped being used: its saved `http://<ip>:6768` address couldn't load while Tailscale was stopped, and an iPhone web app on plain `http://` can never receive a push. HTTPS gives the app a stable origin, a service worker that opens it offline, and Web Push, with no Apple developer account. The builder accepted that the machine name goes into the public Certificate Transparency logs, for good; only tailnet devices can reach it.

**Alternatives considered:** a native iOS app (answers from the lock screen, Live Activities): not chosen, both are given up.

**Consequences:** The iOS-only parts (Home Screen, keyboard, push) are checked on the builder's iPhone, since there is no simulator here (G-319). A Home Screen app may not share Safari's storage (G-306), hence the paste hand-off above.

**Source:** builder, 2026-10-29 ideation (`docs/timeline/2026-10-29_mobile-v2-ideation.md`, G-311, G-312); research `docs/timeline/2026-10-13_mobile-v2-research.md`
**Affects:** `main/remote/ws-server.ts`, `main/remote/tailscale.ts`, `main/remote/push.ts`, `renderer-mobile/`, `shared/remote-protocol.ts`

---

## 2026-10-28 — A drop takes at most 10 files and 1 GB, and no folders

**Decision:** One drop copies at most 10 files and at most 1 GB (1,000,000,000 bytes, as Finder counts) in total. Folders are not accepted. Past either limit, or with a folder in it, the whole drop is refused: nothing is copied, and the message says to place the files in Finder, naming the default folder when there is one. The main process enforces the same limits on its own.

**Why:** Asked by the builder after the first real Finder test. A big or unusual drop is better done in Finder, where progress and conflicts are visible; the builder never drops folders. Refusing the whole drop avoids a half-placed batch the builder would have to sort out.

**Source:** 2026-10-28, builder's Finder test of the file-drop epic (PRD v1.2, Story 6).
**Affects:** the drop flow and its message; the copy IPC; folder copying is removed from the copy engine.

---

## 2026-10-28 — A file dropped on Multi-Code is copied into the project, and nothing more

**Decision:** A file (or folder) dragged from Finder onto any part of the window is copied into the selected session's project, to that project's default folder or to a folder picked for this drop only. Multi-Code never types into the session afterwards; the builder tells the session, as today. v1 takes Finder drags only, and every file type.

**Why:** The builder's current way is "Go to Code Base", then a drag inside VS Code. Placing the file is the whole job. Writing into the session would tie the feature to the session's state, and a write into a session waiting on a dialog can answer it. Copying does not look at the file type, so a type list would only be extra work.

**Source:** 2026-10-28 file-drop ideation.
**Affects:** a drop handler in the renderer; a copy IPC in main; the preload (`webUtils.getPathForFile`).

---

## 2026-10-28 — Each project has its own default drop folder, which the builder picks

**Decision:** The default drop folder is per project, keyed by the project directory (cwd), so two contacts on one project share it. The first drop in a project says there is no default folder yet and opens a folder picker; the folder picked becomes the default, and the files go there. Every later drop confirms the folder. "Choose another folder" applies to that drop only; "Change default path" changes the project's default. Multi-Code finds no folder by itself, and nothing depends on OMT.

**Why:** Project layouts differ, so one global path would put files in the wrong place. The builder knows where a project's files belong; the OMT input folder is only one example of a folder they pick. (A look-up order from OMT folders was recorded first and corrected by the builder in the same session.)

**Source:** 2026-10-28 file-drop ideation.
**Affects:** a per-project folder map in the persisted settings; the drop confirmation.

---

## 2026-10-27 — Multi-Code moves an OpenCode terminal's view with keys it binds there

**Decision:** To show a finished turn's conclusion from its first line in OpenCode, Multi-Code binds one more key each to OpenCode's own `session.last` and `session.message.previous`, only in the terminals it starts (`OPENCODE_CLI_CONFIG_CONTENT`, after the builder's own keys for those commands), and sends those keys itself. The keys are Cmd+Ctrl+Option+Shift+F11/F12, which no keyboard can send into Multi-Code's terminal. They go through their own IPC, not as input: the run state, the secretary's event and the phone's badge stay as they are. The TUI plugin stays report-only.

**Why:** OpenCode draws on the alternate screen and scrolls itself, so the terminal can't be scrolled the way Claude's classic renderer is. Its "previous message" command, pressed at the bottom, puts the last message with text (the conclusion) at the top. Multi-Code already passes a per-process key setting there (Ctrl+Z off).

**Alternatives considered:** the TUI plugin runs the commands itself (`ctx.keymap.dispatch`): no writes to the terminal, but the plugin would navigate, against its report-only rule.

**Consequences:** before pressing anything Multi-Code reads OpenCode's screen: a conclusion already on screen, or "Jump to latest ↓" (the builder scrolled up during the turn) on a terminal shown as the turn ended, means no keys. A look that finds no conclusion afterwards goes back to the bottom. A turn ending moves nothing unless it is the contact's own session and that session is on screen: OpenCode's finish names its session, so a background tab finishing, or the terminal on a subagent's session, one another contact holds, or home, gets no keys. A jump still waiting for the screen stops when the builder presses a key, clicks or scrolls in the terminal, or the next turn starts; mouse motion, focus reports and xterm's replies to OpenCode's queries don't stop it. Measured on 2.0.32 with an isolated service: shown, out of sight, the turn after a jump, a short answer and a mid-turn PageUp all behaved as above.

**Source:** builder, 2026-10-27, in session (option A over B)
**Affects:** `shared/replyStart.ts`, `backends/opencodePlugin.ts` (TUI settings), `process-manager.ts` (`sendViewKey`), `renderer/components/TerminalView.tsx`

---

## 2026-10-23 — A finished turn lands on its conclusion; Claude needs its classic renderer

**Decision:** When a turn finishes, its terminal shows the conclusion (the first thing the agent said after its last tool call) from its first line, and the steps stay above it for the builder to scroll to. Shown and at the bottom: at once. Out of sight: once it shows. Scrolled up by the builder: not at all. For Claude Code this works only with its classic renderer (`"tui": "default"`), which the builder sets in their own settings; Multi-Code doesn't set it.

**Why:** Coming back at the chime, the builder scrolled up by hand through hundreds of tool calls to find where the reply began. Claude's fullscreen renderer is the alternate screen and has no command to show a message; its `/focus` hides the steps, which the builder doesn't want.

**Alternatives considered:** a reader overlay built from the transcript (the steps folded away); keeping fullscreen and driving Claude's scroll with wheel input read back from the screen (writes into the session, and a miss when Markdown is drawn differently).

**Consequences:** classic mode flickers. Terminals keep 5,000 lines of scrollback. A jump parks the screen; a message sent from the compose box, the phone or the manager doesn't move it, so a turn ending with the screen still parked jumps again, and the compose box goes to the bottom on send as typing does.

**Source:** builder, 2026-10-23, in session
**Affects:** `shared/replyStart.ts`, `renderer/components/TerminalView.tsx`, `renderer/components/ComposeBox.tsx`, `main/ipc-handlers.ts` (`read-reply-conclusion`)

---

## 2026-10-20 — OpenCode's tabs stay on inside Multi-Code

**Decision:** Multi-Code no longer passes `tabs.mode: "off"` to the OpenCode terminals it starts. Tabs follow the builder's own `cli.json`, or OpenCode's default (`auto`, which is on outside Herdr), as in any terminal. The rest of the 2026-10-16 decision stands; Ctrl+Z stays off.

**Why:** Trying the merged build, the builder missed OpenCode 2's tabs. Multi-Code is an enhanced terminal for the CLIs, so OpenCode should look in it as it does in a terminal. Following the shown session already works with tabs: a tab switch is a route change the TUI plugin reports, and a root nobody holds becomes the contact's.

**Alternatives considered:** keep tabs off (the 2026-10-16 reasons: the sidebar lists sessions, OpenCode's own Herdr precedent). `tabs.scope` has only `cwd` and `global`, so no setting keeps one terminal's tabs to itself.

**Consequences:** measured live on the isolated setup, 2026-10-20. Tabs are shared per directory and live (`tui/tabs.json`): two OpenCode contacts on one project see each other's sessions as tabs, and opening the other's tab shows that session in both terminals. Multi-Code then keeps each contact's own session, but both contacts alert for the shared one. The builder's contacts have no two OpenCode contacts in one directory. Switching tabs works with the mouse; `ctrl+tab` / `ctrl+shift+tab` do nothing in Multi-Code's terminal, which can't send them (xterm.js 5.5, no kitty keyboard protocol).

**Source:** builder, 2026-10-20, in session; docs/specs/opencode-v2/test-plan.md row 1.8
**Affects:** `backends/opencodePlugin.ts` (TUI settings), docs/specs/opencode-v2/prd.md Story 1, CLAUDE.md

---

## 2026-10-20 — OpenCode gets the builder's login-shell environment

**Decision:** Multi-Code reads the builder's login-shell environment once per run (`$SHELL -l -i`, about 1.4 s, cached) and gives it to every OpenCode terminal it starts. When no shared OpenCode service is running, Multi-Code starts it first (`opencode service start`) with that environment minus Multi-Code's own variables (`MULTICODE_*`, `OPENCODE_CLI_CONFIG_CONTENT`), then starts the terminal. Claude's spawns are unchanged.

**Why:** OpenCode 2's shared service keeps the environment of whoever starts it, for every client. Multi-Code opened from the Dock has a bare PATH without nvm, so a service it started couldn't run the builder's `npx`-launched MCP server (`documonster`) in any OpenCode window, VS Code and terminals included, until the service restarted. A service started this way matches one started from a terminal; VS Code resolves the shell environment the same way. The spike also showed that a service started by a Multi-Code terminal carries `MULTICODE_*` into the shells of every client's subagents.

**Alternatives considered:** keep Multi-Code's own environment (no shell rc run, but the MCP failure above).

**Consequences:** if the service dies while a Multi-Code terminal is attached, that terminal restarts it within about 5.5 s with its own environment (OpenCode's behaviour), which is the login-shell one plus Multi-Code's variables. Those are inert outside Multi-Code. The agent's shell in a Multi-Code contact's root session sees `MULTICODE_*`, as a Claude contact's Bash does.

**Source:** builder, 2026-10-20, in session; docs/timeline/2026-10-20_opencode-v2-spike.md, G-604/G-605
**Affects:** `backends/opencode.ts` spawn, docs/specs/opencode-v2/prd.md Stories 1 and 10

---

## 2026-10-20 — A stopped OpenCode contact stays silent

**Decision:** When an OpenCode contact is stopped while its turn still runs in the shared service, Multi-Code raises nothing for that session: no Finished, no Needs-you, no red badge, nothing on the phone or to the secretary. The next start reopens the session, with the result in it.

**Why:** Simplest of the two; alert tracking stays tied to the contact's terminal, as it is for Claude.

**Alternatives considered:** keep alerting for a stopped contact's session (about half a day more: alert state would have to outlive the terminal process).

**Source:** builder, 2026-10-20, in session
**Affects:** docs/specs/opencode-v2/prd.md Story 11; the OpenCode attention logic

---

## 2026-10-16 — OpenCode 2 runs the way its VS Code extension runs it

**Decision:** Multi-Code starts OpenCode 2 as OpenCode's own VS Code extension does: plain `opencode` in a terminal, attached to the user's shared background service. It adds only `--session ses_<id>` (an id Multi-Code picks) and per-process TUI settings through `OPENCODE_CLI_CONFIG_CONTENT`: tabs off, and a report-only TUI plugin that reports which session the TUI is showing. Multi-Code puts nothing into the server: no server plugin, no `OPENCODE_CONFIG_CONTENT`. It reads state from the service's event stream (`GET /api/event`, found through `~/.local/state/opencode/service.json`) and answers permission and question dialogs from the phone and the secretary through the service's API, not keystrokes. Stopping a contact closes its TUI only; a running turn finishes in the service, as it does when a VS Code terminal closes.

**Why:** The builder sees Multi-Code as an enhanced terminal for the CLIs, so OpenCode should behave in it as in any terminal. A plugin in a TUI's env would leak into the shared service whenever that TUI is the one to start it, because the service inherits its starter's whole environment. Tabs are off following OpenCode's own precedent for hosts that manage several terminals (`tabs.mode: auto` turns them off inside Herdr), and because Multi-Code's sidebar already lists the sessions. An API answer names its request by id, so it cannot land in the wrong dialog, which a keystroke can.

**Alternatives considered:** a private `--standalone` server per contact with the ported plugin (closest to V1, but N servers on one database, keystroke answers and no API); one Multi-Code-owned `opencode serve` with every TUI on `--server` (an extra process whose lifetime and environment Multi-Code must manage).

**Consequences:** sessions from VS Code and from Multi-Code share one pool, and `/open` shows each other's. An OpenCode upgrade replaces the service, interrupting running turns, which the new service resumes. A permission left unanswered for 60 minutes gets its turn interrupted (`inactivity`). CLAUDE.md's report-only rule gains one exception when this is built: answering a dialog through the CLI's own API, as the builder would by keypress.

**Source:** builder, 2026-10-16; docs/timeline/2026-10-16_backend-expansion-research.md ("process, session and tab model"); `sdks/vscode/src/extension.ts` in anomalyco/opencode v2.0.29
**Affects:** `backends/opencode*.ts` (spawn, state, transcript), `secretary/dialog.ts`, the phone answer path, CLAUDE.md "Architecture" and "Session monitoring".

---

## 2026-10-16 — OpenCode support moves to 2.x only

**Decision:** Multi-Code supports OpenCode 2.x and drops 1.x. No dual-version support.

**Why:** OpenCode 2 changes every surface Multi-Code uses: the plugin API, event payloads, the database tables, and the TUI's dialogs. Supporting both was feasible for about two more days of work, but every later OpenCode TUI change would then need measuring twice. OpenCode 1.x is at its end: 1.19.0 (2026-10-11) mainly adds the upgrade path to 2, and the two versions cannot be installed side by side. The builder chose one version over a transition window.

**Source:** builder, 2026-10-16; comparison of OpenCode v1.19.0 and v2.0.29 in docs/timeline/2026-10-16_backend-expansion-research.md
**Affects:** `workspace/app/src/main/backends/opencode*.ts`, `secretary/dialog.ts`, the OpenCode quick actions; every OpenCode user of Multi-Code must upgrade to 2.x.

---

## 2026-10-10 — A wider choice is confirmed with a bare yes before the secretary presses it

**Decision:** When the reply interpreter decides the builder wants "don't ask again" on a permission, or "accept edits without asking" on a plan, the secretary presses nothing. It asks a fixed question naming that exact choice, and presses only if the very next reply is a bare yes ("是", "对", "yes", punctuation aside). Any other reply is read afresh. The model never picks keys: it names an effect or option numbers, and `secretary/dialog.ts` turns them into the key sequences measured on the CLI.

**Why:** Four rounds of cross-model review on 2026-10-10 found a way past each version of a check on the builder's own words: keywords ("automation" matched "auto"), then negation lists ("do not use auto mode", curly apostrophes), then a yes followed by a correction ("Yes, only this once"). Widening a permission is the one mistake that outlives the dialog, so it costs one extra "是".

**Source:** docs/timeline/2026-10-10_reply-key-flows-spike.md; review notes in the T-509 entry of docs/specs/voice-secretary/kanban.md
**Affects:** PRD Story 6 (v1.8); `secretary/dialog.ts` (`checkChoice`, `isPlainYes`), `secretary/index.ts` (`reply`).

---

## 2026-10-09 — The shown session's secretary speaks on its own, and briefs are kept

**Decision:** With Secretary Mode on, a new event on the session on screen opens its card and plays the brief without a click. Every other session still waits for its red-dot click. A brief is no longer dropped when its event clears (the builder typed or answered); it stays, marked handled, and the session header's Secretary button brings it back for reading and replay. Briefs are written to ASD-STE100 Simplified Technical English's rules at about 80% strictness.

**Why:** After a day of use, the builder found the session they were watching never briefed them (any key press cleared its red dot, and only a red-dot click opened a card), and a brief they had heard was gone the moment they typed. Limiting unasked speech to the shown session keeps the original point of the pull model: two secretaries never talk at once.

**Supersedes:** part of 2026-10-07, "speaks only when clicked": that still holds for every session except the one on screen.
**Source:** docs/timeline/2026-10-09_secretary-first-day.md
**Affects:** PRD Stories 2, 3 and 4 (v1.7); `secretary/index.ts` (keeps briefs), `App.tsx` and `secretaryBrief.ts` (when a card opens), the brief prompt (v9).

---

## 2026-10-08 — The speech server detects the brief's language itself

**Decision:** The secretary's speech request no longer sends `language`; Qwen3-TTS uses its default, `Auto`, and detects the language from the text. The brief writer still chooses the brief's language (it follows the builder's latest message), and that choice still picks the tone instruction sent with the text.

**Why:** Chinese briefs keep English technical terms ("eat-what 那边……", PR, NPM), and the builder prefers the engine to judge mixed text itself rather than be forced into one language. Kept after the builder listened to 11 real briefs spoken both ways; revisit if a brief is misread.

**Source:** builder, 2026-10-08, in session.
**Affects:** `workspace/app/src/main/secretary/speech.ts`; `docs/specs/voice-secretary/prd.md` Story 4 (v1.4).

---

## 2026-10-07 — Attachments only when the brief can't carry it

**Decision:** Refines "The secretary's card shows originals" below. The secretary attaches original material only when words can't make it clear, or when the builder needs the exact detail to decide. When the brief alone gets it across, the card has the brief and nothing else. Whatever is attached is still an original, never rewritten.

**Why:** The builder doesn't want detail they don't need: "如果你说话就能直接把这事儿差不多说明白了……就不要放".

**Source:** builder, 2026-10-07, reviewing `docs/specs/voice-secretary/prd.md` (Story 5).
**Affects:** Secretary card content.

---

## 2026-10-07 — The secretary's voice runs on a GPU server, deployed only from official components

**Decision:** Qwen3-TTS-12Hz-1.7B-CustomVoice (voice Serena) runs on an EC2 GPU instance, served by vLLM-Omni's published image with its Qwen3-TTS launch command, behind Caddy at `https://tts.jasenpan.com`. It does not run on the user's Mac. The POC lives in the builder's personal AWS account; moving to the company account swaps Caddy for ALB plus ACM and leaves the model server unchanged.

**Why:** Generating locally peaks at 6–7 GB of memory, which no user can be asked to spare. Alibaba Cloud's hosted Qwen API and fal.ai were rejected: the builder doesn't want Alibaba Cloud, and fal.ai would be a different setup from the eventual company deployment. A hand-written Python wrapper was replaced by vLLM-Omni because the builder requires the vendor-recommended deployment, not a shortcut.

**Source:** docs/timeline/2026-10-07_voice-engine-hosting.md
**Affects:** How Multi-Code produces audio for a brief (an HTTPS call with a bearer key); `docs/specs/voice-secretary/gaps.md` G-003 (company code in a personal account).

---

## 2026-10-07 — The voice secretary is per-session and speaks only when clicked

**Decision:** Every session has its own secretary; there is no single secretary watching all sessions. A secretary speaks only when the builder clicks its red-dot contact with Secretary Mode on, never on its own. It briefs at the moments the CLI answers the builder (turn finished, needs-you), never mid-turn.

**Why:** The builder hears the chime, walks over, and chooses which session to hear, the same way they would tap a message notification on a phone. That makes queueing several talking secretaries unnecessary, and keeps the planned phone flow identical. A per-session secretary follows one session end to end, so it can say what was already tried. Auto-speaking and a single all-sessions secretary were both proposed by the interviewer and replaced by the builder.

**Source:** docs/timeline/2026-10-07_voice-secretary-ideation.md
**Affects:** Contact click behaviour while Secretary Mode is on; when briefs are prepared (at the event, so a click plays at once).

---

## 2026-10-07 — The secretary's card shows originals, and answers go through the secretary

**Decision:** Attachments on the secretary's card are chosen by the secretary but are always originals: the exact command, the question and its options, real code with flagged lines highlighted, reviewer comments verbatim. The builder answers in words in the card's own input box, and the secretary turns the answer into the dialog keystroke. The answer never goes into the terminal as text.

**Why:** The spoken brief simplifies, so the card is what the builder checks it against; if the secretary misreads a command, the original on the card shows it. A CLI dialog takes keystrokes, not words, and text written into a session sitting on a dialog has been observed to select the wrong option.

**Source:** docs/timeline/2026-10-07_voice-secretary-ideation.md
**Affects:** Secretary card UI; how a needs-you answer reaches the session (not through the compose box).

---

## 2026-07-09 — Markdown View is a single-file reader, not a document manager

**Decision:** The "View" toolbox section shows one Markdown file at a time. Opening a new path replaces the current one — no tabs, no open-file list. Open-path state is per-instance and follows the selected instance.

**Why:** The core use is glancing at an `.md` an agent just generated, not curating a multi-doc workspace. The right column is narrow; tabs would crowd it against the compact layout. Per-instance state is mandatory because relative paths must resolve against each instance's own cwd — a global "current file" would resolve the wrong directory.

**Source:** 2026-07-09 markdown-view ideation.
**Affects:** View section UI; Toolbox state (a per-instance open-path map alongside `expandedByInstance`).

---

## 2026-07-09 — Markdown View renders `.md`/`.markdown` only

**Decision:** View renders only files with a `.md` or `.markdown` extension. Any other extension (`.txt`, `.json`, no extension, a directory) is refused with a plain inline error, not displayed. Files over ~2MB are also refused.

**Why:** The real trigger is always "an agent produced a Markdown file and returned its path". A plain-text branch (rendering `.txt` as text) was considered and cut — it's effort spent on a case that doesn't occur. The size cap prevents a large log accidentally opened as markdown from freezing the UI. Extension and size are checked in the main process (in the `read-file` handler) so illegal cases never reach the renderer.

**Source:** 2026-07-09 markdown-view ideation.
**Affects:** `read-file` IPC handler validation; View error states.

---

## 2026-07-09 — Markdown View includes math and Mermaid in MVP

**Decision:** MVP rendering is react-markdown + remark-gfm + remark-math + rehype-katex (math) + Mermaid (diagrams). A Mermaid block that fails to render degrades to a plain code block showing its raw definition, and must never crash the document. Raw HTML embedded in markdown is not executed (react-markdown stays on its safe default, no `rehype-raw`).

**Why:** Agent output frequently contains LaTeX math and Mermaid diagrams; rendering plain markdown without them would miss the builder's actual content. KaTeX is a cheap synchronous plugin pair; Mermaid is a heavier async runtime, hence the explicit failure-degradation rule. Disabling raw HTML keeps a markdown file from injecting scripts into the renderer.

**Source:** 2026-07-09 markdown-view ideation.
**Affects:** renderer dependencies (adds react-markdown, remark-gfm, remark-math, rehype-katex, katex, mermaid); View rendering component.
