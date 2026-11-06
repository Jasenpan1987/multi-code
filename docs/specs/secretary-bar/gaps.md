# Secretary Bar Epic — Gaps

Raised in the 2026-11-06 ideation (`docs/timeline/2026-11-06_secretary-bar-ideation.md`).

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-810 | How does the builder listen on the phone? | Tap to listen: the card is on the session screen, Play plays it, one at a time. A listening mode that plays new briefs by itself was offered and not chosen. | 2026-11-06 builder |
| G-811 | Which switch controls briefs for the phone? | The desktop's Secretary Mode, which the phone can also turn on and off. A phone-only switch, always on while a phone is paired, was offered and not chosen. | 2026-11-06 builder |
| G-812 | What does the push say while the secretary is on? | It waits for the brief and carries its first sentence; today's body if the brief fails. Keeping today's push was offered and not chosen. | 2026-11-06 builder |
| G-813 | Replies in words on the phone? | Yes, with the dialog buttons kept, by the desktop's rules. Buttons only was offered and not chosen. | 2026-11-06 builder |
| G-805 | Where does the card sit on the session screen? | First: a bar under the session header (a card inline in the chat was not chosen). Then replaced: one secretary for the whole app, in a bar at the top of the app, desktop and phone (PRD v1.1). | 2026-11-06 builder |
| G-814 | Does a new brief on the session open on the phone play by itself, as the desktop's shown session does? | No. Nothing plays without a tap. With the bar, the desktop follows the same rule. | 2026-11-06 builder |
| G-815 | One secretary for the app, or one per session? | One, in a bar at the top of the app on the desktop and the phone, named by the session of the brief it shows. The per-session desktop card goes. | 2026-11-06 builder |

## Open Gaps

| ID | Question | Impacts | Ask | Status |
|----|----------|---------|-----|--------|
| G-806 | Do playing to the end and "Got it" count as reading a Finished session (red dot, Dock count, phone state)? Decided yes, so the queue empties from the bar alone. | Story 4 | Builder, when they try it | assumed |
| G-801 | Does a brief started by a tap play in the Home Screen app with the iPhone's silent switch on? HTML audio is expected to play like a video; Web Audio may follow the switch. | Story 3 | Measure on the builder's iPhone | open |
| G-802 | Does a playing brief finish when the phone locks or the app goes to the background? iOS closes the link's socket about 31 s after the page goes hidden (mobile-v2 G-301). | Story 3 | Measure on the builder's iPhone | open |
| G-803 | How long does a brief's text take on the builder's default model (Opus 5.5, decisions.md 2026-11-04)? Is 30 s the right cap for the push to wait? | Story 4 | Measure from the secretary's own timings during the work | open |
| G-804 | Which audio format gets to 1 MB per minute or less and plays in iOS Safari? Today's WAV is 2.9 to 5.3 MB per minute. | NFR Data | Built: IMA ADPCM WAV in memory, mono, at most 24 kHz (0.67 to 0.73 MB per minute); plays in Playwright WebKit. `afconvert` needs seekable files, so it would have put audio on disk. A phone that can't play it falls back to 16-bit PCM (2.9 MB per minute) and remembers it. Confirm on the builder's iPhone | built, to confirm |