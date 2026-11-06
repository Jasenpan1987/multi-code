# PRD: Secretary Bar

**Version:** 1.1
**Last Updated:** 2026-11-06
**Status:** approved (builder, 2026-11-06: "就先这么做吧……你赶紧做吧", with the one-bar redesign)
**Owner:** Jasen

## Overview

One secretary for the whole app, on the desktop and on the phone. While Secretary Mode is on,
a bar across the top of the app shows the secretary's state and what it says, one brief at a
time, named by its session ("Shop · Secretary"). A tap on Play reads it out and says what to
do. The builder hears every session from that one place and never has to switch between
projects to hear them. The per-session card on the desktop goes. The Mac still writes every
brief and its audio once; desk and phone show and play what it prepared.

## Background & Context

- **The secretary was left for phase 2 of the phone app** (mobile-v2 G-316). The Manager is
  retired (2026-11-01), so the secretary is what is left.
  (source: `docs/timeline/2026-10-29_mobile-v2-ideation.md`)
- **The builder wants one secretary, not one per session.** "整个 UI 里只有一个小助手……不想像现在
  这样放在每个 session 里头，包括电脑端我觉得也挺不好的." Today's desktop card sits over the
  terminal of one session, and opens when that session is on screen, when its red dot is
  clicked, or from its header's Secretary button (`renderer/components/secretaryBrief.ts`).
  To hear another session the builder must switch to it.
  (source: `docs/timeline/2026-11-06_secretary-bar-ideation.md`)
- **Both halves exist.** The desktop secretary writes briefs, speaks them and answers dialogs
  in words (`docs/specs/voice-secretary/prd.md` v2.1). The phone app answers dialogs through
  the secretary's own key flows and OpenCode's API, and sends a push for every Finished and
  Needs you (`docs/specs/mobile-v2/prd.md` v1.1). The phone shows no briefs today.
- **iOS limits what a web app can do with sound.** A Web Push notification plays the system
  sound only, and a web page needs a tap before it can play audio. Whether audio keeps
  playing once the phone locks is not measured yet (G-802).

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen | Turns the secretary on from the desk or the phone, steps away, reads the push, taps Play on the bar, answers in words or with buttons, from the desk or an iPhone (iOS 27, Home Screen app) |

## Terms

- **Brief, Secretary Mode, speech server:** as in `docs/specs/voice-secretary/prd.md`,
  Definitions.
- **Needs you, Finished, turn:** as in `docs/specs/mobile-v2/prd.md`, Terms.
- **The bar:** the secretary's strip across the top of the app, on the desktop and the phone.
- **Waiting brief:** a brief the builder hasn't dealt with: a Needs you whose dialog is still
  open, or a Finished whose session hasn't been read.
- **Replyable:** a Needs-you brief whose dialog the secretary can answer in words (desktop
  Story 6 says which ones).

## User Stories

### Story 1: One secretary at the top of the app

**As a** builder with several sessions running
**I want** one secretary at the top of the app, not one inside each session
**So that** I hear every project from one place without switching between them

**Acceptance Criteria:**
- [ ] While Secretary Mode is on, the desktop window has the bar across its full width, above
      the sidebar and the terminal. It is always there while the mode is on, whichever
      session is selected.
- [ ] While Secretary Mode is on, the phone app has the bar at the top of every screen: the
      list, a session, its terminal.
- [ ] With the mode off there is no bar, on either side, and nothing else changes.
- [ ] The bar shows one brief at a time: its session's name as the title ("Shop ·
      Secretary"), the secretary's state, and what it says.
- [ ] States shown: writing the brief, the voice on its way, ready, playing, voice
      unavailable with the reason, no brief could be written with the reason, and nothing new.
- [ ] Desktop: the bar shows the brief's text, up to three lines, and opens to the full text,
      the exchanges and the reply box. Phone: the bar is one line, the title and the first
      sentence, and a tap opens the same panel; another tap folds it.
- [ ] The bar never covers the terminal's last line on the desktop, or the dialog card or the
      compose box on the phone.
- [ ] The card over the terminal and the session header's Secretary button go from the
      desktop. Clicking a red-dot contact opens no card and plays nothing.
- [ ] The bar is marked as the secretary's, so its text is never taken for an agent's words.
- [ ] Works the same for Claude and OpenCode sessions.

### Story 2: Which brief the bar shows

**As a** builder coming back to several waiting sessions
**I want** the secretary to take them one after another, the urgent ones first
**So that** nothing waits for me unseen

**Acceptance Criteria:**
- [ ] The waiting briefs form one queue: Needs you before Finished, and the oldest first
      within each.
- [ ] The bar shows the first one, with its place and the count ("1 / 3"), and ‹ › to move
      through the queue.
- [ ] A new brief joins the queue in its place. It never replaces the brief on the bar while
      the builder reads or hears it.
- [ ] When the brief on the bar is dealt with (Story 4), the bar moves on to the next waiting
      one, silently.
- [ ] With nothing waiting, the bar shows the latest brief, marked handled, so it can still be
      read and replayed; with no brief at all, it says nothing is new.
