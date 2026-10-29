# 2026-10-13 — Mobile app v2 research

**Type:** investigation (read code and measured the running app, no code changed)
**Participants:** Builder (Jasen), AI
**Epic:** `mobile-app-v2` (proposed; branch `mobile-app-v2`)

## Summary

The builder is unhappy with the phone link from `phone-link` v1.1 (2026-07-29) and reports
that the phone no longer opens it. Their pain points: they can't type, can't pick an option
when the agent asks, and get no signal when an agent finishes. They asked whether the cause
is Tailscale (and whether to run a real server instead), whether a native app would do better
than the PWA, and how the Manager and Voice Secretary could be used from a phone. The phone
is an iPhone.

Conclusion: the typing and option problems come from our own code, not from Tailscale or the
web platform. "Doesn't open" is a reachability problem: Tailscale is stopped on the desktop
and the PWA has no way to load when its saved IP address is unreachable. "No signal" is a
platform limit: an iPhone PWA on plain `http://<ip>` can never receive a push. Both reference
projects (Orca, Happy) ship native Expo / React Native apps.

## Current state, measured on the builder's desktop

- Port 6768 is listening (installed 0.8.2). `GET /` and `GET /bundle.js` return 200 on
  `127.0.0.1` and on the LAN address `192.168.0.114`.
- `tailscale status`: `Tailscale is stopped.` The desktop has no `100.64/10` address, so a
  pairing made now carries only the LAN address (and a corporate VPN tunnel, `utun6`,
  `10.128.4.37`, which `endpoints.ts` correctly orders last).
- `remote-devices.json` holds one device: `New device`, paired 2026-08-04, `lastSeenAt` 0. No
  phone has authenticated against the current device list since then.

## Findings in our code

**Doesn't open.** The QR opens `http://<ip>:6768/#<offer>` and the PWA is saved with that
origin. There is no service worker and no offline shell, so when the saved address is
unreachable (Tailscale off, phone off the home Wi-Fi, DHCP changed the LAN address) Safari
can't load the page at all. When it does load, the stored endpoint list is the one from
pairing time and is never refreshed.

**Typing.** `renderer-mobile/App.tsx` has one textarea that sends the whole text as
`sendPrompt` (bracketed paste + `\r`, `process-manager.ts` `sendPrompt`). The terminal is
`disableStdin: true`. There is no Esc, Tab, Shift+Tab, arrows or Ctrl-C, and no handling of
IME composition. `sendPrompt` is not gated, so text typed while a dialog is up lands in the
dialog (see the plan-approval hazard measured 2026-09-02).

**Options.** Detection is fine: it comes from the Claude `PermissionRequest` hook
(`backends/claudeHooks.ts` → `remote/promptExtract.ts`). Answering is stale. The phone shows
only the first question of an `AskUserQuestion`, appends an `Other` row, and sends one
digit. The CLI on 2.1.295 shows "Type something." and "Chat about this" rows, toggles
multi-select with digits, and ends multi-question boxes on a "Submit answers" page
(`docs/timeline/2026-10-10_reply-key-flows-spike.md`). After the first tap the CLI moves on
and the phone still shows question 1. `secretary/dialog.ts` already implements the measured
key flows; the phone doesn't use it.

**No signal.** The only signal is `navigator.vibrate`, while the page is open. iOS Safari has
no Vibration API. Web Push needs a secure context (HTTPS) and a home-screen install; the PWA
is served on plain HTTP, so it can't register a service worker push at all.

**Coming back after a lock or close.** After a successful reconnect the phone does get the
latest state: on `connected` it re-subscribes, and the desktop re-reads the session file and
sends the last 40 transcript entries, the terminal tail and any open prompt. Three things
make it look stuck instead. (1) No heartbeat: the client never sends the protocol's `ping`
and handles neither `visibilitychange` nor `pageshow`, so a half-open socket shows
"Connected" and delivers nothing (Orca #5049 is the same failure). (2) On resume iOS can hang
`new WebSocket()` to a LAN IP in CONNECTING (WebKit 308073); the 6 s handshake timeout only
retries, it never reloads. (3) `RemoteTransport.send` returns silently when the socket isn't
open: a reply sent during the gap is dropped with no ack, retry or error. Also, after the
app is killed it opens on the list, not the session, and the draft is lost.

**Smaller defects.** `TerminalPane.tsx` disposes the terminal when it's collapsed (the effect
cleanup runs on every `visible` change), contrary to its "kept mounted" comment.

## Official Claude Code Remote Control

`claude --remote-control` / `/remote-control` gives a structured chat, buttons and push in
the Claude iOS app. It needs a claude.ai login (Pro/Max/Team/Enterprise) and is **not
available on Bedrock**, Vertex, Foundry or a custom `ANTHROPIC_BASE_URL`. The builder's work
sessions use Bedrock, so it is out. The transcript is stored on Anthropic's servers.
Sources: code.claude.com/docs/en/remote-control.md, code.claude.com/docs/en/mobile.md.

