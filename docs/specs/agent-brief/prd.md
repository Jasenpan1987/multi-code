# PRD: Agent Brief

**Version:** 1.1
**Last Updated:** 2026-11-07
**Status:** approved by the builder 2026-11-07 ("可以可以，你建吧，我同意"; the fork over a summary at the end of every reply; efforts and voice at review)
**Owner:** Jasen

## Overview

The brief for a Claude session comes from the agent that did the work. The moment a turn
ends, Multi-Code forks that session, asks the agent for a spoken summary, and gets it back
in about 15 seconds. The agent knows the whole session, so the brief says what matters, not
only what fits in the last 60,000 characters. The session, its screen and its files are not
touched. Where a fork can't run well, today's brief writer writes the brief, at an effort
level chosen for accuracy.

## Background & Context

- **The builder finds the briefs too shallow** (2026-10-28) and wants the working agent to
  report: "我其实现在有点偏向于让干活的 agent 自己汇报". Not by reading its last reply aloud,
  which can run to several minutes, but as a summary: "直接让他对刚才做的这件事做个总结".
  (source: `docs/timeline/2026-11-07_agent-brief-spike.md`)
- **Today's writer is an outsider.** One `claude -p` per event, with no tools and no
  memory, reads the builder's last messages and the turn cut from the front to 60,000
  characters, and is told to retell in its own words in 30 to 45 seconds. On the
  secretary-bar release session it kept 86 of 279 entries and left out the first of the two
  tasks. (source: same)
- **Today's writer is slow.** Since 2026-11-04 it names no model, so it runs with the
  builder's defaults, Opus 5.5 at `xhigh` effort. It took 28.7 s on the release session,
  2,564 of its 2,834 output tokens thinking. The voice-secretary PRD promises text within
  10 s; secretary-bar's push waits up to 30 s for it (G-803 there). The builder: "这个完全
  无法接受，太慢了". (source: same; `docs/knowledge/decisions.md` 2026-11-04)
- **Accuracy comes first.** On lowering effort: "我还是需要准确性，慢一点就慢一点。我们不是光为了
  提速就要丧失准确性". (source: builder, 2026-11-07, in session)
- **A fork works.** `claude --resume <id> --fork-session --no-session-persistence` answered
  from the whole conversation, wrote nothing, and with every tool call blocked by a hook,
  changed nothing. With the session's cache warm it cost $0.058 and took 13 to 16 s on a
  119k to 145k context. Cold, on a 435k context, it cost $2.12 and took 26.7 s.
  (source: `docs/timeline/2026-11-07_agent-brief-spike.md`)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen | Steps away while sessions work; hears briefs from the bar on the desk or the phone (secretary-bar); runs Claude sessions at the effort and model they choose |

## Terms

- **Brief, Secretary Mode, Finished, Needs you, the bar:** as in
  `docs/specs/voice-secretary/prd.md` and `docs/specs/secretary-bar/prd.md`.
- **Agent brief:** a brief written by a fork of the working session.
- **Fork:** a one-off copy of a session's conversation in a separate `claude` process. It
  answers one request and exits. It saves nothing and can't run tools.
- **Today's writer:** the outsider brief writer of the voice secretary
  (`main/secretary/briefWriter.ts`). In this epic it is the fallback.
- **Warm cache:** the provider still holds the prompt cache of the session's last request,
  which it keeps for 5 minutes. A fork then pays for the new part only.

## User Stories

### Story 1: The agent sums up its own turn

**As a** builder away from the screen
**I want** a Claude session's Finished brief to come from the agent that did the work
**So that** it tells me everything that matters in the turn, not only its last part

**Acceptance Criteria:**
- [ ] With Secretary Mode on, when a Claude session's turn ends, Multi-Code starts a fork of
      that session within 1 s, unless Story 3 sends the brief to today's writer.
- [ ] The fork runs on the same model and effort as the session's last request, as the
      session's record shows them, so a model or effort the builder changed mid-session is
      followed.
