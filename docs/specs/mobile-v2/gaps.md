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
| G-304 | Does a session read at the desk stop being Finished on the phone? | Not yet: only the unread total reaches main (`set-dock-badge`). T-812 adds an `instance-acknowledged(id)` IPC from the renderer's `markRead`. | 2026-10-29 T-803 |
| G-319 | iOS Simulator for testing? | No Xcode; the builder chose not to install it. Playwright WebKit at iPhone size, then the builder's iPhone for the iOS-only parts. | 2026-10-29 builder |

## Open Gaps

| ID | Question | Impacts | Ask | Status |
|----|----------|---------|-----|--------|
| G-302 | Does Web Push sent from the Mac (VAPID, `web-push`) reach the builder's iPhone, closed and locked? | Story 7 | Measure on the iPhone at QA (no simulator) | open |
| G-305 | In standalone mode on iOS 27, does the key row stay above the keyboard (WebKit 322900: `visualViewport.height` ~68 px short after the first keyboard)? | Stories 4, 8 | Check on the iPhone at QA | open |
| G-306 | Does a pairing made in Safari (from the QR) reach the Home Screen app, or does the Home Screen app have its own storage? | Stories 1, 10 | Measure on the iPhone at QA; the copy/paste hand-off (T-811, T-812) works either way | open |
