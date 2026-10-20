# PRD: OpenCode 2

**Version:** 1.2
**Last Updated:** 2026-10-20
**Status:** draft
**Owner:** Jasen

## Overview

Multi-Code's OpenCode backend moves from OpenCode 1.x to 2.x, and 1.x support is dropped. An OpenCode contact runs the way OpenCode's own VS Code extension runs it: a plain `opencode` terminal attached to the user's shared background service. Multi-Code reads state from that service, answers dialogs through its API, and reads transcripts from OpenCode 2's tables, so alerts, the phone, the secretary and the context figure work again for OpenCode.

## Background & Context

- OpenCode 2 changes every surface Multi-Code uses: process model (one shared service per user, TUIs as clients), plugin API, event names and payloads, database tables, dialog keys. The two versions can't be installed side by side. (source: docs/timeline/2026-10-16_backend-expansion-research.md)
- The builder chose 2.x only, run like the VS Code extension: nothing injected into the server, state from the service's event stream, dialogs answered by API (docs/knowledge/decisions.md, both 2026-10-16 entries). Confirmed 2026-10-20 after the cost of dual support was checked again.
- The builder upgraded to 2.0.32 on 2026-10-20. Since the database migrated (2026-10-19), OpenCode contacts in Multi-Code 0.8.4 have no alerts (the V1 plugin doesn't load) and their transcripts, context usage and briefs are frozen at 2026-10-18 (V2 never writes the V1 tables). (source: docs/timeline/2026-10-20_opencode-v2-source-reading.md, "What is broken today")
- Source facts for every story below: docs/timeline/2026-10-20_opencode-v2-source-reading.md.

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen | Runs OpenCode contacts beside Claude ones; relies on chimes, the phone and the voice secretary; also uses plain `opencode` in terminals and VS Code |
| Future open-source users | OpenCode users | Install Multi-Code with OpenCode 2 already on their machine |

## Definitions

- **Shared service**: the background OpenCode server every `opencode` TUI of the user connects to. It owns sessions, runs turns, and outlives every TUI.
- **Shown session**: the session a contact's terminal is displaying right now. It changes with `/new`, `/clear`, `/sessions`, `/open`.
- **Root session**: a session that is not a subagent of another. Subagent sessions belong to their root.
- Finished, Needs you, Acknowledge: as in docs/specs/attention-alerts/prd.md.

## User Stories

### Story 1: An OpenCode contact starts on 2.x

**As a** builder
**I want** OpenCode contacts to start the 2.x TUI against my shared service
**So that** they behave as `opencode` does in any terminal or in VS Code

**Acceptance Criteria:**
- [ ] Starting an OpenCode contact opens the OpenCode 2 TUI in its terminal, in the contact's project directory, connected to the user's shared service (the one plain `opencode` uses)
- [ ] A contact with a session of its own reopens that session on every start and restart, including sessions made under 1.x (their ids survived the migration)
- [ ] A new contact, a duplicated contact and a contact whose session is gone start in a fresh session that belongs to that contact alone, even before anything is typed
- [ ] A contact with no session on record opens the directory's most recent root session, or a fresh one when another contact holds that one (as Claude's `--continue` does; T-611 B-3)
- [ ] Two contacts on one project never open the same session through these rules
- [ ] The TUI shows no tab bar inside Multi-Code; Ctrl+Z does not freeze the terminal
- [ ] The user's own OpenCode settings apply inside Multi-Code as in a terminal: their config, providers, server plugins, and their own TUI plugins
- [ ] OpenCode installed by the official script, by npm or by Homebrew is found when Multi-Code is launched from the Dock
- [ ] An OpenCode terminal gets the builder's login-shell environment (PATH and the rest, as a new terminal tab would), so the agent's shell commands and `npx`-launched MCP servers find their tools when Multi-Code was opened from the Dock (builder, 2026-10-20)

---

### Story 2: OpenCode 1.x is refused with a way forward

**As a** builder (or a new user still on 1.x)
**I want** Multi-Code to tell me plainly that it needs OpenCode 2
**So that** I don't get a contact that half works

**Acceptance Criteria:**
- [ ] When the `opencode` Multi-Code would run is 1.x, the New Instance dialog says so and names the upgrade command, as it does today when `opencode` is missing
- [ ] Starting an existing OpenCode contact on 1.x does not launch it; the contact's page says why and names the upgrade command
- [ ] No code path for 1.x remains (plugin, event names, tables, keystroke mappings)

---

### Story 3: Finished and Needs-you come from the service

**As a** builder
**I want** OpenCode contacts to chime exactly when Claude ones would
**So that** one rule covers every contact

