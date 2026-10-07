# Voice Secretary — ideation

**Date:** 2026-10-07
**Type:** ideation
**Participants:** Jasen (builder), Claude
**Source:** interview in session; the builder is the only participant
**Outcome:** new epic `docs/specs/voice-secretary/`

## Summary

The builder wants to keep agents working while they are away from the screen, washing
dishes or doing other chores. Each session gets a secretary that, when the session
finishes or needs the builder, briefs them by voice the way a secretary briefs a CEO: a
narrated account with the details, not the screen read aloud. It is pull-based: the
chime and red dot fire as today, and clicking the contact plays the brief. The builder
answers by dictating into an input box on the secretary's card, and the secretary turns
the answer into the right dialog choice. v1 is Mac-only; the voice engine is still open.

## Key Decisions

- **v1 plays audio from the Mac only.** Phone delivery comes later, once the phone link
  works again. — builder. Reason: the phone side has problems right now.
- **One secretary per session**, not one secretary watching every session. — builder.
  The reason recorded here (it follows one session end to end, so its brief can be
  specific about what was tried) was offered by the interviewer and not contested.
- **Pull, not push.** A secretary speaks only when the builder clicks its contact. With
  several waiting, the builder picks which one to hear, so there is no queue to design.
  The planned phone flow is the same: a notification from, say, HR's secretary, tap it,
  it plays, then the attachments arrive. — builder.
- **It speaks at the moments the CLI answers the builder**: the turn finished (done, or
  can't be done) and needs-you (a decision or a permission). No mid-turn narration ("I'm
  reading file X", "line 3 should be a while loop"). No on-demand "how's it going"
  either. — builder.
- **Secretary Mode is a global toggle in the toolbox.** On: clicking a red-dot contact
  plays its brief. Off: today's behaviour, clicking only switches to the session. —
  proposed by the interviewer, confirmed by the builder ("exactly").
- **The brief is prepared when the event fires**, while Secretary Mode is on, so a click
  plays it at once. Accepted cost: briefs the builder never listens to still cost
  tokens and audio. — interviewer's call, stated, not objected to.
- **Detailed over terse.** "Agent needs to run a shell script, allow?" is not enough to
  decide on. The brief names the session, what it is doing and why, and what the
  operation does in plain words. — builder ("说细一点").
- **The secretary chooses the attachments; every attachment is an original.** The exact
  command, the question and its options, the real code from the file with the flagged
  lines highlighted, a reviewer's comment verbatim, an image the agent itself produced.
  The secretary never rewrites them. Reason: the spoken brief simplifies, so the card is
  what the builder checks it against; a misunderstanding in the brief is caught on the
  card. — rule proposed by the interviewer, agreed by the builder.
- **Code is shown as highlighted text, not a screenshot.** — interviewer, accepted.
- **No speech recognition in Multi-Code.** The builder uses their own dictation software
  to fill an input box on the secretary's card ("是的"). The secretary interprets the
  sentence and makes the matching choice: approve, deny, pick an option, or "Other" plus
  the text. It confirms what it did ("permission given to MSK") and asks back when the
  answer is ambiguous ("嗯，再说吧"). — builder.
- **The card's input box is not the compose box.** The compose box (Cmd+L) writes
  straight into the terminal. A CLI dialog takes keystrokes, not words, and writing text
  into a session sitting on a dialog has been observed to select the wrong option. —
  interviewer, accepted.
- **If the dialog is gone by the time the builder answers** (they answered it in the
  terminal, say), the secretary says so and presses nothing. — confirmed in the final
  reflect-back.
- **Claude Code first; OpenCode follows as its own track**, and the two may be
  implemented differently. — builder.
- **The voice must sound like a real person.** macOS's built-in Mandarin voice was
  rejected after the builder heard it (`say -v Tingting "…"`). — builder.
- **Models, both the voice and the language model that writes the brief, should
  preferably be on AWS Bedrock**, else a common open-source model, else a small model
  running locally. — builder.

## Facts Learned

- This Mac ships zh_CN voices for `say` (Tingting, plus Eddy, Flo, Reed and others);
  `say -v '?'` lists them. Tingting is below the bar.
- The secretary has two existing pieces to build on: report-only hooks already deliver
  finished and needs-you as events (`docs/specs/attention-alerts/prd.md`), and
  `Backend.readTranscript` reads a session's transcript for either backend
  (`docs/specs/manager-agent/prd.md`, R1).

## Out of Scope for v1

- Mid-turn progress narration, and on-demand progress questions.
- Speech recognition or spoken replies inside Multi-Code.
- Phone app, SMS, or iMessage delivery. Sending iMessage through the Mac's own Messages
  app was noted as a candidate for step two.
- OpenCode sessions.

## Open Questions

- [ ] Which voice engine? — impacts naturalness, latency, cost, and whether brief text
      leaves the machine. A survey of Bedrock / AWS, open-source, and local options was
      started in this session.
- [ ] Which language model writes the brief? — Bedrock preferred; impacts cost per brief.

Not discussed, left to the PRD: brief length, replay and stop controls, where the card
sits relative to the terminal.

## Assumptions

- The secretary is a separate role from the manager agent. It acts only on its own
  session, and only to answer a pending dialog on the builder's instruction; it does not
  dispatch work. Not discussed.
- Claude-first is staged delivery, not an exception to behavioral parity
  (`docs/knowledge/business-overview.md`, 2026-05-18), the same pattern as the
  attention-alerts delivery tracks.

## New Terms

| Term | Meaning | Example |
|------|---------|---------|
| Secretary | The per-session agent that briefs the builder by voice and acts on their answer | "MSK 那边有事找你：它想先删掉 dist 文件夹再重新打包……" |
| Secretary Mode | Global toolbox toggle; on, a click on a red-dot contact plays its brief | Turned on before stepping away to wash dishes |
| Brief | The spoken report for one event | "审查的 agent 觉得 `saveOrder` 并发时可能存两遍订单，它也不确定，要改吗？" |
| Attachment | Original material shown on the secretary's card | The flagged function, risky lines highlighted, plus the reviewer's comment |
