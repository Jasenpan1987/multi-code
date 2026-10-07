# PRD: Voice Secretary

**Version:** 1.2
**Last Updated:** 2026-10-07
**Status:** approved
**Owner:** Jasen

## Overview

The builder wants agents to keep working while they are away from the screen, washing dishes
or doing other chores. Each Claude Code session gets a secretary. When the session finishes
or needs the builder, the usual chime and red dot fire; with Secretary Mode on, clicking the
contact has the secretary brief the builder out loud, the way a secretary briefs a CEO: a
retold account with the details, not the screen read aloud. When words aren't enough, a
card shows the original material, and the builder can answer a dialog in plain words, which
the secretary turns into the right choice.

The voice is optional. With no speech server, the secretary still writes its briefs and the
card shows them as text.

(source: docs/timeline/2026-10-07_voice-secretary-ideation.md,
docs/timeline/2026-10-07_voice-engine-hosting.md)

## Background & Context

- **The moments already exist.** Claude instances report Finished and Needs-you through
  report-only hooks (`docs/specs/attention-alerts/prd.md`). The secretary speaks at those
  moments and no others. (source: docs/timeline/2026-10-07_voice-secretary-ideation.md)
- **The dialog's contents are already parsed.** A Needs-you from a permission request,
  `AskUserQuestion` or `ExitPlanMode` carries the tool, the question and the option list
  (`workspace/app/src/main/remote/promptExtract.ts`, built for the phone link).
- **Answering by option already exists.** The phone link answers a dialog by option index:
  `keystrokeForChoice` maps it to the CLI's number keys and refuses when the dialog has
  cleared (`workspace/app/src/main/remote/ws-server.ts`, `choose`). Writing free text into a
  session that sits on a dialog has been observed to select the wrong option, which is why
  answers never go into the terminal as text. (source:
  docs/knowledge/decisions.md, 2026-10-07)
- **The voice is decided.** Qwen3-TTS, voice Serena for Chinese and English, served from a
  GPU server through an OpenAI-shaped speech API. Generating locally peaks at 6–7 GB of
  memory, so it never runs on the user's Mac. The server is reproducible from
  `deploy/tts-server/`. (source: docs/timeline/2026-10-07_voice-engine-hosting.md)
- **Mixed Chinese and English is the weak spot of every voice engine**, so the brief is
  written to be spoken: acronyms and symbols spelled the way they should sound. (source:
  docs/timeline/2026-10-07_voice-engine-survey.md)
- **The brief writer is decided: Claude Sonnet 5.5 on the company's Bedrock**,
  `global.anthropic.claude-sonnet-5-5`, through the same Bedrock access Claude Code uses on
  the builder's Mac (the AWS profile and region set in `~/.claude/settings.json` `env`). A test call from the Mac
  answered in 1.7 s on 2026-10-07. There is no `au.` profile for this model, so requests
  may be served outside Australia; another of the builder's services calls Haiku the same `global.` way.
  (source: `docs/specs/voice-secretary/gaps.md`, G-002)

## Users & Stakeholders

| Role | Who | How they use it |
|---|---|---|
| Builder | Jasen | Turns Secretary Mode on, steps away, comes back at a chime, clicks, listens, answers in words with their own dictation software |
| Guest at the keyboard | Someone demoing on the builder's machine, possibly English-speaking | Same flow; hears briefs in the language they typed in |

## Definitions

| Term | Meaning |
|---|---|
| Secretary | The per-session role that writes a brief for one event and acts on the builder's answer to it |
| Secretary Mode | A global toolbox switch. On: clicking a red-dot contact plays its brief. Off: today's behaviour |
| Brief | The secretary's retelling of one event, in text and, when a speech server is available, audio |
| Card | The panel that opens with a brief: the brief text, the attachments, and for a dialog, a reply box |
| Attachment | Original material on the card: never rewritten |
| Speech server | An HTTPS endpoint with the OpenAI speech API shape and a bearer key, such as one built from `deploy/tts-server/` |

## User Stories

### Story 1: Secretary Mode switch

**As a** builder
**I want** one switch that turns the secretary on before I step away and off when I'm back
**So that** clicking a contact only talks when I want it to

**Acceptance Criteria:**
- [ ] The toolbox has a Secretary Mode switch. It applies to every session, not one
- [ ] With it off, clicking any contact behaves exactly as today, no brief is prepared, and no language model or speech server is called
- [ ] With it on or off, chimes, red dots and the Dock bounce behave as today
- [ ] Turning it off while a brief is playing stops the audio and closes the card
- [ ] turning it on prepares briefs straight away for sessions that already show a red dot
- [ ] its state survives a restart of Multi-Code, like the other settings

---

### Story 2: The brief is ready before the click

**As a** builder
**I want** the brief prepared the moment the alert fires
**So that** when I walk over and click, it plays at once

