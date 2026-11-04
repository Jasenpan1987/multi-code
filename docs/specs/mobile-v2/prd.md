# PRD: Mobile v2

**Version:** 1.1
**Last Updated:** 2026-10-30
**Status:** released in 0.10.0 (2026-10-30); approved by the builder 2026-10-29 ("第一个我选方案A 其他的都很好 你先做吧")
**Owner:** Jasen
**Replaces:** `docs/specs/phone-link/prd.md` v1.1

## Overview

A new phone client for Multi-Code, built from scratch. From an iPhone anywhere on the tailnet
the builder sees every session's state, reads what each agent did, replies, answers every
dialog, stops a running turn, and gets a push notification each time a session finishes or
needs them. It is a web app on the Home Screen, served by the Mac over HTTPS.

## Background & Context

`phone-link` v1.1 (2026-07-29) stopped being used. The 2026-10-13 research found the causes:
the PWA can't load when its saved IP address is unreachable (Tailscale was stopped), there is
one text box and no keys, only the first question of a question box is shown and answered with
one digit, and an iPhone PWA on plain `http://` can never receive a push.
(source: `docs/timeline/2026-10-13_mobile-v2-research.md`)

The builder chose a structured conversation as the main view, a PWA over HTTPS from
`tailscale serve` with Web Push from the Mac, a push every time, reply / answer / stop on the
phone, and plan A for the home screen. Secretary and Manager move to phase 2.
(source: `docs/timeline/2026-10-29_mobile-v2-ideation.md`)

The UI is specified by the mockups: `docs/specs/mobile-v2/mockups/index.html`. Where this
PRD and a mockup differ, this PRD wins.

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen | Leaves Claude and OpenCode sessions running on the Mac; checks, answers and steers them from an iPhone (iOS 27, Safari) on the tailnet |

## Terms

- **Needs you:** a session stopped on a dialog (permission, question box, plan), as the
  desktop's alerts report it.
- **Working:** a session in the middle of a turn.
- **Finished:** a session whose turn ended and which the builder has not looked at since.
- **Idle:** any other running session, and stopped ones.
- **Turn:** one message from the builder and everything the agent did until it stopped.

## User Stories

### Story 1: Open the app and reach the Mac

**As a** builder away from my desk
**I want** the phone app to open every time and connect to my Mac over the tailnet
**So that** "it doesn't open" never happens again

**Acceptance Criteria:**
- [ ] The app is served at `https://<machine>.<tailnet>.ts.net` (from `tailscale serve`) and
      works as a Home Screen app (standalone, own icon, own name "Multi-Code").
- [ ] The app opens with no connection at all (Mac asleep, Tailscale off on either side, no
      network): it shows the last content it had and says which side can't be reached.
- [ ] When the Mac is reachable again the app connects by itself, within 3 s of the phone
      being unlocked or the app being shown again.
- [ ] Multi-Code's port accepts connections from this Mac only; the tailnet reaches it only
      through `tailscale serve`.
- [ ] A phone paired with v1 (old `http://<ip>:6768` address) is not migrated; the builder
      re-pairs once. The desktop says so.

### Story 2: See every session at a glance (home, plan A)

**As a** builder holding my phone
**I want** one list of my sessions grouped by state
**So that** I see at once which ones need me

**Acceptance Criteria:**
- [ ] Groups in this order: Needs you, Working, Finished, Idle. Empty groups are not shown.
      Each group header shows its count.
- [ ] Each row: backend mark (Claude / OpenCode), session name as the desktop shows it, state,
      age (how long it has needed me / been working / since it finished), and one line:
      Needs you → what the dialog asks (e.g. `Bash: pnpm test:e2e`, the question text);
      Working → the tool it is on; Finished → the first sentence of its conclusion; Idle →
      the last line it said.
- [ ] The header shows the Mac's name and the connection state.
- [ ] The Manager is not in the list (phase 2).
- [ ] The list updates live while the app is open.
- [ ] Reading is shared: a session read at the desk stops being Finished on the phone,
      and one opened on the phone stops being unread on the desk (red dot, Dock count).
      (v1.1)

### Story 3: Read a session

**As a** builder who opened a session
**I want to** read what I asked and what the agent did, like a chat
**So that** I understand where it is before I answer

**Acceptance Criteria:**
- [ ] My messages are right-aligned bubbles; the agent's text is full width and rendered as
      Markdown (headings, lists, code, tables).