## Orca (stablyai/orca at f8daed0, 2026-10-12)

Corrects the 2026-09 notes: shipped builds are a full Expo 55 / React Native 0.83 app with
native screens. The WebView shell that pulls a bundle from the desktop is an opt-in flavour
(`EXPO_PUBLIC_MOBILE_SHELL=ota`). The terminal protocol has 18 opcodes (`InputAck` added).
`docs/reference/remote-wire-compatibility.md` no longer exists.

- **Input.** xterm (in a WebView) is display-only. A native dock
  (`mobile/src/session/MobileSessionCommandDock.tsx`) owns input. "Live" mode diffs a hidden
  TextInput and sends `\x7f` × n + new text; "buffered" mode writes the text, waits ≥ 500 ms,
  then `\r` (`src/shared/agent-prompt-injection.ts`). iOS IME: a React Native patch exposes
  `isComposing` (marked text) and composing text is held back. Accessory row: Esc, Tab,
  Shift+Tab, arrows, Del, Ctrl+C/D/L/Z/R/A/E/W/U. The keyboard moves the dock up instead of
  resizing the PTY.
- **Options, PTY lane.** Report-only hooks (`PreToolUse` / `PermissionRequest`) detect the
  prompt, as ours do. Answers are keystrokes: accept `1` (OpenCode `\r`), deny Esc,
  AskUserQuestion digits, multi-select ends with `\x1b[C` then `\r`, steps 1000 ms apart
  (`native-chat-answer-stepping.ts`). Lesson (STA-1860): pasting a label into Claude's
  selector always picked option 1; Enter in the same write as a navigation key commits early.
- **Options, structured lane (experimental).** No PTY: `@anthropic-ai/claude-agent-sdk` with
  `canUseTool`; OpenCode over ACP.