- [ ] Tapping the title opens that session: the desktop selects its contact, the phone opens
      its session screen. It plays nothing.
- [ ] Desk and phone share the queue and what has been dealt with. Each moves through it on
      its own: ‹ › on the phone don't move the desktop's bar.
- [ ] A brief stays one per session: a newer event for a session replaces its brief, as
      today, in its new place in the queue.

### Story 3: Tap to listen

**As a** builder away from the screen
**I want** to hear the brief when I tap Play
**So that** I can listen instead of read

**Acceptance Criteria:**
- [ ] Play plays the brief on the bar. The bar has Play (Replay once it has played) and Stop.
- [ ] Nothing plays without a tap, on the desktop and the phone: not when a brief arrives,
      not on the session on screen, not when the app opens from a push, not when the bar
      moves on. This replaces the desktop's "the session on screen speaks by itself".
- [ ] One brief plays at a time on each device. Moving to another brief stops the current one.
- [ ] A brief that plays keeps playing while the builder moves around the app. It stops on
      Stop, on moving to another brief, when its brief is replaced, or when the mode goes off.
- [ ] Phone: it plays with the phone on silent, the way a video does (G-801).
- [ ] Phone: when the phone locks or the app goes to the background mid-brief, the brief
      finishes, if iOS lets a Home Screen app do so (G-802).
- [ ] With the voice unavailable (no server, or it failed), Play is not offered and the bar
      says why; the text is still there.
- [ ] Playing on one device doesn't start, stop or change anything on the other.

### Story 4: Dealt with

**As a** builder who has heard a brief
**I want** it to leave the queue once I've dealt with it
**So that** the bar always shows what still needs me

**Acceptance Criteria:**
- [ ] A Needs-you brief is dealt with when its dialog is answered: on the bar, by its buttons
      on the phone, or in the terminal.
- [ ] A Finished brief is dealt with when its session is read, as today (opened at the desk or
      on the phone), when it has played to the end, or when the builder presses "Got it" on
      the bar. ⚠️ Assumption: playing to the end, and "Got it", count as reading.
- [ ] Dealing with a Finished brief from the bar marks its session read everywhere: the red
      dot, the Dock count and the phone's Finished state clear, as if it were opened.
- [ ] Nothing plays when the bar moves on to the next brief.

### Story 5: Turn the secretary on from the phone

**As a** builder who has already left the desk
**I want** to turn Secretary Mode on and off from the phone
**So that** I don't have to remember it before I leave

**Acceptance Criteria:**
- [ ] The phone shows a Secretary Mode switch on the session list's header. ⚠️ Assumption.
- [ ] It is the desktop's switch, not a second one. A change on either side shows on the other
      within a second and is saved, as the desktop switch is today.
- [ ] Turned on from the phone, it does what the desktop switch does: sessions that already
      show Finished or Needs you get their briefs at once.
- [ ] Turned off from either side, any brief playing stops and the bar goes, on both.
- [ ] When the Mac can't find the Claude Code CLI, the phone switch shows off, can't be turned
      on, and says the Mac needs Claude Code for the secretary.
- [ ] With no connection to the Mac the switch can't be changed, and the phone says so.
- [ ] With the switch off, the phone behaves exactly as in 0.10.6.
- [ ] The speech server address and key stay on the desktop. The phone can't see or change
      them.

### Story 6: A push that says what happened

**As a** builder with the phone in my pocket
**I want** the push to carry the secretary's first sentence
**So that** the lock screen tells me what happened, not only that something did

**Acceptance Criteria:**
- [ ] With Secretary Mode on, the push for an event waits until that event's brief text is
      ready. Its body is the brief's first sentence. The title is unchanged ("Shop · Needs
      you").
- [ ] If the brief can't be written, or isn't ready within 30 s of the event, the push goes out
      with today's body. ⚠️ Assumption: 30 s. The desktop PRD says text is normally ready
      within 10 s, and may be later on Opus (G-803).
- [ ] With Secretary Mode off, the push is exactly today's: within 5 s, today's body.
- [ ] Every other push rule stays (mobile-v2 Story 7): a newer push for a session replaces the
      older one, an event that a newer one follows gets no push, no push to a phone that has
      the app open and connected, the badge, tapping opens that session.
- [ ] Tapping the push opens the session, and the bar shows that session's brief, ready to
      play.

### Story 7: Answer in words on the bar

**As a** builder who would rather say it than find the button
**I want** to type or dictate my answer on the bar
**So that** the secretary picks the right option, or answers my question first

**Acceptance Criteria:**
- [ ] A replyable Needs-you brief on the bar has a reply box, on the desktop and the phone.
      Dictation works in it. Only Send sends; Return makes a new line, as in the compose box.
- [ ] The secretary reads the reply by the desktop's rules (voice-secretary Story 6): allow,
      deny, an option or "Other" with the text; a whole question box; a "no" with what to do
      instead; "don't ask again" only after a confirming bare yes; it asks back when the reply
      is unclear and answers a question without pressing anything; it presses nothing when
      the dialog has gone or changed.
- [ ] The bar shows each exchange: what the builder said and what the secretary did, asked or
      answered, with the one-line result.