**Acceptance Criteria:**
- [ ] A turn in the contact's shown session, or in any session that contact has shown since it started, raises exactly one Finished event when it ends normally, within 1s of the service reporting it
- [ ] A turn that ends on an API or model error raises a Finished event with the same chime (G-002 of attention-alerts)
- [ ] A turn the builder interrupts (double Esc), a turn ended by a Reject without a reason, and a dismissed question raise no event
- [ ] A turn the service ends because it is restarting or being replaced raises no event; when the new service resumes it, the resumed turn's own end raises one
- [ ] A permission dialog or question raises one Needs-you event within 1s, whether it comes from the root session or a subagent of it
- [ ] A dialog answered anywhere (this terminal, another OpenCode client, the phone, the secretary) clears the Needs-you state; so does the turn ending without an answer
- [ ] A subagent finishing never raises an event on its own; a root that carries on after a subagent's dialog was rejected and then finishes raises one Finished (spike finding 3)
- [ ] Events of sessions that belong to no running Multi-Code contact (VS Code, a plain terminal, a stopped contact) raise nothing in Multi-Code
- [ ] After the connection to the service drops and comes back, or the service is replaced, Multi-Code's view of each contact (busy, blocked on which dialog) matches the service again within 5s, without a duplicate chime for a dialog it already reported
- [ ] A dialog left unanswered until OpenCode evicts the location (60 minutes) ends the turn; that end raises a Finished event. ⚠️ Assumption: the builder wants to know the turn died, as with an error
- [ ] The rules of docs/specs/attention-alerts/prd.md Stories 4 and 5 hold for OpenCode contacts: chime, red badge, Dock count, acknowledge, `wait_for_idle`, the write-safety gate, context refresh after a turn

---

### Story 4: Multi-Code follows the session the terminal shows

**As a** builder
**I want** a contact's transcript, context figure and alerts to follow `/new`, `/clear`, `/sessions` and `/open`
**So that** a contact never reports on a session I've left

**Acceptance Criteria:**
- [ ] Within 2s of the terminal showing another session, that session becomes the contact's own: the next start reopens it, and the transcript, context figure and secretary read it
- [ ] After `/new` or `/clear` the contact is on the new session once the first prompt creates it
- [ ] A session another running contact holds is never taken over by a second contact through this path
- [ ] Two contacts on one project, and a VS Code terminal on the same project, each keep their own session

---

### Story 5: The phone answers OpenCode dialogs through OpenCode's API

**As a** builder away from the desk
**I want** to answer an OpenCode permission or question from my phone
**So that** the agent keeps working without me at the screen

**Acceptance Criteria:**
- [ ] A permission shows the options OpenCode offers for it: Allow once / Always allow / Reject, or Allow once / Reject when OpenCode offers no "always" for that request
- [ ] Tapping an option answers that exact request; if it was already answered or is gone, the phone says so and nothing else is answered
- [ ] A single-select question with one question shows its options and is answered by one tap
- [ ] A multi-select question or a box of several questions is shown read-only, as today
- [ ] Nothing reaches the TUI as keystrokes when the phone answers a dialog

---

### Story 6: The secretary answers OpenCode dialogs through OpenCode's API

**As a** builder talking to the voice secretary
**I want** it to answer OpenCode dialogs as fully as it answers Claude's
**So that** I can stay on the phone call instead of walking to the screen

**Acceptance Criteria:**
- [ ] Permissions: allow once, allow always (only after the confirmation rule of decisions.md 2026-10-10), reject, and reject with a reason the agent receives and continues from
- [ ] The secretary's description of "always" matches OpenCode 2: saved for this project from now on, not until restart
- [ ] Questions: single-select, multi-select, several questions in one box, and a typed answer of the builder's own
- [ ] An answer is applied only while the dialog the brief was about is still open; otherwise nothing is answered and the secretary says it was handled already
- [ ] Nothing reaches the TUI as keystrokes when the secretary answers a dialog

---

### Story 7: Transcript, brief and context figure read OpenCode 2's records

**As a** builder
**I want** the phone transcript, the manager's reads, the secretary's brief and the context figure to show today's work
**So that** they stop showing a conversation frozen at the migration

**Acceptance Criteria:**
- [ ] The phone transcript of an OpenCode contact shows its current session: typed messages, assistant text, tool calls with a one-line summary, and which call is still running
- [ ] Sessions made under 1.x and migrated read the same way, old tool names and all
- [ ] The secretary's brief uses only what the builder typed as "their" messages, never text OpenCode injected (reminders, subagent results, restart notices)
- [ ] The context figure is the newest step's input-side tokens, as for Claude, and resets after a compaction
- [ ] The context percentage shows for any model the user's config or OpenCode's cached model catalog knows; otherwise the bare token count shows, as today
- [ ] Stopped contacts show their last figures and transcript, with no OpenCode process running
- [ ] Multi-Code never writes to OpenCode's database

---

### Story 8: Quick actions match OpenCode 2

**As a** builder
**I want** the toolbox buttons to do the right thing on an OpenCode contact
**So that** none of them half-works

**Acceptance Criteria:**
- [ ] Rename Session sets the session's title to the name typed, in one step
- [ ] Resume Elsewhere copies a command that opens this session in any terminal
- [ ] Clear and Compact work; Show Cost stays disabled with its reason
- [ ] The manager's `run_command` and `send_task` work on OpenCode contacts as before