- [ ] In a finished turn, the tool calls and the agent's text between them fold into one line
      ("12 tools · 6 read · 3 edited · 2 commands", plus the turn's duration). The turn's last
      text (its conclusion) is always shown.
- [ ] Tapping the fold line opens it: one line per tool with the action, the target, and a
      result (Edit/Write: lines added and removed; Bash: succeeded or failed; others: done).
- [ ] A Working turn shows its fold open, with lines added as tools run and the running tool
      marked.
- [ ] Opening a session whose last turn finished lands on the start of that turn's conclusion.
- [ ] The last 10 turns load first; "Earlier turns" loads 10 more each time.
- [ ] Works the same for Claude and OpenCode sessions.
- [ ] A slash command and the CLI's own reply to it ("/token · Unknown command: /token")
      show as grey lines, not as messages; a long reply folds. (v1.1)
- [ ] After `/new` or `/clear` the chat starts afresh on the new session, marked "New
      session". (v1.1)

### Story 4: Reply

**As a** builder
**I want to** type a reply on my phone, in Chinese or English, and know it arrived
**So that** I can steer the agent without walking back

**Acceptance Criteria:**
- [ ] One compose box at the bottom. Only the Send button sends; Return makes a new line, so
      a Chinese IME's Return never sends. The keyboard's dictation works in it.
- [ ] A sent message shows as my bubble at once, marked until the Mac confirms it arrived.
- [ ] While the session is Working the message is still sent (the CLI queues it) and the box
      says so ("Queued until this turn ends").
- [ ] While a dialog is open there is no compose box (Story 5 replaces it), and the Mac
      refuses a message sent anyway, so text never lands in a dialog.
- [ ] A message sent with no connection waits on the phone ("Waiting to send"), can be
      cancelled, and is sent once on reconnect. The Mac never sends the same message twice.
- [ ] A message the Mac refused says why and keeps its text.
- [ ] The draft survives the app being closed.
- [ ] With the keyboard up, the latest messages stay visible right above the compose
      box; iOS doesn't push them out of view. (v1.1)

### Story 5: Answer every dialog

**As a** builder whose session needs me
**I want to** answer the dialog fully from the phone
**So that** the agent never waits for me to get home

**Acceptance Criteria:**
- [ ] Permission (Claude: Yes / Yes, and don't ask again… / No, and tell Claude what to do
      differently; OpenCode: Allow once / Always allow / Reject): a card in place of the
      compose box with the tool, its command or file, the CLI's description, and one button
      per option with the CLI's exact label.
- [ ] "No…" (Claude) and "Reject" (OpenCode) open a field for a reason, sent with the denial.
- [ ] Question box (AskUserQuestion, OpenCode `question`): every question, one page each;
      single choice as radio buttons, multiple choice as check boxes, a "Type something" row
      where the CLI has one; answered questions fold above and can be edited; one "Submit
      answers" sends all of them.
- [ ] Plan (ExitPlanMode): the plan in full as Markdown, scrollable, and the CLI's three
      options; "No, tell Claude what to change" opens a field for what to change.
- [ ] "Always allow" / "don't ask again" and "auto-accept edits" ask "Are you sure?" first.
- [ ] An answer for a dialog that has gone (answered at the desk, or replaced by a newer one)
      is refused by the Mac and the phone says so; nothing is pressed in the new dialog.
- [ ] The card disappears when the dialog is answered from either side.
- [ ] A dialog the phone can't show (an MCP form, a box the desktop can't answer) says to use
      the terminal and offers it.
- [ ] Dialogs can't be answered with no connection.

### Story 6: Stop a running turn

**As a** builder who sees an agent going the wrong way
**I want to** stop its current turn from the phone
**So that** it doesn't keep doing damage until I'm back

**Acceptance Criteria:**
- [ ] While a session is Working, a bar above the compose box shows the running tool and how
      long the turn has run, and a Stop button.
- [ ] Stop asks "Stop this turn?" first, then does what the Esc key does at the desk: it ends
      the turn, the session stays running.
- [ ] Stop is not offered while a dialog is open (Esc would answer the dialog).

### Story 7: Be told

**As a** builder with the phone in my pocket
**I want** a notification every time a session finishes or needs me
**So that** I know without opening the app

**Acceptance Criteria:**
- [ ] A push for every Finished and every Needs you, from every session but the Manager,
      whether or not the builder is at the desk; delivered with the app closed and the phone
      locked.
- [ ] Title: session name and state. Body: Needs you → what the dialog asks; Finished → the
      first sentence of the conclusion.
- [ ] Tapping it opens that session.
- [ ] A newer push for a session replaces its older one.
- [ ] The Home Screen icon's badge is the number of sessions that need me.
- [ ] No push to a phone that has the app open and connected at that moment (it shows the
      change itself).
