# PRD: Duplicate Options

**Version:** 1.1
**Last Updated:** 2026-11-20
**Status:** approved for build 2026-11-20: the builder approved G-1101 (OpenCode forks through the API) and asked for it in this release; the assumptions G-1102 to G-1104 stand unless the builder says otherwise
**Owner:** Jasen

## Overview

Right-click → "Duplicate…" opens a dialog with four choices: fork the session (a new
session that starts from this one's conversation), create a new session with the same
tool (today's Duplicate), create a new session with the other tool (Claude Code ↔
OpenCode), or cancel. Each choice makes one new contact on the same project, at the top of
the list. The original session is not changed. Ships in the same release as
`session-notes`.

## Background & Context

- **Today.** "Duplicate…" asks "Duplicate “X”?" and, on Duplicate, starts a second contact
  on the same project and backend in a fresh session, named "X 2" (contactList's
  ConfirmDialog; `ProcessManager.duplicateInstance`).
- **The ask.** Most of the time the builder wants a fork that keeps the current context.
  Today's fresh session is still useful, and so is opening the same project in the other
  tool. (source: `docs/timeline/2026-11-20_duplicate-options-ideation.md`)
- **The CLIs.** Claude Code forks on the command line (`--resume <id> --fork-session`, with
  `--session-id` naming the copy). OpenCode 2.3.0 forks only through its shared service's
  API (`POST /api/session/{sessionID}/fork`). (source: same, probed 2026-11-20)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Branches a session to try another direction, starts a clean session, or opens the project in the other tool |

## Terms

- **Source:** the contact that was right-clicked.
- **Fork:** a new session whose conversation starts as a copy of the source's current
  session. The source's session is not changed. Both work on the same files.
- **Other tool:** OpenCode for a Claude Code contact, Claude Code for an OpenCode contact.

## User Stories

### Story 1: Duplicate asks what kind

**As a** builder
**I want** Duplicate to ask what I want
**So that** one menu item covers a fork, a clean session and the other tool

**Acceptance Criteria:**
- [ ] Right-click → "Duplicate…" opens a dialog titled "Duplicate “X”" in the style of
      the existing dialogs, with four buttons, top to bottom:
      "Fork this session", "New session", "New session with OpenCode" (or "with Claude
      Code"), "Cancel".
- [ ] Each button has one line under it saying what it does (Story 2 to 4).
- [ ] Esc, "Cancel" or a click outside closes it and does nothing.
- [ ] Tab stays among the dialog's buttons; keys never reach the terminal behind it, and
      the dialog sits above an open diff window. *(v1.1)*
- [ ] If the builder has moved to another session, or opened the compose box, before a
      slow fork finishes, the new contact joins the list without being selected. *(v1.1)*
- [ ] The choice starts the new contact at once, at the top of the list, and selects it,
      as Duplicate does today.

**Notes:**
- ⚠️ Assumption: "Fork this session" has the focus once main says there is something to
  fork, so Enter forks. It is the choice the builder makes most. Nothing it does is
  destructive. Until then, and when there is nothing to fork, "New session" has it.
- ⚠️ Assumption: the UI text is in English, like the rest of the menu.

---

### Story 2: Fork the session

**As a** builder in the middle of a conversation
**I want to** start a second session from where this one is
**So that** I can try another direction without losing or mixing up this one

**Acceptance Criteria:**
- [ ] "Fork this session" starts a new contact on the same project and tool whose session
      starts with the source session's conversation, as it is at that moment.
- [ ] The session copied is the one the source's terminal shows now, as the CLI's own fork
      would copy it: for Claude Code, read from that process's own record (so a fork right
      after `/clear` or `/resume` copies the new session), never guessed from the
      directory. *(v1.1, builder 2026-11-20: "Claude Code 上 fork 是什么行为，你就是什么行为")*
- [ ] A session holding only the `/clear` it opened with has nothing to fork.
- [ ] If the source contact is removed while an OpenCode fork is being made, the copy
      still gets its contact. If the copy's start is refused (OpenCode 1.x on the PATH), it
      gets a stopped contact with the reason, and Start opens the copy. *(v1.1)*
- [ ] The source's session, its terminal and its contact are not changed.
- [ ] The new contact owns the new session: its next start opens the fork, not the
      source's session.
- [ ] It works for a running source and for a stopped one.
- [ ] Claude Code: through the CLI's own fork (`--resume` + `--fork-session`).
- [ ] OpenCode: through the shared service's fork API, then a terminal attached to the new
      session. (G-1101, approved 2026-11-20.)
- [ ] With no session to fork (the source has never been sent a message, or its session is
      gone), the button is disabled and its line says why.
- [ ] When the fork fails (OpenCode's service unreachable, the API refuses), no contact is
      made and a message says why.

**Notes:**
- Forking a source that is mid-turn copies the conversation as far as it was written.
- ⚠️ Assumption: the sub-line says "Copies this conversation into a new session. Both work
  on the same files."

---

### Story 3: New session with the same tool

**As a** builder
**I want** today's Duplicate as one of the choices
**So that** I can still start clean on the same project

**Acceptance Criteria:**
- [ ] "New session" does exactly what Duplicate does today: a new contact on the same
      project and tool, in a fresh session of its own.

---

### Story 4: New session with the other tool

**As a** builder
**I want to** open the same project in the other tool
**So that** I can switch between Claude Code and OpenCode without the New dialog

**Acceptance Criteria:**
- [ ] On a Claude Code contact the button reads "New session with OpenCode"; on an
      OpenCode contact, "New session with Claude Code".
- [ ] It starts a new contact on the same project with the other tool, in a fresh
      session. No conversation is carried across.
- [ ] When the other tool can't run (not installed; OpenCode 1.x), the button is disabled
      and its line says why, with the upgrade command for OpenCode 1.x.

## Naming

- ⚠️ Assumption: every choice names the new contact as Duplicate does today: "X 2", then
  "X 3" (the first number no contact has). The avatar already shows the tool.

## Non-Functional Requirements

- **Performance:** the dialog opens at once. A fork starts its terminal within the time a
  start takes today, plus one API call for OpenCode.
- **Safety:** no choice writes to the source's terminal. Nothing is typed into any session.
- **Privacy:** no session content is logged.

## Technical Constraints

- Claude Code: `--resume <source> --fork-session --session-id <new>`, so the contact
  knows its session before the CLI starts. Confirm in QA on the installed CLI.
- OpenCode: the fork API returns the new session; the terminal starts with
  `opencode --session <new>` as today.
- The architecture rule "Multi-Code puts nothing into that service" (CLAUDE.md) gains a
  second exception, recorded in decisions.md (2026-11-20).

## Dependencies

- None open. G-1101 (OpenCode fork through the API) was approved on 2026-11-20.

## Out of Scope

- Forking from an earlier message (OpenCode's `before`, Claude Code's `/branch` from a
  point). The fork starts from the latest message.
- Carrying a conversation from one tool to the other.
- Duplicate from the phone.
- Renaming the new contact inside this dialog (Rename works on it afterwards).

## Open Questions

Full tracking in `docs/specs/duplicate-options/gaps.md`.

No blockers.

## Success Metrics

- The builder forks from the menu instead of typing `/fork` or `--fork-session` by hand.

## Changelog

- v1.1 (2026-11-20): After three cross-model review rounds and the builder's calls: the fork
  copies the session the terminal shows by the process's own record; `/clear`-only
  sessions can't be forked; a Claude fork whose transcript went is refused, not started
  blank; an OpenCode copy always gets a contact; a slow fork doesn't take the selection;
  the dialog sits above the diff window and keeps focus. The builder chose not to handle
  a PTY that throws after an OpenCode copy is made (G-1110).