**Acceptance Criteria:**
- [ ] While Secretary Mode is on, every Finished or Needs-you event from a Claude Code instance starts that session's brief right away, text first, then audio
- [ ] One brief per event. A newer event for the same session replaces the older brief
- [ ] If the alert clears before the builder clicks (they answered in the terminal or on the phone), the brief is dropped and never plays
- [ ] OpenCode instances get no brief and behave as today
- [ ] the manager instance gets no secretary in v1
- [ ] If writing the brief fails, the card still opens with its attachments and one line saying no brief could be written

---

### Story 3: Click a red dot, hear the brief

**As a** builder
**I want** to choose whose brief I hear by clicking, like tapping a message notification
**So that** several sessions waiting at once never talk over each other

**Acceptance Criteria:**
- [ ] With Secretary Mode on, clicking a red-dot contact switches to it as today, opens its card and starts playing the brief
- [ ] Clicking a contact without a red dot opens no card and plays nothing
- [ ] If the brief isn't ready, the card says it is being prepared and starts playing when it is, unless the builder has clicked another contact by then
- [ ] Only one brief plays at a time. Clicking another red-dot contact stops the current one and starts the new one
- [ ] the card has replay and stop
- [ ] Nobody hears anything until they click: the secretary never speaks on its own

---

### Story 4: What the secretary says

**As a** builder who isn't looking at the screen
**I want** a retold account of what happened, in my language
**So that** I can decide without reading the terminal

**Acceptance Criteria:**
- [ ] Every brief opens with the session's name ("MSK 那边……")
- [ ] **Finished:** what was asked, what was done, whether it worked or couldn't be done, and anything left for the builder. Retold in the secretary's own words, not Claude's reply read out
- [ ] **Needs you, permission:** what the agent is doing and why, what the operation does in plain words, then the question. "Needs to run a shell script, allow?" alone is not enough
- [ ] **Needs you, decision:** the question and each option in plain words
- [ ] Never anything from the middle of a turn: no "reading file X", no "trying another approach"
- [ ] **Language follows the builder's latest message in that session.** Pure English gets an English brief; Chinese or mixed gets a Chinese brief that keeps English technical terms as they are. No setting overrides it
- [ ] The language the brief is written in is the language sent to the speech server
- [ ] The voice is Serena in both languages
- [ ] Written to be heard: no code blocks, tables or long paths; acronyms and symbols written the way they should sound
- [ ] a brief normally runs under a minute when spoken

---

### Story 5: Show the original only when words aren't enough

**As a** builder
**I want** the real thing on the card only when the brief can't carry it
**So that** I'm not buried in detail I don't need, and when the detail matters I see it unaltered

**Acceptance Criteria:**
- [ ] The card always shows the brief text, marked as the secretary's
- [ ] The secretary attaches something only when words can't make it clear, or when the builder needs the exact detail to decide. When the brief alone gets it across, the card has no attachment
- [ ] Whatever it attaches is original material, never rewritten: the exact command for a permission, the question and its options for a decision, Claude's final reply for a finish, a reviewer's comment word for word
- [ ] When the event is about specific code, such as a reviewer flagging a function, the attachment is that code read from the file on disk, with its path and line numbers, and the flagged lines highlighted. If the file can't be read, the card says so instead
- [ ] An image the agent itself produced in that turn can be attached as it is. No other screenshots are taken
- [ ] Code is shown as highlighted text, not as an image

---

### Story 6: Answer a dialog in words

**As a** builder with wet hands and a dictation app
**I want** to say "是的" and have the secretary pick the right option
**So that** I never have to find the right key in the terminal

**Acceptance Criteria:**
- [ ] A Needs-you card has its own reply box. It is not the compose box, which writes straight into the terminal
- [ ] Whatever the builder types or dictates there, the secretary maps to the dialog: allow, deny, a numbered option, or "Other" followed by their text
- [ ] It picks "don't ask again" only when the builder clearly asks for it ("以后都可以")
- [ ] After acting, the card shows one line saying what it did ("已经给 MSK 权限了")
- [ ] When the reply could mean more than one thing ("嗯，再说吧"), it asks back and presses nothing
- [ ] When the reply is a question rather than an answer ("这个脚本会删什么？"), it answers from what it knows and presses nothing.
- [ ] If the dialog has gone or changed by the time the builder replies, it says so and presses nothing
- [ ] If the choice can't be mapped to a key it trusts, it says so and points to the terminal, the same refusal the phone link gives
- [ ] a Finished card has no reply box in v1; the builder replies in the terminal as today

---

### Story 7: No voice, still a secretary

**As a** builder whose speech server is stopped, unreachable or deleted
**I want** Secretary Mode to keep working as text
**So that** the app never depends on that server

**Acceptance Criteria:**
- [ ] With no speech server configured, or one that fails, errors or doesn't answer in time, the card shows the brief text and plays nothing, with a small note that the voice is unavailable
- [ ] No error dialog, no retry storm, and nothing else in the app changes: chimes, red dots, terminals, the manager and the phone link behave as before
- [ ] When the server comes back, the next brief speaks again without a restart
- [ ] "in time" is 15 seconds for the audio of one brief

