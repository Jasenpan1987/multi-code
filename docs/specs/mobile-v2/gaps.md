# Mobile v2 Epic — Gaps

Raised in the 2026-10-29 ideation (`docs/timeline/2026-10-29_mobile-v2-ideation.md`) and the
2026-10-13 research (`docs/timeline/2026-10-13_mobile-v2-research.md`).

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-310 | Structured conversation or terminal first? | Structured conversation; terminal as the fallback. | 2026-10-29 builder |
| G-311 | PWA or native iOS app? | PWA over HTTPS from `tailscale serve`, Web Push from the Mac. | 2026-10-29 builder |
| G-312 | May the tailnet's HTTPS Certificates be enabled (machine name in public CT logs)? | Yes. Tailnet `jasenpan@gmail.com`, machine `jasenpanmacbook-air.taile5fb0f.ts.net`. | 2026-10-29 builder |
| G-313 | When does the phone get a push? | Every Finished and Needs you, whether or not the builder is at the desk. | 2026-10-29 builder |
| G-314 | How are tool calls shown? | Folded into one line per turn; tapped open, one line per tool. | 2026-10-29 builder |
| G-315 | What can the phone do to a session? | Reply, answer dialogs, stop a running turn. Start / stop / create stay on the desktop. | 2026-10-29 builder |
| G-316 | Secretary and Manager in phase 1? | No, phase 2. | 2026-10-29 builder |
| G-317 | Home screen: session list (A) or to-do cards (B)? | A. | 2026-10-29 builder |
| G-318 | Reuse the 2026-10-13 worktree? | No. New branch from master; the old diff is reference only. | 2026-10-29 builder |
| G-301 | Does a WebSocket through `tailscale serve` stay up? | Yes, on Tailscale 1.104.4 (Mac), probe in `.omt/probes/mobile-v2/ws-serve-probe/` behind `tailscale serve --https=8443`: Node client 10 min, 39/39 pongs, max RTT 5 ms, 0 drops; Playwright WebKit 10 min, 39/39, max 7 ms, 0 drops; the builder's iPhone (Safari, over the tailnet) 4 min visible, 15/15, max 23 ms, 0 drops, upgrade over HTTP/1.1. iOS closed the socket (1006) 31 s after the page went hidden, as expected; the app reconnects on visible (T-806). The 10-minute Home Screen run stays in the QA plan. | 2026-10-29 measured |
| G-303 | Which keys stop a running OpenCode 2 turn? | Two Escs 250 ms apart (OpenCode 2.0.32 `session.interrupt` = escape; two presses within 5 s call the interrupt API, for the session the prompt shows, while it runs). Multi-Code refuses Stop unless the terminal shows the running session. From source and the 2026-10-20 spike fixture; not driven live (the builder's shared service). | 2026-10-29 T-803 |
| G-304 | Does a session read at the desk stop being Finished on the phone? | Yes since T-812: the renderer's `markRead` sends `instance-acknowledged(id)` when it cleared an alert, and main calls `markSeen`; measured end to end (a click at the desk turned the phone's row Idle within the second). Measured again at QA with a real Claude turn: Idle on the phone 43 ms after the click (`qa-report-m1.md`). | 2026-10-29 T-803, T-812, T-813 |
| G-320 | How soon after a dialog opens does Claude Code take an answer's keys? (found at QA) | Not at once for a plan: on 2.1.312 an ExitPlanMode approve written 40 or 100 ms after its PermissionRequest hook was dropped (5 of 5), one at 250 ms was taken; a permission took a key at 0–100 ms (7 of 7). Since the first key clears the needs-you event, a dropped key left phone and desk showing Idle over a waiting dialog. `answerDialog` now waits until the dialog is 500 ms old (`dialogSettleMs`); after the fix every fast answer was taken (`qa-report-m1.md` Bug 1). | 2026-10-29 T-813 measured |
| G-319 | iOS Simulator for testing? | No Xcode; the builder chose not to install it. Playwright WebKit at iPhone size, then the builder's iPhone for the iOS-only parts. | 2026-10-29 builder |

## Open Gaps

| ID | Question | Impacts | Ask | Status |
|----|----------|---------|-----|--------|
| G-301 (rest) | Does the Home Screen app itself hold its socket through `tailscale serve` for 10 minutes, and reconnect within 3 s of each unlock? | Story 1 | The probe and WebKit are stable (above); the app reconnected in WebKit within 0.6 s of a drop and 34 ms of being shown at QA. Run on the iPhone: `test-plan-iphone.md` §8, §9 | open |
| G-302 | Does Web Push sent from the Mac (VAPID, `web-push`) reach the builder's iPhone, closed and locked? | Story 7 | Payloads checked at QA against a fake push service (decrypted: titles, bodies, `navigate`, `tag`, badge, Topic, sent 31 ms after the event); Apple's leg and the device: `test-plan-iphone.md` §6, §10, §11 | open |
| G-305 | In standalone mode on iOS 27, does the key row stay above the keyboard (WebKit 322900: `visualViewport.height` ~68 px short after the first keyboard)? | Stories 4, 8 | The key row keeps the line's focus in WebKit (QA); the real keyboard: `test-plan-iphone.md` §3, §5 | open |
| G-306 | Does a pairing made in Safari (from the QR) reach the Home Screen app, or does the Home Screen app have its own storage? | Stories 1, 10 | Measure on the iPhone: `test-plan-iphone.md` §1; the copy/paste hand-off (T-811, T-812) works either way, checked in WebKit with the clipboard stubbed | open |