- [ ] Turning notifications on is one tap in the app, and works only from the Home Screen
      icon; the app says so when opened in Safari.
- [ ] The desktop can send a test push to each phone.

### Story 8: Terminal fallback

**As a** builder facing something the chat can't show
**I want** the real terminal with the keys I need
**So that** I am never stuck

**Acceptance Criteria:**
- [ ] One tap from the session header opens its terminal, at the Mac's width; it scrolls
      sideways instead of reflowing.
- [ ] A key row: Esc, Tab, Shift+Tab, ↑ ↓ ← →, Space, Return, Ctrl+C. Tapping a key does not
      close the keyboard.
- [ ] A line that sends typed text into the terminal as typed, with no Return added.
- [ ] One tap goes back to the chat.

### Story 9: Desktop: set up and manage phones

**As a** builder at the desk
**I want** the Phone settings to tell me exactly what is missing and to manage my phones
**So that** setup works the first time and a lost phone is cut off at once

**Acceptance Criteria:**
- [ ] Three checks, each with what it means and how to fix it: Tailscale running (button:
      open Tailscale); HTTPS (the tailnet's HTTPS Certificates enabled: link to the admin
      console; `tailscale serve` set up for Multi-Code: a button that runs it, showing the
      command); push ready.
- [ ] The pairing QR shows only when every check passes.
- [ ] Each paired phone: its name, when it was last seen, whether push is on, "Send test" and
      "Revoke".
- [ ] Revoking a phone disconnects it at once, refuses its token after, and stops its pushes.

### Story 10: First setup on the phone

**As a** builder pairing a phone
**I want** three clear steps
**So that** I don't miss the one that makes notifications work

**Acceptance Criteria:**
- [ ] Steps: paired (from the QR), add to Home Screen (how, with Safari's Share button), turn
      on notifications (only from the Home Screen icon).
- [ ] The app shows which step is done and which is next.

## Non-Functional Requirements

- **Performance:** the list shows within 1 s of the app opening when the Mac is reachable
  (cached content at once otherwise). A push is sent within 5 s of the event.
- **Security:** reachable only inside the tailnet, through HTTPS; Multi-Code's port binds to
  this Mac only. Every phone has its own revocable token; the phone pins the desktop's key.
  Push contents are encrypted end to end to the phone (Web Push encryption); Apple's push
  service sees ciphertext. Keys and tokens are files at 0600 in `userData`.
- **Compatibility:** iOS 27 Safari, Home Screen (standalone). Desktop Safari and Chrome work
  for development.
- **Accessibility:** touch targets at least 44 pt; text follows the system's dark or light
  setting.

## Technical Constraints

- The Mac stays the server and holds all state; the phone holds only a cache and its outbox.
- No relay or cloud service of ours. Push goes from the Mac straight to Apple's Web Push
  service.
- Dialogs are answered with the secretary's measured key flows (Claude) and OpenCode's API
  (OpenCode), the same path the secretary uses; the phone never knows a key binding.
- Report-only hooks and plugins stay as they are (CLAUDE.md "Architecture").

## Dependencies

- Tailscale on the Mac and the iPhone, MagicDNS (on), HTTPS Certificates enabled in the
  tailnet's admin console (the builder agreed, 2026-10-29).
- Outbound HTTPS from the Mac to Apple's Web Push service.

## Out of Scope

- Secretary (briefs, audio, replies in words) and Manager on the phone (phase 2).
- A native iOS app; answering from the lock screen; Time Sensitive; Live Activities.
- Starting, stopping, creating or renaming sessions from the phone.
- Full tool output and diffs on the phone.
- Images or files sent from the phone.
- Reaching the Mac without Tailscale (LAN-only use), and any relay.
- More than one Mac.

## Open Questions

Full tracking: `docs/specs/mobile-v2/gaps.md`. None blocks the design; each is measured
during the work:
- G-301: does a WebSocket through `tailscale serve` stay up on iOS?
- G-302: does Web Push from the Mac reach the builder's iPhone?
- G-303: which keys stop an OpenCode 2 turn?
- G-304: does a session read at the desk stop being Finished on the phone?

## Success Metrics

- The builder answers every dialog type, on both backends, from the phone, without the
  terminal.
- Every Finished and Needs you reaches the locked phone as a push.
- Over the two-week trial after release, the app opens to content or a clear reason every
  time.

## Changelog

- v1.1 (2026-10-30): Released in 0.10.0. Added the criteria the builder's iPhone test
  turned up: shared reading (Story 2, G-304, G-321), slash commands and a new session
  (Story 3, G-322, G-323), the chat above the keyboard (Story 4, G-324).