- [ ] The fork reads the session's cache: on the spike's warm case its cost stays within
      twice the measured $0.058, and its cache read covers at least 90% of the context.
- [ ] The brief is in the agent's own voice ("I", "我"), about 30 to 45 seconds spoken, with
      today's rules for the ear: no paths, code, URLs, ids or command lines; the language of
      the builder's latest message; Simplified Technical English style. (Builder,
      2026-11-07, G-906.) Fallback briefs from today's writer stay in the third person.
- [ ] On the release-session sample, the brief names both tasks of the turn. On the eval set
      (Story 5), agent briefs score at least as accurate as today's writer at `xhigh`.
- [ ] The brief reaches the bar, the push and the speech server exactly as a brief from
      today's writer does. The bar, the queue and the replies don't change.

**Notes:** The request asks for "what you did since my last message, what matters most",
not for the last step. Asking it to answer at once cut its thinking by about 40% in the spike.

### Story 2: The agent explains its own dialog

**As a** builder away from the screen
**I want** a Needs-you brief to come from the agent that is stopped on the dialog
**So that** it says why it needs this step, not only what the command is

**Acceptance Criteria:**
- [ ] When a Claude session stops on a dialog (a permission, AskUserQuestion, ExitPlanMode),
      the brief comes from a fork, under Story 1's rules for model, effort, cache and voice.
- [ ] The brief says what the agent is doing, why it needs this step, what the operation
      will actually do (and says so when it deletes, overwrites, pushes, installs, or reaches
      outside the project), and the question with its options and the agent's
      recommendation, as today's writer must.
- [ ] The fork never answers the dialog and never touches the session: the dialog is still
      open, unchanged, when the brief is ready.
- [ ] Replies in words keep working as they do today (voice-secretary Story 6).

**Notes:** Not measured yet (G-901). If a fork can't brief a dialog well, Needs you stays
with today's writer and this story is dropped.

### Story 3: Today's writer when a fork can't do it well

**As a** builder
**I want** every event to still get a brief when a fork would be slow, costly or impossible
**So that** I am never left without one

**Acceptance Criteria:**
- [ ] Today's writer writes the brief when:
  - the session's last request is older than the cache keeps it (⚠️ Assumption: 4 minutes,
    for a 5-minute cache; G-904), for example when Secretary Mode is turned on with events
    already waiting;
  - the session is an OpenCode session (G-902);
  - the session's record can't be read, or shows no model or effort;
  - the fork fails, or has given no brief 30 s after it started.
- [ ] A brief that falls back is not marked differently on the bar. ⚠️ Assumption.
- [ ] A fork that is stopped (a newer event, Secretary Mode off, the session removed) is
      killed, as today's writer's call is, and nothing it returns is used.
- [ ] One brief per event, as today: a fallback after a failed fork is the only second call.

### Story 4: A fork leaves nothing and changes nothing

**As a** builder
**I want** a fork to leave no trace and change nothing
**So that** my sessions, files and other tools behave as if the secretary weren't there

**Acceptance Criteria:**
- [ ] Every tool call in a fork is blocked before it runs. A fork asked to write a file and
      run a command leaves no file and runs nothing.
- [ ] After a fork, the project's files and git state, the project's session files and the
      builder's Claude settings are unchanged. Nothing new stays under `~/.claude` (G-907).
- [ ] The fork raises no Finished or Needs-you of its own on the bar, in the sidebar or as a
      push.
- [ ] The fork's input reaches the CLI on stdin, never in argv, as today.
- [ ] A fork asks no one to log in: an expired login fails the fork and today's writer takes
      over.

### Story 5: Today's writer at an effort chosen for accuracy

**As a** builder
**I want** today's writer to run at the lowest effort that is as accurate as `xhigh`
**So that** fallback briefs come fast without missing or getting wrong what matters

**Acceptance Criteria:**
- [ ] Today's writer names its effort in its flags, never the builder's default: `low` for a
      Finished brief, `high` for a Needs-you brief. (Builder, 2026-11-07, from the eval.)
