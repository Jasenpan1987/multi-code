# Decisions Log — Multi-Code

Append-only log of architectural and product decisions. Each entry: date, decision, rationale, source. Newest first.

---

## 2026-10-10 — A wider choice is confirmed with a bare yes before the secretary presses it

**Decision:** When the reply interpreter decides the builder wants "don't ask again" on a permission, or "accept edits without asking" on a plan, the secretary presses nothing. It asks a fixed question naming that exact choice, and presses only if the very next reply is a bare yes ("是", "对", "yes", punctuation aside). Any other reply is read afresh. The model never picks keys: it names an effect or option numbers, and `secretary/dialog.ts` turns them into the key sequences measured on the CLI.

**Why:** Four rounds of cross-model review on 2026-10-10 found a way past each version of a check on the builder's own words: keywords ("automation" matched "auto"), then negation lists ("do not use auto mode", curly apostrophes), then a yes followed by a correction ("Yes, only this once"). Widening a permission is the one mistake that outlives the dialog, so it costs one extra "是".

**Source:** docs/timeline/2026-10-10_reply-key-flows-spike.md; review notes in the T-509 entry of docs/specs/voice-secretary/kanban.md
**Affects:** PRD Story 6 (v1.8); `secretary/dialog.ts` (`checkChoice`, `isPlainYes`), `secretary/index.ts` (`reply`).

---

## 2026-10-09 — The shown session's secretary speaks on its own, and briefs are kept

**Decision:** With Secretary Mode on, a new event on the session on screen opens its card and plays the brief without a click. Every other session still waits for its red-dot click. A brief is no longer dropped when its event clears (the builder typed or answered); it stays, marked handled, and the session header's Secretary button brings it back for reading and replay. Briefs are written to ASD-STE100 Simplified Technical English's rules at about 80% strictness.

**Why:** After a day of use, the builder found the session they were watching never briefed them (any key press cleared its red dot, and only a red-dot click opened a card), and a brief they had heard was gone the moment they typed. Limiting unasked speech to the shown session keeps the original point of the pull model: two secretaries never talk at once.

**Supersedes:** part of 2026-10-07, "speaks only when clicked": that still holds for every session except the one on screen.
**Source:** docs/timeline/2026-10-09_secretary-first-day.md
**Affects:** PRD Stories 2, 3 and 4 (v1.7); `secretary/index.ts` (keeps briefs), `App.tsx` and `secretaryBrief.ts` (when a card opens), the brief prompt (v9).

---

## 2026-10-08 — The speech server detects the brief's language itself

