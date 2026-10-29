# Mobile v2 — ideation

**Date:** 2026-10-29
**Type:** ideation
**Participants:** Jasen (builder), Claude
**Source:** (verbal), the 2026-10-13 research (`docs/timeline/2026-10-13_mobile-v2-research.md`),
HTML mockups (`docs/specs/mobile-v2/mockups/index.html`)
**Outcome:** new epic `docs/specs/mobile-v2/`, replacing `phone-link` v1.1

## The ask

The builder wants to fix the phone client, and more than fix it: redesign it from scratch.
The pain points from 2026-10-13 still stand: the phone doesn't open, typing doesn't work,
options can't be picked (only the first question of a question box, one digit), and nothing
tells the builder that a session finished or needs them.

The 2026-10-13 attempt (branch `mobile-app-v2`, worktree `../multi-code-mobile-app-v2`) left
about 1,200 uncommitted lines on 0.8.2, 76 commits behind master. It is reference only.

## Measured today

- `tailscale status --json` on the desktop: `BackendState: Stopped`, `MagicDNSSuffix:
  taile5fb0f.ts.net`, tailnet `jasenpan@gmail.com` (the builder's personal account), MagicDNS
  on, `CertDomains: null` (HTTPS certificates not enabled yet). Self is
  `jasenpanmacbook-air.taile5fb0f.ts.net`, `100.103.73.2`. One peer: an iOS device, offline.
  A stopped Tailscale is the direct cause of "the phone doesn't open".
- No Xcode on this Mac (`xcode-select -p` → `/Library/Developer/CommandLineTools`), so no iOS
  Simulator. Playwright's WebKit is in the local cache.

## Key decisions

- **The main view is a structured conversation.** A session list, a chat per session, dialogs
  as buttons. The terminal stays as the fallback. A terminal-first design was offered and not
  chosen. — builder
- **A web app (PWA), not a native iOS app.** HTTPS comes from `tailscale serve`, and the Mac
  sends Web Push itself. No Apple developer account. Answering from the lock screen and Live
  Activities are given up. — builder
- **The builder enables HTTPS Certificates on the tailnet.** The machine name goes into the
  public Certificate Transparency logs, irreversibly; only tailnet devices can reach it. —
  builder
- **A new branch from master; the old worktree is reference only.** It stays on disk. —
  builder
- **Secretary and Manager on the phone are phase 2.** Phase 1 solves opening, typing,
  answering and being told. The protocol leaves room. — builder
- **A push every time a session finishes or needs the builder**, whether or not the builder
  is at the desk. "Only when the desktop is idle or locked" was offered and not chosen. —
  builder
- **Tool calls fold into one line per turn**, tapped open for one line per tool. One line per
  tool, always shown, was offered and not chosen. — builder
- **The phone can reply, answer dialogs and stop a running turn.** Starting, stopping and
  creating sessions stays on the desktop. — builder
- **Home screen: plan A, the session list grouped by state.** Plan B (to-do cards with inline
  answer buttons) was offered and not chosen; A always shows the context before an answer. —
  builder
- **Every other mockup screen accepted as drawn** ("其他的都很好"), including the calls Claude
  made in them: the compose box is replaced by the answer card while a dialog is open; Stop
  and "auto-accept edits" are confirmed first; messages typed offline queue and send on
  reconnect, but dialogs can't be answered offline; tool output and diffs are out of phase 1;
  a newer push for a session replaces the older one; the icon badge counts Needs-you
  sessions; the desktop shows the pairing QR only when every check passes. — builder
- **Testing without a simulator.** The builder chose not to install Xcode. Daily testing uses
  Playwright WebKit at iPhone size; the iOS-only parts (Home Screen, keyboard, push) are
  checked on the builder's iPhone at the end. — builder

## Mockups

`docs/specs/mobile-v2/mockups/index.html`: 13 screens in 5 groups (home A/B, session,
dialogs, terminal and states, first setup). Plan A of group 1 is the chosen home screen.