- [ ] Every other flag stays, and no model is named (decisions.md 2026-11-04).
- [ ] The reply interpreter (voice-secretary Story 6) is not changed by this story.
- [ ] Re-run on the eval inputs after the change: Finished briefs score at least as accurate
      as `xhigh` did, dialog briefs as `high` did, and a Finished brief is ready in about 8 s
      alone (7.4 s measured).

**Notes:** The eval (timeline, "Effort eval"): 8 real inputs, 4 efforts, 2 runs each, judged
blind. No level was more accurate overall; higher effort only thought longer (0 to 1,886
thinking tokens). On dialogs, `high` and `xhigh` scored 5 on all six runs; `low` once said a
command that only edits files "runs the tests". A wrong dialog brief can lead to a wrong
approval, so dialogs get `high`. Applies on its own, before the fork stories.

## Non-Functional Requirements

- **Performance:** an agent brief's text is ready within 15 s of the event on a warm cache
  (measured 13.2 to 15.6 s). Today's writer: a Finished brief in about 8 s at `low` (7.4 s
  measured alone), a Needs-you brief at `high` (18.7 s measured four at a time; alone not
  measured).
  Speech adds about 0.4 s per second of audio, about 12 to 18 s for a 30 to 45 s brief; not
  changed here.
- **Accuracy:** above speed, on the builder's word. No change ships that scores lower than
  today's writer at `xhigh` on the eval set.
- **Cost:** a warm fork costs about the same as today's writer or less ($0.06 to $0.07
  measured at 119k to 145k, about $0.2 expected at 400k+, G-903). No fork runs on a cold
  cache.
- **Privacy:** the fork sends the session's conversation to the same provider and model the
  session already uses. Nothing is written to disk. The brief stays in memory, as today.

## Technical Constraints

- Report-only (CLAUDE.md "Architecture"): the working session gets no keys, no input, no
  settings and no hooks. Only the fork's own process gets the blocking hook.
- The fork must start with the same tools, model and effort as the session's last request,
  or it loses the cache (measured).
- Claude Code CLI with `--resume`, `--fork-session` and `--no-session-persistence` in print
  mode; measured on 2.1.319.
- OpenCode briefs keep using `claude -p` (decisions.md 2026-11-04, "The secretary needs
  Claude Code").

## Dependencies

- Voice secretary and secretary-bar: the brief's states, the bar, the push, the speech
  server.
- The provider's prompt cache (5 minutes on Bedrock as measured).
- The session's record (`~/.claude/projects/…/<session>.jsonl`) for the last request's model
  and effort.

## Out of Scope

- The agent adding a spoken summary to the end of its own replies (the builder chose the
  fork, 2026-11-07).
- Reading the agent's whole last reply aloud.
- Talking with the fork: follow-up questions go to the session as today.
- Longer briefs, or "continue" for more. The length stays as today (G-906).
- Faster speech.
- A fork of an OpenCode session, unless G-902 finds one that writes nothing.

## Open Questions

Full tracking: `docs/specs/agent-brief/gaps.md`. Key ones:
- G-901: does a fork brief a dialog well while the dialog is open?
- G-902: can an OpenCode 2 session be forked with nothing saved?
- G-903: warm cost and time on 400k+ contexts.
- G-904: how long after a session's last request is the cache still warm?
- G-907, G-908: does a fork leave anything behind, and do the builder's own hooks run in it?

## Success Metrics

- The builder no longer calls the briefs shallow: a Finished brief names every task of a long
  turn.
- Agent briefs are ready within 15 s of the event, and today's writer within the time its
  chosen effort allows, against 28.7 s on 2026-11-07.
- No fork ever changes a file, a session or a setting.
- A typical agent brief costs no more than today's brief.

## Changelog

- v1.1 (2026-11-07): Story 5 gets its efforts from the eval (`low` for Finished, `high` for
  Needs you); Story 1's voice and length confirmed (first person, 30 to 45 s). G-905 and
  G-906 closed. Both by the builder at review.
- v1.0 (2026-11-07): First draft, from the 2026-11-07 fork spike and the builder's choices.