- **Push.** The phone sends its APNs/FCM token to the desktop over the E2EE socket; the
  desktop calls Orca's hosted gateway `push.onorca.dev` (title and body in plaintext).
  Triggers are the Claude hooks Stop / StopFailure / PermissionRequest / AskUserQuestion.
  Optional "only when desktop away" (locked or idle ≥ 180 s). Before this, notifications rode
  the socket and were lost in background (issues #8129, #14116).
- **Connectivity.** LAN and Tailscale need no account. The relay is a blind splice forwarder,
  raced 2.5 s after the direct path; it needs an Orca Cloud entitlement.
- **Voice.** Native PCM dictation, transcribed on the desktop (sherpa-onnx, or OpenAI). No TTS.
  No mobile manager chat.
- **Pitfalls worth copying fixes for.** #5049: background or Tailscale left sockets half-open,
  sends vanished; fixed with an AppState/network nudge and a probe after 20 s idle (8 s
  timeout). #5106: accessory keys dismissed the keyboard. #7925: rewriting a TextInput value
  from JS kills iOS dictation. #16995: tapping a notification locked the composer.

## Happy (slopus/happy monorepo at 99f415f, 2026-10-11)

- Expo 55 / React Native 0.83 on the App Store and Play, plus a web build.
- No PTY. Local mode runs the real `claude` TUI and tails the JSONL; remote mode runs the
  Agent SDK `query()` with `canUseTool`. A phone message kills the local TUI and resumes the
  session in SDK mode. OpenCode over ACP (`opencode acp`).
- Structured chat on the phone, per-tool views (diff, bash, todos, plan, AskUserQuestion).
  Permissions answered by RPC into the pending `canUseTool` promise; AskUserQuestion as allow
  with `updatedInput: {answers}`.
- Push through its own server and Expo push, suppressed while the app is active.
- Voice: ElevenLabs realtime agent over LiveKit with tools `sendMessageToSession` and
  `processPermissionRequest`, i.e. a voice manager. Paid beyond 20 min / 30 days.
- Everything goes through the server (encrypted blobs, self-hostable). No LAN-only mode
  (issue #101 open).
- Most bugs are in local↔remote mode switching (#1148, #1189, #1217), plus Chinese input
  corruption (#1364) and a text reply aborting a pending permission (#1735).

## Others

- CloudCLI (siteboon/claudecodeui): self-hosted PWA, Agent SDK chat plus a node-pty shell
  tab, real Web Push (VAPID, `web-push`, service worker), so a PWA can push without a vendor
  relay once it is on HTTPS.
- OpenCode's own web UI (`packages/app`) is a PWA with no Web Push found (unverified).

## Implications for v2

1. Typing and options are fixable in our PTY-plus-hooks design, the same lane Orca ships.
   The SDK lane both projects use conflicts with "No SDK" in CLAUDE.md, and Happy's
   mode-switch bugs show its cost.
2. Push on iPhone needs either a native app with the APNs entitlement (paid Apple developer
   account; the desktop can call APNs directly with a `.p8` key, no server of ours) or a PWA
   on HTTPS with Web Push. Free provisioning has no push capability and expires in 7 days.
3. A relay server solves reachability when Tailscale can't run. It solves neither typing nor
   options.
4. The secretary already turns a Finished / Needs-you event into a brief, audio and a
   reply-in-words answer; `docs/knowledge/decisions.md` says the phone flow was planned to
   match it.

## Round 2: can the web client do it?

The builder is fine with Tailscale on both devices and asked whether the PWA can solve the
pain points before anyone builds a native app. Current release is iOS 27 (Safari 27.0,
2026-09-17). The desktop runs the Standalone Tailscale build (`io.tailscale.ipn.macsys`,
1.98.9), so `tailscale serve` and `tailscale cert` are both available.

**The enabler is HTTPS.** Service worker, Web Push and the microphone all need a secure
context. `tailscale serve --bg 6768` gives `https://<machine>.<tailnet>.ts.net` on 443,
proxied to `http://127.0.0.1:6768`, reachable only inside the tailnet, persists across
reboots and renews its own certificate (kb/1242). It needs MagicDNS and "HTTPS
Certificates" enabled in the admin console, which publishes `<machine>.<tailnet>.ts.net` to
public Certificate Transparency logs, irreversibly (kb/1153). WebSocket goes through Go's
`httputil.ReverseProxy`; open issues #20882 (upgrade lost over HTTP/2) and #18827 (drops
every 10–40 s on 1.94.2) mean it must be tested from Safari on the phone. Fallback:
`tailscale cert` and serve TLS from Multi-Code itself (90-day certs, renewal is ours).

**Web Push on iOS** (webkit.org/blog/13878, Apple "Sending web push notifications"):

- iOS 16.4+, Home Screen app only, standalone manifest, permission asked from a tap. No
  Apple developer account. Delivered with the app closed and the phone locked, system sound,
  app badge via `setAppBadge`.
- The Mac sends it directly with `web-push` (VAPID) to `web.push.apple.com`, outbound HTTPS
  only. VAPID `subject` must not be `.local` / `@localhost` (claudecodeui #1550 failed
  silently on that); `https://<fqdn>` works. Payload ≤ 4 KB. Delete the subscription on
  404/410, log 403.
- Every push must show a notification or Safari revokes permission. Use Declarative Web Push
  (iOS 18.4+), which has a built-in fallback. Subscriptions can be lost silently and
  `pushsubscriptionchange` never fires, so call `getSubscription()` and re-register on every
  launch.
- Not available to the web: notification action buttons, a reply field in the notification,
  Time Sensitive (the user can still let the app through Focus), Live Activities.

**Audio.** `<audio>` started by a tap keeps playing on the lock screen in standalone mode
since iOS 15.4. Web Audio stops in background, so use one reused `<audio>` element.

**Voice input.** The keyboard's dictation mic works in a normal `<textarea>`; it's the
reliable path. `webkitSpeechRecognition` is not available in Home Screen apps, and on iOS
27 it stops after an `<audio>` element plays. `getUserMedia` works but re-prompts on every
launch.

**Keyboard.** No VirtualKeyboard API and no `interactive-widget` on iOS. A key row can be
pinned with `visualViewport`, but in standalone mode on iOS 27 `visualViewport.height`
stays ~68 px short after the first keyboard (WebKit 322900). Chinese IME: the commit Enter
arrives with `isComposing === false`, so send with a button, not Enter; don't rewrite a
textarea's value during composition (WebKit 255857).

**WebSocket.** Closed (1006) after ~10 s in background; on resume `new WebSocket()` can hang
in CONNECTING when dialled to a LAN IP, a hostname helped (WebKit 308073). Close on
`visibilitychange` hidden, reopen on visible / `pageshow`, reload after ~5 s, and replay
missed events from the desktop.

**Verdict.** The web client covers all three pain points: options fully (our bug), typing
mostly (our bug plus keyboard workarounds), notifications mostly (no answering from the lock
screen). It also covers the secretary's text and audio and voice replies through keyboard
dictation. Native-only: answering from a notification, Time Sensitive, Live Activities,
in-app speech recognition.

**Gotchas.** The origin moves from `http://<ip>:6768` to `https://<fqdn>`, so the phone
re-adds the app and re-pairs once. VAPID keys are generated once and kept at 0600 in
userData. A sleeping Mac sends nothing. Once serve is the path, bind 6768 to `127.0.0.1`
instead of `0.0.0.0`.