- [ ] The exchanges are shared. A reply sent on the phone shows on the desktop's bar, and one
      sent at the desk shows on the phone.
- [ ] While the secretary reads one reply, a second one from either side is refused and says
      why; the text is kept.
- [ ] On the phone, the dialog card's buttons stay. An answer by button, at the desk or in the
      terminal ends the reply box.
- [ ] A reply can't be sent from the phone with no connection. It is not queued like a
      message; the phone says the Mac is needed and keeps the text.
- [ ] A Finished brief has no reply box; the compose box replies, as today.
- [ ] OpenCode briefs answer what the desktop answers in words today. Anything else says to
      use the buttons or the terminal.

## Non-Functional Requirements

- **Cost:** the bar and the phone add no language-model call and no speech request. One brief
  and at most one speech request per event, as today.
- **Performance:** Play on a ready brief starts sound within 1 s on the desktop (as today) and
  within 2 s on the phone over cellular data. ⚠️ Assumption for the phone. The switch shows its
  new state on both sides within 1 s.
- **Data:** the audio sent to the phone is at most 1 MB per minute of speech. ⚠️ Assumption.
  Today's WAV is 2.9 MB (Qwen3-TTS, 24 kHz) to 5.3 MB (MeloTTS, 44.1 kHz) per minute (G-804).
- **Privacy:** brief text and audio reach the phone only over the existing phone link (tailnet
  HTTPS). The push body is encrypted end to end (Web Push); Apple sees ciphertext. The speech
  key never leaves the Mac. The phone may keep brief text in its cache, as it keeps the chat;
  it never stores audio after it plays. ⚠️ Assumption.
- **Company code:** G-003 of the voice secretary still applies: Secretary Mode is for personal
  projects while the speech server is in a personal account. The phone adds one place a brief
  goes, the encrypted push.
- **Space:** the desktop bar takes at most about four lines of height folded; the phone bar
  one line folded. The UI stays compact (CLAUDE.md).
- **Accessibility:** touch targets at least 44 pt on the phone, as in mobile-v2.

## Technical Constraints

- The Mac holds every brief and every audio file, in memory only (voice-secretary, Privacy).
  The phone asks the Mac for them; it never calls the speech server or the language model.
- One brief per session, shared by the desk and the phone. Neither starts a brief of its own.
- Answers go through the paths that exist: the secretary's key flows for Claude and OpenCode's
  API for OpenCode (`secretary/dialog.ts`). The phone never knows a key binding.
- The phone link protocol (v3, `shared/remote-protocol.ts`) gains what this needs. A phone
  still running an older cached app keeps working as in 0.10.6 until it reloads.
- Report-only hooks and plugins stay as they are (CLAUDE.md "Architecture").

## Dependencies

- Voice secretary: briefs, audio, replies in words (`docs/specs/voice-secretary/prd.md`).
- Mobile v2: the phone link, push and screens (`docs/specs/mobile-v2/prd.md`).
- The Claude Code CLI on the Mac, as for the desktop secretary.
- A speech server for the voice. Without one, the bar shows text only.
- The builder's iPhone for G-801 and G-802; Playwright WebKit can't answer them.

## Out of Scope

- A listening mode that plays briefs by itself, one after another (builder, 2026-11-06).
- Sound in the push, or playing a brief from the lock screen.
- Speech recognition inside the app; the builder uses dictation.
- Speech server settings on the phone.
- Attachments: not built on the desktop either (voice-secretary M3).
- A reply box on Finished briefs.
- Siri, CarPlay or any hands-free control.
- Briefs while Secretary Mode is off.
- What the brief says. The brief writer and its prompt are unchanged.
- One secretary that sums up several sessions in one brief. Each brief is still about one
  session; the bar only puts them in one place.

## Open Questions

Full tracking: `docs/specs/secretary-bar/gaps.md`. None blocks the design:
- G-801: does a tap-started brief play with the iPhone on silent?
- G-802: does a brief keep playing when the phone locks?
- G-803: how long does a brief take on the builder's default model, and is 30 s right?
- G-804: which audio format reaches 1 MB per minute and plays on iOS?

## Success Metrics

- Away from the desk for a day, the builder hears and answers briefs from the phone without
  going back to the Mac.
- At the desk, the builder hears every waiting session from the bar without clicking a
  contact.
- With Secretary Mode on, every push carries the brief's first sentence, except when the
  brief failed or took longer than 30 s.
- Every dialog the secretary can answer in words can be answered in words from the phone.

## Changelog

- v1.1 (2026-11-06): The builder asked for one secretary for the whole app, desktop
  included, in a bar at the top. The epic is renamed from `mobile-secretary` to
  `secretary-bar`. Replaces v1.0's bar under each session's header (G-805) and the desktop's
  per-session card. Added Story 1 (the bar), Story 2 (the queue), Story 4 (dealt with).
  Nothing plays without a tap now on the desktop too.
- v1.0 (2026-11-06): First draft, from the 2026-11-06 ideation. At review the builder chose
  the bar under the header (G-805) and no auto-play for the open session.
