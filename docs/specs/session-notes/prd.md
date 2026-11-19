# PRD: Session Notes

**Version:** 1.1
**Last Updated:** 2026-11-19
**Status:** approved by the builder 2026-11-19 ("行，你实现吧"), with every assumption below; the mock was skipped
**Owner:** Jasen

## Overview

The builder leaves a short note on a session for later: "continue X tomorrow", "don't
forget Y". The note stays on the session as unread until the builder clicks "Got it". Each
time Multi-Code starts, a bar lists the sessions that have notes. No model writes or reads
the notes, and nothing goes to the session.

## Background & Context

- **The pain.** The builder runs several sessions on one project. At the end of a day some
  stop with work half done. The next morning the builder opens them one by one and scrolls
  up to find where each one stopped, which is blocked, and which to continue today: "我觉得
  这非常没有效率，而且很不科学。"
- **What exists today.** A session row shows its name, context use and unread alerts. An
  unread alert clears when the builder looks at the session. Nothing on the row or the page
  says what the builder meant to do next in that session.
- **The builder's idea.** Leave a note on the session at the end of the day. It is held as
  unread, stays there the next day or raises a reminder, and goes away only after the
  builder has read it.
- **Parked, not rejected.** Status cards written by a fork of each session. They need the
  agent-brief fork runner (T-1107) and cost money per card.

(source: `docs/timeline/2026-11-18_session-notes-ideation.md`)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Leaves notes at the end of a day; reads and clears them the next day |

## Terms

- **Note:** text the builder writes on one session for themselves. It is not sent to the
  agent.
- **Session, contact:** one row in the sidebar, as today. The note belongs to the contact,
  so it stays when the session inside it changes (for example after `/clear`).
- **Got it:** the button that clears a note. Only this button clears it.
- **Startup bar:** the list of sessions with notes, shown once each time Multi-Code starts.

## User Stories

### Story 1: Leave a note on a session

**As a** builder about to stop for the day
**I want to** write a note on a session
**So that** tomorrow I know what to do next there without reading the transcript

**Acceptance Criteria:**
- [ ] The session row's right-click menu has "Leave a note…", next to Rename and Restart.
      When the session already has a note, the item reads "Edit note…".
- [ ] The selected session's page has a small button that does the same, in its header:
      "Note", or "Edit note" when there is one. *(v1.1: place set, G-1003)*
- [ ] Both open a dialog in the style of the existing dialogs, with a multi-line text box.
      An existing note is filled in. Enter makes a new line. Cmd+Enter or "Save" saves.
      Esc or "Cancel" closes it and changes nothing. A click outside closes it only while
      the text is unchanged. *(v1.1: was "a click outside closes it", like the other
      dialogs; a long note lost to a stray click is worse than one more click.)*
- [ ] While an input method is composing, Esc and Cmd+Enter act on the composition only:
      the dialog stays open and nothing is saved. *(v1.1)*
- [ ] A saved note shows at once (Story 2, Story 3). Saving again replaces the text and
      the time.
- [ ] It works the same for running and stopped sessions, and for Claude and OpenCode.
- [ ] Leaving a note sends nothing to the session: no keys to the terminal, nothing in the
      compose box, nothing in the project's files.

**Notes:**
- ⚠️ Assumption: one note per session. A second note means editing the first.
- ⚠️ Assumption: saving an empty text removes the note, the same as "Got it". (G-1006)
- ⚠️ Assumption: at most 2,000 characters. (G-1007)
- ⚠️ Assumption: the UI text is in English, like "Rename…" and "Restart".
- A note can't be written in the terminal conversation: what is typed there goes to the
  agent, and Multi-Code does not take keys out of it.

---

### Story 2: The note stays until I say I read it

**As a** builder coming back the next day
**I want** the note to stay on the session until I clear it
**So that** a quick look at a session doesn't lose what I meant to do

**Acceptance Criteria:**
- [ ] A session with a note shows a note mark on its row. The mark is not the unread
      alert badge; a row can show both.
- [ ] Opening a session with a note shows a bar above its terminal with the full note,
      when it was written (for example "Yesterday 18:42"), "Edit" and "Got it".
- [ ] Opening the session, typing in it, starting, stopping or restarting it does not
      clear the note. Only "Got it" clears it (or an empty save, Story 1).
- [ ] "Got it" removes the bar, the row mark and the note at once. There is no undo.
- [ ] The note survives quitting Multi-Code, restarting the Mac, restarting the session,
      and `/clear` or a new session inside the contact.
- [ ] A long note does not push the terminal off the page: the bar shows a few lines and
      scrolls for the rest.

**Notes:**
- Clearing on open, like today's unread count, was offered and not chosen. (builder,
  2026-11-18)