---

### Story 8: Connect a speech server

**As a** builder, or someone who built their own server from `deploy/tts-server/`
**I want** to point Multi-Code at a speech server
**So that** the voice isn't tied to one person's machine

**Acceptance Criteria:**
- [ ] Settings take a server address and a key. Leaving them empty is valid and means text only
- [ ] The key is stored only on this machine, in Multi-Code's own data folder, is never shown in full after it is saved, and never appears in logs
- [ ] A test button reports whether the server is reachable, the key is accepted, and a short sample comes back, with the reason when it isn't
- [ ] Any server with the OpenAI speech API shape and a bearer key works, not only `tts.jasenpan.com`

---

## Non-Functional Requirements

- **Cost:** none while Secretary Mode is off. While on, one brief per alert: one language-model call and, when a speech server is set, one speech request.
- **Speed:** a click on a ready brief starts audio within a second. A brief is normally ready within 20 seconds of its alert; the speech server takes 5–6 seconds for a ~13 second brief (source: docs/timeline/2026-10-07_voice-engine-hosting.md).
- **Privacy:** transcript excerpts go only to the language model that writes the brief; the brief text goes only to the configured speech server. Briefs and audio are kept in memory and not written to disk.
- **Zero residue:** unchanged. Nothing is written to files the user owns (docs/knowledge/business-overview.md, Zero-residue principle).

## Technical Constraints

- **The app spawns CLIs directly, with no SDK or bridge** (`CLAUDE.md`, Architecture). The CLI can do this job without leaving anything behind: `claude -p --bare --no-session-persistence --model global.anthropic.claude-sonnet-5-5 "<prompt>"` skips hooks, plugins and auto-memory and writes no session to the builder's history. Measured on 2026-10-07: 3.3 s end to end for a one-line brief, against 1.7 s for a direct Bedrock call; the gap doesn't matter for a brief prepared ahead of the click. Calling Bedrock directly, as another of the builder's services does with `@ai-sdk/amazon-bedrock`, would be the project's first SDK. Decided by the builder on 2026-10-07: the brief writer is a spawned `claude` CLI, slower is fine.
- **No credentials of its own.** The brief writer uses the Bedrock access already configured for Claude Code on the machine; Multi-Code asks for no AWS keys.
- **Hooks stay report-only.** The secretary never answers a dialog through a hook decision; it answers the way the phone link does, by option key.
- **Answering depends on a UI convention.** The CLI's option boxes taking number keys is not an API; a CLI release can break it (`workspace/app/src/main/remote/promptExtract.ts`). Story 6's refusal is the safety net.
- **The speech API is the OpenAI shape**, as served by vLLM-Omni: `POST /v1/audio/speech`, bearer key, audio in the response body (`deploy/tts-server/README.md`).
- **During the POC the speech server sits in a personal AWS account**, so Secretary Mode is used on personal projects only (`docs/specs/voice-secretary/gaps.md`, G-003).

## Dependencies

- Attention Alerts, Claude track: the Finished and Needs-you events and their prompt detail (`docs/specs/attention-alerts/prd.md`).
- Phone link: option-to-keystroke answering (`keystrokeForChoice`).
- A speech server for the voice: `deploy/tts-server/`. Not needed for text-only.
- Claude Sonnet 5.5 on the company's Bedrock, for writing briefs.

## Out of Scope

- Mid-turn narration, and asking the secretary for progress on demand.
- Speech recognition inside Multi-Code; the builder uses their own dictation software.
- Delivery to the phone, SMS or iMessage. The phone keeps the same pull model when it comes.
- OpenCode sessions, as a later track that may work differently.
- Generating audio on the user's Mac.
- A designed English female voice; Serena speaks both languages.
- Use on company projects during the POC.

## Open Questions

None. The defaults first proposed as assumptions (switch behaviour, no manager secretary,
replay and stop, brief length, a question back, no reply box on a Finished card, the 15 s
and 20 s limits, nothing on disk) were confirmed by the builder on 2026-10-07.

## Success Metrics

- The builder runs two or more sessions for a working session away from the screen and
  handles every Needs-you from its card, without touching the terminal.
- No wrong option is ever pressed: every action the secretary takes matches what the
  builder meant, and every unclear reply is asked back.
- With the speech server stopped, a full session in Secretary Mode works as text with no
  error shown anywhere else.

## Changelog

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-07 | First draft, from the ideation interview, the voice-engine survey and the hosting POC |
| 1.1 | 2026-10-07 | Story 5: attach originals only when words aren't enough (builder). Brief writer decided: Claude Sonnet 5.5 on the company's Bedrock (G-002) |
| 1.2 | 2026-10-07 | All assumptions confirmed by the builder; the brief writer is a spawned `claude` CLI. Approved for task breakdown |
