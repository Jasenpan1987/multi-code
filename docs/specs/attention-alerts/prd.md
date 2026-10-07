# PRD: Attention Alerts

**Version:** 1.7
**Last Updated:** 2026-10-07
**Status:** draft
**Owner:** Jasen

## Overview

Multi-Code's core promise is that the builder can stop watching terminals: when an agent
finishes, or gets stuck waiting on a human, Multi-Code chimes, puts a red dot on its
contact, and bounces the Dock. Today that promise fails both ways. It chimes while agents
are still working, and it often stays silent when they finish.

This epic makes the alert trustworthy. Claude instances report their own state through
the CLI's official hooks instead of Multi-Code guessing it from transcripts and terminal
silence, and the alert follows simple chat-app rules: every new event chimes, and it is
cleared by the builder acting on it. OpenCode instances then get the same treatment
through OpenCode's own plugin events, as a separate track once Claude is done.

## Background & Context

Measured on 2026-10-06 against a live CLI and 60 of the builder's own transcripts
(source: docs/timeline/2026-10-06_attention-alerts-investigation.md):

- "Needs you" is guessed from a tool call left unpaired >1.5s plus 800ms of terminal
  silence. The CLI routinely goes 0.9–1.0s between repaints while working, and 38% of
  this builder's tool calls stay unpaired long enough to be exposed, so the guess fires
  during ordinary work. A real Bash permission dialog repaints every 0.6s and is never
  caught.
- "Finished" is the transcript's `end_turn` plus a 2s timer. It fires early when the agent
  hands work to a background subagent, then again when that work completes.
- The attention policy silences "finished" for the instance being watched but lets the
  guessed "needs you" through as urgent, which is exactly the inverted experience the
  builder reports. A 5s cooldown lets a false alert swallow the real one that follows.
- The CLI's hooks report each of these moments exactly: `Stop` within ~30ms of the turn
  ending, `PermissionRequest` the moment a dialog appears. Every comparable app surveyed
  (Orca, cmux, Superset, Agent Deck, Sculptor) uses hooks; none uses `end_turn`.