**Decision:** The secretary's speech request no longer sends `language`; Qwen3-TTS uses its default, `Auto`, and detects the language from the text. The brief writer still chooses the brief's language (it follows the builder's latest message), and that choice still picks the tone instruction sent with the text.

**Why:** Chinese briefs keep English technical terms ("eat-what 那边……", PR, NPM), and the builder prefers the engine to judge mixed text itself rather than be forced into one language. Kept after the builder listened to 11 real briefs spoken both ways; revisit if a brief is misread.

**Source:** builder, 2026-10-08, in session.
**Affects:** `workspace/app/src/main/secretary/speech.ts`; `docs/specs/voice-secretary/prd.md` Story 4 (v1.4).

---

## 2026-10-07 — Attachments only when the brief can't carry it

**Decision:** Refines "The secretary's card shows originals" below. The secretary attaches original material only when words can't make it clear, or when the builder needs the exact detail to decide. When the brief alone gets it across, the card has the brief and nothing else. Whatever is attached is still an original, never rewritten.

**Why:** The builder doesn't want detail they don't need: "如果你说话就能直接把这事儿差不多说明白了……就不要放".

**Source:** builder, 2026-10-07, reviewing `docs/specs/voice-secretary/prd.md` (Story 5).
**Affects:** Secretary card content.

---

## 2026-10-07 — The secretary's voice runs on a GPU server, deployed only from official components

**Decision:** Qwen3-TTS-12Hz-1.7B-CustomVoice (voice Serena) runs on an EC2 GPU instance, served by vLLM-Omni's published image with its Qwen3-TTS launch command, behind Caddy at `https://tts.jasenpan.com`. It does not run on the user's Mac. The POC lives in the builder's personal AWS account; moving to the company account swaps Caddy for ALB plus ACM and leaves the model server unchanged.

**Why:** Generating locally peaks at 6–7 GB of memory, which no user can be asked to spare. Alibaba Cloud's hosted Qwen API and fal.ai were rejected: the builder doesn't want Alibaba Cloud, and fal.ai would be a different setup from the eventual company deployment. A hand-written Python wrapper was replaced by vLLM-Omni because the builder requires the vendor-recommended deployment, not a shortcut.

**Source:** docs/timeline/2026-10-07_voice-engine-hosting.md
**Affects:** How Multi-Code produces audio for a brief (an HTTPS call with a bearer key); `docs/specs/voice-secretary/gaps.md` G-003 (company code in a personal account).

---

## 2026-10-07 — The voice secretary is per-session and speaks only when clicked

**Decision:** Every session has its own secretary; there is no single secretary watching all sessions. A secretary speaks only when the builder clicks its red-dot contact with Secretary Mode on, never on its own. It briefs at the moments the CLI answers the builder (turn finished, needs-you), never mid-turn.

**Why:** The builder hears the chime, walks over, and chooses which session to hear, the same way they would tap a message notification on a phone. That makes queueing several talking secretaries unnecessary, and keeps the planned phone flow identical. A per-session secretary follows one session end to end, so it can say what was already tried. Auto-speaking and a single all-sessions secretary were both proposed by the interviewer and replaced by the builder.

**Source:** docs/timeline/2026-10-07_voice-secretary-ideation.md
**Affects:** Contact click behaviour while Secretary Mode is on; when briefs are prepared (at the event, so a click plays at once).

---

## 2026-10-07 — The secretary's card shows originals, and answers go through the secretary

**Decision:** Attachments on the secretary's card are chosen by the secretary but are always originals: the exact command, the question and its options, real code with flagged lines highlighted, reviewer comments verbatim. The builder answers in words in the card's own input box, and the secretary turns the answer into the dialog keystroke. The answer never goes into the terminal as text.

**Why:** The spoken brief simplifies, so the card is what the builder checks it against; if the secretary misreads a command, the original on the card shows it. A CLI dialog takes keystrokes, not words, and text written into a session sitting on a dialog has been observed to select the wrong option.

**Source:** docs/timeline/2026-10-07_voice-secretary-ideation.md
**Affects:** Secretary card UI; how a needs-you answer reaches the session (not through the compose box).

---

## 2026-07-09 — Markdown View is a single-file reader, not a document manager

**Decision:** The "View" toolbox section shows one Markdown file at a time. Opening a new path replaces the current one — no tabs, no open-file list. Open-path state is per-instance and follows the selected instance.

**Why:** The core use is glancing at an `.md` an agent just generated, not curating a multi-doc workspace. The right column is narrow; tabs would crowd it against the compact layout. Per-instance state is mandatory because relative paths must resolve against each instance's own cwd — a global "current file" would resolve the wrong directory.

**Source:** 2026-07-09 markdown-view ideation.
**Affects:** View section UI; Toolbox state (a per-instance open-path map alongside `expandedByInstance`).

---

## 2026-07-09 — Markdown View renders `.md`/`.markdown` only

**Decision:** View renders only files with a `.md` or `.markdown` extension. Any other extension (`.txt`, `.json`, no extension, a directory) is refused with a plain inline error, not displayed. Files over ~2MB are also refused.

**Why:** The real trigger is always "an agent produced a Markdown file and returned its path". A plain-text branch (rendering `.txt` as text) was considered and cut — it's effort spent on a case that doesn't occur. The size cap prevents a large log accidentally opened as markdown from freezing the UI. Extension and size are checked in the main process (in the `read-file` handler) so illegal cases never reach the renderer.

**Source:** 2026-07-09 markdown-view ideation.
**Affects:** `read-file` IPC handler validation; View error states.

---

## 2026-07-09 — Markdown View includes math and Mermaid in MVP

**Decision:** MVP rendering is react-markdown + remark-gfm + remark-math + rehype-katex (math) + Mermaid (diagrams). A Mermaid block that fails to render degrades to a plain code block showing its raw definition, and must never crash the document. Raw HTML embedded in markdown is not executed (react-markdown stays on its safe default, no `rehype-raw`).

**Why:** Agent output frequently contains LaTeX math and Mermaid diagrams; rendering plain markdown without them would miss the builder's actual content. KaTeX is a cheap synchronous plugin pair; Mermaid is a heavier async runtime, hence the explicit failure-degradation rule. Disabling raw HTML keeps a markdown file from injecting scripts into the renderer.

**Source:** 2026-07-09 markdown-view ideation.
**Affects:** renderer dependencies (adds react-markdown, remark-gfm, remark-math, rehype-katex, katex, mermaid); View rendering component.