---

### Story 9: Say so when Multi-Code can't see the service or the terminal

**As a** builder
**I want** a clear bar when an OpenCode contact's alerts can't work
**So that** silence never means "broken" without my knowing

**Acceptance Criteria:**
- [ ] When Multi-Code can't reach the shared service for a running OpenCode contact within 15s of its start, or loses it for more than 15s, the contact's page shows a bar saying alerts are off and why in one line
- [ ] When the contact's terminal never reports which session it shows (Multi-Code's TUI plugin didn't load), the bar says so
- [ ] The bar goes away by itself once the cause is gone

---

### Story 10: Nothing of Multi-Code reaches plain OpenCode

**As a** builder who also runs `opencode` in terminals and VS Code
**I want** those to behave as if Multi-Code were not installed
**So that** Multi-Code never changes my tools behind my back

**Acceptance Criteria:**
- [ ] Multi-Code writes no file the user owns: not `~/.config/opencode/*`, not a project's `.opencode/`, not OpenCode's database or state files
- [ ] Multi-Code's TUI plugin loads only in the terminals Multi-Code starts, and only reports; it never changes a session, a prompt or a dialog
- [ ] When no shared service is running, Multi-Code starts it before the terminal, with the builder's login-shell environment and none of Multi-Code's own variables, so it behaves for plain `opencode` and VS Code exactly as one started from a terminal (builder, 2026-10-20)
- [ ] The service's password is never logged, written to disk by Multi-Code, sent to the renderer or sent to a phone
- [ ] Multi-Code never restarts, replaces or stops the shared service; it starts one only when none is running and an OpenCode contact is starting

---

### Story 11: Stop and quit mean "close the terminal"

**As a** builder
**I want** stopping an OpenCode contact to act like closing its terminal
**So that** OpenCode keeps the work going, as it does in VS Code

**Acceptance Criteria:**
- [ ] Stopping or restarting an OpenCode contact closes its terminal and does not interrupt a turn running in the service
- [ ] A stopped contact raises no alerts, whatever its session does in the service (builder, 2026-10-20)
- [ ] Quitting Multi-Code does not warn about OpenCode contacts mid-turn, because quitting doesn't cut them off. Claude contacts are warned about as today

## Non-Functional Requirements

- **Performance:** one connection to the service for all contacts; no polling of OpenCode's database for state. Reads stay throttled as today (context figure TTL).
- **Reliability:** a dropped or replaced service is recovered from without restarting Multi-Code; a malformed event is dropped, never fatal.
- **Security:** the service password lives in the main process only; requests go to the loopback address in the registration file only; Multi-Code's own files stay 0600 in `userData`.
- **Compatibility:** OpenCode 2.0.32 as measured. A newer 2.x that changes an event or table shape degrades to "alerts off" or an empty read, never to a wrong answer.

## Technical Constraints

- The CLAUDE.md rule "report-only hooks and plugins" gains one exception, recorded in decisions.md 2026-10-16: answering a dialog through the CLI's own API, as the builder would by keypress.
- No file the user owns is written (zero-residue principle, docs/knowledge/business-overview.md).
- The manager stays Claude-only.
- The Backend interface stays the seam (docs/knowledge/tech-conventions.md); Claude's behaviour must not change.

## Dependencies

- OpenCode 2.0.32 on the builder's machine (installed 2026-10-20).
- A model that can run real OpenCode turns in an isolated test setup for the spike and QA (G-602).

## Out of Scope

- OpenCode 1.x, in any form.
- An OpenCode manager.
- Listing sessions started outside Multi-Code (VS Code, terminals) as contacts.
- Alerts for stopped contacts (builder, 2026-10-20).
- Sending prompts through the API; prompts keep going through the terminal.
- Live transcript streaming from the event stream; transcripts keep being read from the database.
- Answering multi-select or multi-question boxes from the phone.
- Pi, Codex, DeepSeek Harness.

## Open Questions

Tracked in docs/specs/opencode-v2/gaps.md. None blocks the design; G-601 to G-605 are for the spike to settle.

## Success Metrics

- Every OpenCode scenario in the test plan raises the same alerts as its Claude counterpart.
- The builder answers an OpenCode permission and a question from the phone and from the secretary without touching the desk.
- An OpenCode contact's context figure and transcript move during a turn, on the builder's real data.
- Plain `opencode` in a terminal shows no trace of Multi-Code with Multi-Code running.

## Changelog

- v1.0 (2026-10-20): First version.
- v1.2 (2026-10-20): Story 1's "no session on record" rule matches what was built and what Claude does: a held newest session gives a fresh one (T-611 B-3).
- v1.1 (2026-10-20): Story 1 and Story 10 gain the login-shell environment and Multi-Code starting a missing service itself (builder decision after the T-601 spike found the shared service keeps its starter's environment). Story 3's rules refined by the spike: a root that carries on after a subagent's Reject and succeeds chimes Finished.