- ⚠️ Assumption: the time is the time of the last save, not of the first one.

---

### Story 3: Find the sessions with notes

**As a** builder with many sessions
**I want to** see how many sessions have notes and go to each one
**So that** I don't open every session to look

**Acceptance Criteria:**
- [ ] When one or more sessions have notes, the top of the sidebar shows "1 note" or
      "N notes". With none, the line is not there.
- [ ] Clicking the line opens the next session with a note, in sidebar order, after the
      selected one, and wraps around to the first.
- [ ] Hovering a row's note mark shows the start of the note.

**Notes:**
- ⚠️ Assumption: the folded sidebar shows no note mark in v1. The page bar (Story 2) and
  the startup bar (Story 4) still show.
- ⚠️ Assumption: Option+Shift+↓/↑ (next/previous unread alert) skip notes; notes have
  their own jump through the "N notes" line. (G-1002)

---

### Story 4: A reminder each time Multi-Code starts

**As a** builder starting work in the morning
**I want** Multi-Code to tell me which sessions I left notes on
**So that** I see my plan for the day before I open anything

**Acceptance Criteria:**
- [ ] Each time Multi-Code starts and one or more sessions have notes, a startup bar shows
      at the top of the window. It lists each such session: its name, the first line of
      its note, and when the note was written.
- [ ] Clicking a session in the startup bar opens that session, where Story 2's bar shows
      the full note.
- [ ] "Close" hides the startup bar until the next start. The notes stay.
- [ ] The startup bar does not clear any note, start any session, or show again in the
      same run, also when a new note is saved.
- [ ] With no notes, nothing shows.
- [ ] The list is the notes there were at start. A note cleared while the bar is open
      leaves the list, and the bar goes when none is left. A note written later in the run
      does not join it. *(v1.1)*
- [ ] The startup bar and the secretary bar can both show; neither hides the other.

**Notes:**
- With Multi-Code left open overnight, the startup bar does not show the next day; only
  the sidebar marks and the page bar remain. The builder chose this knowing it.
  (builder, 2026-11-18)

---

### Story 5: Remove and duplicate

**As a** builder tidying the session list
**I want** notes to behave plainly when a session is removed or duplicated
**So that** no note is lost or doubled without my knowing

**Acceptance Criteria:**
- [ ] Removing a session that has a note: the existing remove confirmation also says the
      session has a note and shows its first line. Confirming removes the note too.
- [ ] Duplicating a session does not copy its note.

## Non-Functional Requirements

- **Performance:** saving, clearing and showing a note take effect at once. No transcript
  is read and no model is called.
- **Security and privacy:** notes stay in Multi-Code's own data on the Mac. They are not
  written into the project, not sent to the agent or the phone (v1), and not written to
  debug traces.
- **Scale:** tens of sessions, one note each, up to 2,000 characters.
- **Accessibility:** the note mark, the "N notes" line and the bar buttons can be reached
  and named by the screen reader, like the existing row buttons.

## Technical Constraints

- The note is kept with its contact in Multi-Code's user data (`contacts.json`), so it
  lives and goes with the contact. CLAUDE.md "Data Storage" is updated to say so.
- Nothing is written to the PTY. Writing into a session that waits on a dialog can approve
  that dialog (`reference_pty_write_dialog_hazard`).
- The report-only rule for hooks and plugins is not touched; this feature uses no hook,
  plugin or CLI.
- UI stays compact: the bar and the startup bar take as little height as they can.

## Dependencies

- None. It does not need the agent-brief epic.

## Out of Scope

- Status cards written by a fork of the session (parked; needs T-1107).
- Notes on the phone: showing, writing or clearing them. (G-1001)
- Sending a note to the agent as a message.
- More than one note per session, or a history of old notes.
- A reminder at a set time, a macOS notification, or counting notes on the Dock badge.
  (G-1004)
- A note for a whole project rather than one session.
- Writing a note from inside the terminal conversation.

## Open Questions

Full tracking in `docs/specs/session-notes/gaps.md`.

No blockers. G-1003 (the look) was settled by building it: the builder skipped the mock
and judges it in the app.

## Success Metrics

- The morning after leaving notes, the builder gets from starting Multi-Code to the first
  noted session in one click, with no scrolling in any transcript.
- After two weeks, the builder says they leave notes at the end of a day and that the
  morning round of opening sessions one by one has stopped.

## Changelog

- v1.1 (2026-11-19): Approved with all assumptions. A click outside the dialog keeps a
  changed note; Esc and Cmd+Enter wait for an IME composition; the page button is in the
  header; the startup bar lists the notes there were at start. Reason: decided while
  building, listed in `.omt/session-notes-decisions.md`.
