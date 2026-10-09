# Voice Secretary: the first full day of use

**Date:** 2026-10-09
**Type:** feedback
**Participants:** Jasen (builder), Claude
**Source:** the builder's message in session, after a working day with Secretary Mode on (0.8.0)
**Outcome:** PRD v1.7; tasks T-526, T-527, T-528 in `docs/specs/voice-secretary/kanban.md`

## Summary

Four points, three of them changes:

1. **The shown session never briefed.** While the builder watched a session, its secretary
   stayed silent; only a session in another tab, with its red dot and chime, spoke when
   clicked. The builder wants the secretary to report wherever they are, the shown
   session included. (Cause: the card opened only from a red-dot click, and on the shown
   session any key press clears the dot first; kanban T-525.)
2. **The brief vanished.** Once heard, the text was gone: typing in the terminal cleared
   the event, which dropped the brief and closed the card, and a closed card could not be
   reopened. Replay existed only while the card was open.
3. **Plainer briefs.** The builder asked for the briefs to follow ASD-STE100 Simplified
   Technical English at about 80% strictness: simple words, short sentences, easier to
   take in by ear.
4. **How to reply?** A question, not a change: the reply box on the card is Milestone 2
   (T-509, T-510), not built yet. Until then the builder answers in the terminal.

Not now: pinning the secretary to the top regardless of how many sessions there are. The
builder hasn't decided; nothing changes.

## Decisions

- With Secretary Mode on, a new event on the **shown** session opens its card and plays
  the brief with no click. Other sessions keep the red-dot click, so two secretaries never
  talk at once. Read from "even on the current page"; the red-dot flow for other tabs was
  described as working.
- A brief is **kept** after its event clears, marked handled, until a newer event
  replaces it, the mode goes off or the session is removed. An open card stays open; a
  closed one comes back from a Secretary button in the session header.
- Briefs follow STE's writing rules firmly, without its dictionary, in both languages.
