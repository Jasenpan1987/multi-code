# Session Notes — ideation

**Date:** 2026-11-18
**Type:** ideation
**Participants:** Jasen (builder), Claude
**Source:** (verbal, builder-described, in session)
**Outcome:** new epic `docs/specs/session-notes/`

## The ask

The builder often runs several sessions on one project. At the end of a day, some of them
stop with work half done. The next morning the builder has to open them one by one and
scroll up to find where each one stopped, which one is blocked, and which one to continue
today. In the builder's words: "我觉得这非常没有效率，而且很不科学。"

## What was offered first

Claude offered a board with one status card per session (goal, progress, blocker, next
step), filled either from the transcript (free, shows only the end) or by a fork of the
session that writes the card itself (deeper, costs money, needs the agent-brief fork
runner, T-1107). The builder set cost aside and gave a different idea. The status cards
are parked, not rejected.

## The builder's idea

When the builder stops for the day, or wants to continue tomorrow, they click somewhere in
Multi-Code and leave a note on the session: "明天继续做什么", "明天别忘了做这个". The note is
held as unread and stays there the next day, or a reminder says that the session has a
note. It goes away only after the builder has read it.

## Key Decisions

- **A note the builder writes, not a summary a model writes.** No model, no cost. —
  builder
- **The note goes away only when the builder clicks "Got it".** Opening the session to
  look does not clear it. Clearing on open (like today's unread count) was offered and not
  chosen. — builder, via AskUserQuestion
- **A reminder each time Multi-Code starts, once.** A bar lists the sessions with notes.
  The builder was told that with Multi-Code left open overnight this bar does not show,
  and only the sidebar marks remain. "Only the sidebar marks, no reminder" was offered and
  not chosen. — builder, via AskUserQuestion
- **Written in Multi-Code's UI, not in the terminal.** What is typed in the terminal goes
  to the agent, and Multi-Code does not take keys out of it. — Claude, explained to the
  builder; not disputed
- **Design first, by the OMT flow.** Claude had started to read code to build it; the
  builder stopped that: "你不要现在直接写代码，咱们按照 OMT 的方案去推，你先做个设计". — builder

## Proposed by Claude, shown to the builder, not yet confirmed

- One note per session, which the builder can edit.
- A "Leave a note…" item in the session row's right-click menu, next to Rename and Restart,
  and a small button on the session's page.
- A note mark on the session row, and a "N notes" line at the top of the sidebar that jumps
  to the next session with a note.
- A bar above the terminal with the note and the time it was written.
- The note is kept with the contact in `contacts.json`, so it survives a restart.