The manager instance already runs with report-only hooks injected through `--settings`
from `userData` (`docs/knowledge/tech-conventions.md`, "A hook is how the manager's own
tool calls become visible"). This epic extends that pattern to every Claude instance.

This needed the zero-residue principle revised. The 2026-05-18 version ruled out hooks
because they would have had to be written into `~/.claude/settings.json` or
`<cwd>/.claude/`. On 2026-10-06 the builder replaced it: never write a file the user owns,
and launch options pointing at Multi-Code's own `userData` are allowed
(source: docs/knowledge/business-overview.md, Zero-residue principle; G-001).

OpenCode (measured on 1.18.34, same record) has the equivalent seam: a plugin loaded from
a plugin file named in `OPENCODE_CONFIG_CONTENT`, which merges with the user's own
config, and whose events report idle, permission, and question state exactly. Today
Multi-Code guesses the same states from OpenCode's SQLite rows and from parsing the
permission dialog off the screen.

## Delivery Tracks

Decided by the builder on 2026-10-06: finish Claude Code first, then OpenCode as its own
line of work.

| Track | Backend | Stories | Starts |
|-------|---------|---------|--------|
| 1 | Claude Code | 1–6 | now |
| 2 | OpenCode | 7 | after Track 1 ships |

Story 4's alert rules apply to both backends from Track 1 on. Until Track 2 ships,
OpenCode's events keep coming from its existing detector.

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Runs several agents at once, works elsewhere, and relies on the chime to know when one needs them |

## Definitions

- **Attention event** — one of two things happening to an instance:
  - **Finished**: the agent's work for this request is done and it is waiting for a new
    message.
  - **Needs you**: the agent is blocked on a human decision — a permission dialog, a
    question (AskUserQuestion), a plan approval, or an MCP server asking for input.
- **Shown instance** — the instance currently selected in the contact list, whose
  terminal is on screen.
- **Acknowledge** — the builder types into the shown instance (terminal or compose box),
  clicks anywhere in the shown instance's page (terminal, compose box, toolbox) but not
  in the contact list, or selects it in the contact list. Clicking another contact
  acknowledges that contact, not the one being left.
  ⚠️ Assumption: the builder's "click on the active page" means the session's own page,
  not the sidebar, so switching away doesn't silently clear the dot being left.

## User Stories

### Story 1: Hooks reach only the instances Multi-Code launches

**As a** builder
**I want** Multi-Code's hooks to exist only inside the agents Multi-Code starts
**So that** using `claude` on its own, in any terminal or project, behaves exactly as if Multi-Code were not installed

**Acceptance Criteria:**
- [ ] Every Claude instance Multi-Code spawns, including the manager, is launched with a Multi-Code-owned settings file passed by `--settings`
- [ ] That file lives under `app.getPath("userData")`, is written `0600`, and is removed on shutdown
- [ ] Multi-Code writes nothing to `~/.claude/settings.json`, to any project's `.claude/` directory, or to any other file the user owns
- [ ] Running `claude` in an ordinary terminal produces no Multi-Code alert and no hook activity, whether Multi-Code is running, stopped, or crashed
- [ ] The user's own settings keep applying inside Multi-Code instances: env (e.g. Bedrock), permission rules, their own hooks, status line
- [ ] The manager's existing activity-feed hooks keep reporting its tool calls
- [ ] Hooks are report-only: they never block or alter a tool call or a turn, print nothing the CLI would feed to the model, and always exit successfully
- [ ] When Multi-Code is unreachable or a hook delivery fails, the agent carries on unaffected and without visible delay
- [ ] Each delivery is attributed to exactly the instance that produced it, including two instances sharing one `cwd`, and after `/clear` or `/new` moves an instance to a new session
- [ ] Deliveries that don't carry Multi-Code's credentials are ignored, so another local process can't raise or clear an alert

**Notes:**
- A crash leaves the settings file behind in `userData`. That is inert: no process outside Multi-Code reads it.

---

### Story 2: "Finished" fires once, at the real end

**As a** builder
**I want** exactly one "finished" alert per request, when the agent is truly done
**So that** a chime always means "come back now", never "still working"

**Acceptance Criteria:**
- [ ] When the main agent finishes responding and no background subagent work is running, exactly one Finished event is raised for that instance, within 1s of the CLI's own turn end
- [ ] When the agent replies while background subagents are still running ("running in the background, I'll report back"), no event is raised; one Finished event is raised after they complete and the agent's final reply ends
- [ ] A background shell command still running (e.g. a dev server) does not hold back the Finished event
- [ ] When a background shell command later exits and the CLI wakes the agent to report on it, that turn raises its own Finished event when it ends, with the same chime (G-003). A command that never exits never causes one
- [ ] A subagent completing never raises an event on its own
- [ ] A turn the builder interrupts (Esc) raises no event
- [ ] A turn that ends because the builder denied a dialog (Esc or No) raises no event. ⚠️ Assumption: same as an Esc interrupt, since the builder is the one who just ended it; the CLI ends such a turn without a `Stop`
- [ ] A turn the CLI ends on an API error (rate limit, overloaded, authentication) raises a Finished event with the same chime as a normal finish, so the builder notices it stopped (G-002)
- [ ] If one of the builder's own Stop hooks makes the agent keep going, no event is raised until it actually stops
- [ ] Slash commands that run no model turn (`/model`, `/status`, `/cost`) raise no event
- [ ] A manual `/compact` raises one Finished event when it completes. The CLI reports its end (`PostCompact`) and sends no `Stop` for it. ⚠️ Assumption: compaction takes long enough that the builder looks away
- [ ] An automatic compaction in the middle of a turn raises no event of its own
- [ ] Long-running tools and subagents never raise an event while they run, however long they run and however quiet the screen is

**Notes:**
- On CLI 2.1.291 every Agent call runs in the background, so a reply that ends while a subagent still runs is the common case, not an edge (source: docs/timeline/2026-10-06_attention-alerts-investigation.md, Hook spike item 1).
- A turn the CLI starts on its own to report a finished background task counts as a request here: it ends with one Finished event.

---

### Story 3: "Needs you" fires once, the moment the agent blocks

**As a** builder
**I want** an alert as soon as an agent is stuck waiting on me, and only then
**So that** an agent never sits blocked for minutes because nothing told me

**Acceptance Criteria:**
- [ ] A permission dialog raises one Needs-you event within 1s of appearing (not the CLI's own ~6s-delayed notification)
- [ ] AskUserQuestion, plan approval (ExitPlanMode), and an MCP input request each raise one Needs-you event within 1s
- [ ] One dialog raises one event, even when several hooks report it
- [ ] Answering one dialog and getting another raises a second event
- [ ] When the dialog is answered, at the desk or on a paired phone, the instance leaves the blocked state and a paired phone drops its option buttons. This includes a denial (Esc or No), for which the CLI sends no hook
- [ ] A paired phone still shows the question and its options, as it does today
- [ ] Works in the permission modes the builder uses: default mode with allow rules, and auto mode. Also plan mode and bypass mode (`--dangerously-skip-permissions`), which report dialogs the same way (measured on 2.1.291)

---

### Story 4: Alerts behave like a chat app

**As a** builder
**I want** every new event to chime, and the alert to clear only when I act on it
**So that** I never miss one because Multi-Code decided I was already looking

**Acceptance Criteria:**
- [ ] Every attention event, Finished or Needs you, plays the chime once, whichever instance is shown and whether or not the window has focus
- [ ] Every attention event puts a red dot on the instance's contact
- [ ] When Multi-Code is not the frontmost app, the Dock icon starts bouncing and keeps bouncing until Multi-Code is brought to the front
- [ ] Acknowledging an instance stops its chime if it is still playing and clears its red dot
- [ ] A red dot is never cleared by a timer or by window focus alone; only acknowledging clears it
- [ ] Acknowledging one instance leaves every other instance's red dot alone
- [ ] Events from several instances each chime, even when they arrive together
- [ ] The same rules apply to OpenCode instances, whose events come from their existing detector until Story 7 replaces it

**Notes:**
- Replaces today's suppress-while-watching rule, the urgent override, the 5s cooldown, and the 1.5s auto-clear of the shown instance's red dot.
- ⚠️ Assumption: bringing the window forward with ⌘Tab, without a click or a keystroke, stops the Dock bounce (macOS does this) but does not clear red dots. Consistent with the builder's rule that typing or clicking clears them.

---

### Story 5: Everything that relied on the old detector keeps working

**As a** builder
**I want** the manager, the phone, and the safety gate to keep working on the new signals
**So that** fixing the chime doesn't break the features built on top of it

**Acceptance Criteria:**
- [ ] The manager's `wait_for_idle` returns when a turn finishes, and does not return early while background subagents are still running
- [ ] The write-safety gate still refuses a write to an instance blocked on a dialog
- [ ] Context usage still refreshes after each finished turn
- [ ] A paired phone still receives every attention event
- [ ] Claude instances no longer derive attention from transcript `end_turn` markers, timers that guess at state, or terminal silence; that code is removed, not left beside the new path. A short debounce on a state the CLI reported (waiting briefly after `Stop` to see whether the agent carries on) is allowed

---

### Story 6: Say so when hooks can't run

**As a** builder
**I want** to be told plainly when an instance can't report through hooks
**So that** a disabled hook setting doesn't silently bring back the old silence

**Acceptance Criteria:**
- [ ] If a Claude instance has started (the CLI's session registry lists it) but none of its hooks has reached Multi-Code within 10 seconds, a bar across the top of that instance's page says its hooks aren't running, so Multi-Code can't tell when it finishes or needs you, and to check on it yourself
- [ ] The same bar shows from the start for an instance spawned while Multi-Code's alert endpoint wasn't running
- [ ] The bar names the likely causes on hover: `disableAllHooks` in the user's Claude settings, or a managed policy that allows only managed hooks
- [ ] The bar disappears as soon as a hook delivery from that instance arrives
- [ ] An instance whose hooks are working never shows it
- [ ] A degraded instance raises no alerts at all: no chime, red dot or Dock bounce from any other source
- [ ] OpenCode instances show the same bar, worded for the plugin, once Story 7 has moved them onto it: an OpenCode instance whose plugin never reports within 10 seconds of starting shows it (builder, 2026-10-07)

**Notes:**
- Decided by the builder on 2026-10-07: a plain warning instead of a registry-driven fallback. The registry reads `waiting` while a slash-command panel is open and once blinked `idle` mid-handover (T-401), so alerts guessed from it would bring back the false chimes this epic removes. Hooks stop running when the user sets `disableAllHooks` or an admin enforces managed-hooks-only, both rare.

---

### Story 7: OpenCode reports through its own plugin (Track 2)

**As a** builder
**I want** OpenCode instances to report Finished and Needs you through OpenCode's own plugin events
**So that** an OpenCode agent's chime is as trustworthy as a Claude one, and the two behave the same

**Acceptance Criteria:**
- [ ] Starts after Track 1 (Stories 1–6) has shipped for Claude
- [ ] Every OpenCode instance Multi-Code spawns loads a Multi-Code plugin file kept under `app.getPath("userData")`, named to OpenCode by `OPENCODE_CONFIG_CONTENT` (`{"plugin":["file://…"]}`) in that process's environment only, merged into any `OPENCODE_CONFIG_CONTENT` the user already has. Not `OPENCODE_CONFIG_DIR`, which drops the user's global `AGENTS.md`
- [ ] Multi-Code writes nothing to `~/.config/opencode/`, to any project's `.opencode/` directory, or to any other file the user owns
- [ ] Running `opencode` in an ordinary terminal is unaffected, whether Multi-Code is running, stopped, or crashed
- [ ] The user's own OpenCode config keeps applying inside Multi-Code instances: model, MCP servers, skills, agents, permission rules, their own plugins, and their global `~/.config/opencode/AGENTS.md` instructions
- [ ] The plugin is report-only: it never answers or changes a permission, never throws into OpenCode, and never makes the agent wait on Multi-Code; Multi-Code being unreachable leaves the agent unaffected
- [ ] The main session going from busy to idle raises one Finished event, within 1s
- [ ] A subagent session (one with a parent session) going idle never raises an event; a permission request or question from a subagent does raise Needs you on the instance, because it blocks the builder just the same
- [ ] An Esc abort raises no event, even though OpenCode reports idle after it, and OpenCode reporting idle twice in a row raises one event
- [ ] A turn that ends on an API error raises a Finished event, the same chime as a normal finish
- [ ] A permission request and a question each raise one Needs-you event within 1s; answering it, at the desk or on a paired phone, leaves the blocked state, and so does an abort or error while it is open (OpenCode sends no reply event then)
- [ ] A paired phone still shows the permission or question and its options
- [ ] Each delivery is attributed to exactly the instance that produced it, including two instances sharing one `cwd`; deliveries without Multi-Code's credentials are ignored
- [ ] OpenCode attention is no longer derived from polling its SQLite tables or from parsing the screen; that code is removed. Reading the transcript and context usage from the database stays
- [ ] Story 5's consumers keep working for OpenCode: manager `wait_for_idle`, the write-safety gate, context refresh, the phone
- [ ] Story 6's bar works for OpenCode: a plugin that never reports (failed to load, `--pure`, a broken config) shows it on the instance's page

**Notes:**
- Measured on 1.18.34: `session.status`, `permission.asked`/`permission.replied`, `question.asked`/`question.replied`, child sessions carrying `parentID` on `session.created`/`session.updated`, `MessageAbortedError` followed by a doubled idle on Esc (source: docs/timeline/2026-10-06_attention-alerts-investigation.md).
- OpenCode v2 renames these events (`permission.v2.*`, `question.v2.*`, `session.next.*`); listening for both names is cheap insurance.
- OpenCode's `--pure` flag disables external plugins; Multi-Code never passes it.

## Non-Functional Requirements

- **Latency:** both events within 1s of the CLI's own state change (Story 2 background wait excepted).
- **Overhead:** hooks add no perceptible delay to a tool call or a turn. Anything registered on an every-tool-call event must not make the CLI wait on Multi-Code.
- **Security:** no credential on a hook's command line (it is `ps`-visible); credential files `0600`; deliveries without valid credentials ignored. Follows `docs/knowledge/tech-conventions.md`.
- **Observability:** every received hook and every raised event is traceable under `MULTICODE_DEBUG`, so a missed or extra chime can be diagnosed after the fact.

## Technical Constraints

- Track 1 is Claude only. OpenCode keeps its current detection until Track 2.
- Claude injection only through `--settings`, which the CLI merges over the user's own settings rather than replacing them (measured 2026-10-06).
- OpenCode injection only through `OPENCODE_CONFIG_CONTENT` set in the spawned process's environment, which merges over the user's own config (measured 2026-10-06). `OPENCODE_CONFIG_DIR` also merges model, MCP and plugins but replaces the global config directory, so the user's global `AGENTS.md` is lost.
- The manager already passes `--settings`; its activity hooks and the new alert hooks must coexist. The CLI applies only the last `--settings` flag, so they share one file (measured 2026-10-07).
- No PTY text matching, terminal-title parsing, BEL/OSC parsing, or timing heuristics that infer a state the CLI did not report. A short debounce on a reported event is fine.

### To verify before building

Measured on CLI 2.1.290 (see the investigation record): `Stop`, `PermissionRequest` for a
Bash dialog and for AskUserQuestion, no hook on Esc, early `Stop` with background
subagents, registry `busy`/`waiting`/`shell`/`idle`. The rest was measured on 2.1.291 in
T-401 (same record, "Hook spike"):

- `Stop` lists still-running background work in `background_tasks`, each with a `type`
  (`subagent` or `shell`)
- ExitPlanMode raises `PermissionRequest`; an MCP input request raises `Elicitation`
- Auto mode (on a model that supports it) and bypass mode still raise `PermissionRequest`
  for AskUserQuestion and plan approval
- An API-error stop raises `StopFailure` (with an `error` such as `model_not_found`) and no
  `Stop`; the registry shows `idle`
- A denied dialog raises no hook at all; `/compact` ends with `PostCompact`, not `Stop`

For Track 2, measured on OpenCode 1.18.34 (same record). Not yet measured:

- That the user's own `plugin` entries survive alongside ours on the builder's real machine (verified in an isolated sandbox: `plugin` is a deduplicated union across sources)
- What an API-error stop looks like: which `session.error`, and whether `session.idle` follows
- "Allow always" and multi-question dialogs

## Dependencies

- Claude Code CLI with `--settings`, `PermissionRequest` and `StopFailure` hooks (present in 2.1.284–2.1.291 on this machine), `Stop.background_tasks`, `Elicitation` and `PostCompact` (measured on 2.1.291)
- The manager's local HTTP server and `/hook` path, or an equivalent listener that runs whenever any Claude instance runs (today the server starts only with the manager)
- Track 2: OpenCode with `OPENCODE_CONFIG_CONTENT` and plugin events (present in 1.18.34 on this machine), reporting to the same listener

## Out of Scope

- ❌ Alerts for agents started outside Multi-Code (plain terminal). Deliberate, see Story 1
- ❌ Different sounds for Finished vs Needs you, volume or mute settings, quiet hours
- ❌ macOS Notification Center banners and Dock badge counts
- ❌ A chime that repeats until acknowledged; the chime plays once per event
- ❌ The CLI's own `idle_prompt` and delayed `permission_prompt` notifications as alert sources

## Open Questions

See `docs/specs/attention-alerts/gaps.md`. G-001 to G-003 are resolved; none are open.

## Success Metrics

- Over a week of normal use the builder reports no chime while an agent is still working, and no finished turn without a chime
- Under `MULTICODE_DEBUG`, every finished request shows exactly one Finished event, and every dialog exactly one Needs-you event
- Running `claude` outside Multi-Code shows no change in behavior (verifiable by inspection: no file outside `userData` is written)
- After Track 2, the same holds for OpenCode instances and for `opencode` run outside Multi-Code

## Changelog

- v1.0 (2026-10-06): Initial draft from the same-session investigation. Builder decisions baked in: hooks via `--settings` from `userData`; chat-app alert rules (every event chimes; typing or clicking on the shown instance acknowledges; ignored red dots stay and the Dock keeps bouncing); background subagents hold the Finished event.
- v1.1 (2026-10-06): G-001 resolved (zero-residue principle revised to allow `--settings` from `userData`; conflict note replaced). G-002 resolved (an API-error stop chimes like a normal finish; assumption promoted into Story 2).
- v1.2 (2026-10-06): OpenCode brought into scope as its own track, after Claude (builder decision). Added Delivery Tracks and Story 7 (OpenCode plugin, from the 1.18.34 probe); removed "changing OpenCode's detection" from Out of Scope.
- v1.3 (2026-10-06): Story 7 corrected from the OpenCode source research: inject with `OPENCODE_CONFIG_CONTENT`, not `OPENCODE_CONFIG_DIR` (which drops the user's global `AGENTS.md`); subagent dialogs do raise Needs you; an abort clears an open dialog; Finished is the root session's busy→idle. Builder confirmed the two tracks run one after the other in a single line of work.
- v1.4 (2026-10-06): Clarifications from a cold-read review before handoff: acknowledging by click means the session's own page, not the contact list; a manual `/compact` chimes if the CLI reports its end; a debounce on a reported `Stop` is allowed and is not a timing heuristic; reading the registry to confirm a `Stop` is allowed and is not an event source.
- v1.5 (2026-10-07): Folded in the T-401 hook spike (CLI 2.1.291). Story 2: the turn after a background shell exits chimes (G-003, builder decision); a denied dialog raises no event (assumption, as Esc); `/compact` ends at `PostCompact`; automatic compaction mid-turn raises nothing; note that every subagent now runs in the background. Story 3: a denial sends no hook; plan and bypass modes report dialogs too. Story 6: registry `waiting (dialog open)` is a slash-command panel, not Needs you; a momentary `idle` on a background wake-up is not Finished. "To verify before building" replaced with the measured answers; Constraints note that only the last `--settings` applies.
- v1.6 (2026-10-07): Story 6 replaced (builder decision): when an instance's hooks don't run, a bar on that instance's page says so and alerts stop for it; the registry-driven fallback is dropped.
- v1.7 (2026-10-07): Story 6's bar extends to OpenCode once Story 7 ships (builder decision): a plugin that never reports shows it.
