# Decisions Log — Multi-Code

Append-only log of architectural and product decisions. Each entry: date, decision, rationale, source. Newest first.

---

## 2026-10-28 — A file dropped on Multi-Code is copied into the project, and nothing more

**Decision:** A file (or folder) dragged from Finder onto any part of the window is copied into the selected session's project, to that project's default folder or to a folder picked for this drop only. Multi-Code never types into the session afterwards; the builder tells the session, as today. v1 takes Finder drags only, and every file type.

**Why:** The builder's current way is "Go to Code Base", then a drag inside VS Code. Placing the file is the whole job. Writing into the session would tie the feature to the session's state, and a write into a session waiting on a dialog can answer it. Copying does not look at the file type, so a type list would only be extra work.

**Source:** 2026-10-28 file-drop ideation.
**Affects:** a drop handler in the renderer; a copy IPC in main; the preload (`webUtils.getPathForFile`).

---

## 2026-10-28 — Each project has its own default drop folder, which the builder picks

**Decision:** The default drop folder is per project, keyed by the project directory (cwd), so two contacts on one project share it. The first drop in a project says there is no default folder yet and opens a folder picker; the folder picked becomes the default, and the files go there. Every later drop confirms the folder. "Choose another folder" applies to that drop only; "Change default path" changes the project's default. Multi-Code finds no folder by itself, and nothing depends on OMT.

**Why:** Project layouts differ, so one global path would put files in the wrong place. The builder knows where a project's files belong; the OMT input folder is only one example of a folder they pick. (A look-up order from OMT folders was recorded first and corrected by the builder in the same session.)

**Source:** 2026-10-28 file-drop ideation.
**Affects:** a per-project folder map in the persisted settings; the drop confirmation.

---

## 2026-10-27 — Multi-Code moves an OpenCode terminal's view with keys it binds there

**Decision:** To show a finished turn's conclusion from its first line in OpenCode, Multi-Code binds one more key each to OpenCode's own `session.last` and `session.message.previous`, only in the terminals it starts (`OPENCODE_CLI_CONFIG_CONTENT`, after the builder's own keys for those commands), and sends those keys itself. The keys are Cmd+Ctrl+Option+Shift+F11/F12, which no keyboard can send into Multi-Code's terminal. They go through their own IPC, not as input: the run state, the secretary's event and the phone's badge stay as they are. The TUI plugin stays report-only.

**Why:** OpenCode draws on the alternate screen and scrolls itself, so the terminal can't be scrolled the way Claude's classic renderer is. Its "previous message" command, pressed at the bottom, puts the last message with text (the conclusion) at the top. Multi-Code already passes a per-process key setting there (Ctrl+Z off).

**Alternatives considered:** the TUI plugin runs the commands itself (`ctx.keymap.dispatch`): no writes to the terminal, but the plugin would navigate, against its report-only rule.

**Consequences:** before pressing anything Multi-Code reads OpenCode's screen: a conclusion already on screen, or "Jump to latest ↓" (the builder scrolled up during the turn) on a terminal shown as the turn ended, means no keys. A look that finds no conclusion afterwards goes back to the bottom. A turn ending moves nothing unless it is the contact's own session and that session is on screen: OpenCode's finish names its session, so a background tab finishing, or the terminal on a subagent's session, one another contact holds, or home, gets no keys. A jump still waiting for the screen stops when the builder presses a key, clicks or scrolls in the terminal, or the next turn starts; mouse motion, focus reports and xterm's replies to OpenCode's queries don't stop it. Measured on 2.0.32 with an isolated service: shown, out of sight, the turn after a jump, a short answer and a mid-turn PageUp all behaved as above.

**Source:** builder, 2026-10-27, in session (option A over B)
**Affects:** `shared/replyStart.ts`, `backends/opencodePlugin.ts` (TUI settings), `process-manager.ts` (`sendViewKey`), `renderer/components/TerminalView.tsx`

---

## 2026-10-23 — A finished turn lands on its conclusion; Claude needs its classic renderer

**Decision:** When a turn finishes, its terminal shows the conclusion (the first thing the agent said after its last tool call) from its first line, and the steps stay above it for the builder to scroll to. Shown and at the bottom: at once. Out of sight: once it shows. Scrolled up by the builder: not at all. For Claude Code this works only with its classic renderer (`"tui": "default"`), which the builder sets in their own settings; Multi-Code doesn't set it.

**Why:** Coming back at the chime, the builder scrolled up by hand through hundreds of tool calls to find where the reply began. Claude's fullscreen renderer is the alternate screen and has no command to show a message; its `/focus` hides the steps, which the builder doesn't want.

**Alternatives considered:** a reader overlay built from the transcript (the steps folded away); keeping fullscreen and driving Claude's scroll with wheel input read back from the screen (writes into the session, and a miss when Markdown is drawn differently).

**Consequences:** classic mode flickers. Terminals keep 5,000 lines of scrollback. A jump parks the screen; a message sent from the compose box, the phone or the manager doesn't move it, so a turn ending with the screen still parked jumps again, and the compose box goes to the bottom on send as typing does.

**Source:** builder, 2026-10-23, in session
**Affects:** `shared/replyStart.ts`, `renderer/components/TerminalView.tsx`, `renderer/components/ComposeBox.tsx`, `main/ipc-handlers.ts` (`read-reply-conclusion`)

---

## 2026-10-20 — OpenCode's tabs stay on inside Multi-Code

**Decision:** Multi-Code no longer passes `tabs.mode: "off"` to the OpenCode terminals it starts. Tabs follow the builder's own `cli.json`, or OpenCode's default (`auto`, which is on outside Herdr), as in any terminal. The rest of the 2026-10-16 decision stands; Ctrl+Z stays off.

**Why:** Trying the merged build, the builder missed OpenCode 2's tabs. Multi-Code is an enhanced terminal for the CLIs, so OpenCode should look in it as it does in a terminal. Following the shown session already works with tabs: a tab switch is a route change the TUI plugin reports, and a root nobody holds becomes the contact's.

**Alternatives considered:** keep tabs off (the 2026-10-16 reasons: the sidebar lists sessions, OpenCode's own Herdr precedent). `tabs.scope` has only `cwd` and `global`, so no setting keeps one terminal's tabs to itself.

**Consequences:** measured live on the isolated setup, 2026-10-20. Tabs are shared per directory and live (`tui/tabs.json`): two OpenCode contacts on one project see each other's sessions as tabs, and opening the other's tab shows that session in both terminals. Multi-Code then keeps each contact's own session, but both contacts alert for the shared one. The builder's contacts have no two OpenCode contacts in one directory. Switching tabs works with the mouse; `ctrl+tab` / `ctrl+shift+tab` do nothing in Multi-Code's terminal, which can't send them (xterm.js 5.5, no kitty keyboard protocol).

**Source:** builder, 2026-10-20, in session; docs/specs/opencode-v2/test-plan.md row 1.8
**Affects:** `backends/opencodePlugin.ts` (TUI settings), docs/specs/opencode-v2/prd.md Story 1, CLAUDE.md

---

## 2026-10-20 — OpenCode gets the builder's login-shell environment

**Decision:** Multi-Code reads the builder's login-shell environment once per run (`$SHELL -l -i`, about 1.4 s, cached) and gives it to every OpenCode terminal it starts. When no shared OpenCode service is running, Multi-Code starts it first (`opencode service start`) with that environment minus Multi-Code's own variables (`MULTICODE_*`, `OPENCODE_CLI_CONFIG_CONTENT`), then starts the terminal. Claude's spawns are unchanged.

**Why:** OpenCode 2's shared service keeps the environment of whoever starts it, for every client. Multi-Code opened from the Dock has a bare PATH without nvm, so a service it started couldn't run the builder's `npx`-launched MCP server (`documonster`) in any OpenCode window, VS Code and terminals included, until the service restarted. A service started this way matches one started from a terminal; VS Code resolves the shell environment the same way. The spike also showed that a service started by a Multi-Code terminal carries `MULTICODE_*` into the shells of every client's subagents.

**Alternatives considered:** keep Multi-Code's own environment (no shell rc run, but the MCP failure above).

**Consequences:** if the service dies while a Multi-Code terminal is attached, that terminal restarts it within about 5.5 s with its own environment (OpenCode's behaviour), which is the login-shell one plus Multi-Code's variables. Those are inert outside Multi-Code. The agent's shell in a Multi-Code contact's root session sees `MULTICODE_*`, as a Claude contact's Bash does.

**Source:** builder, 2026-10-20, in session; docs/timeline/2026-10-20_opencode-v2-spike.md, G-604/G-605
**Affects:** `backends/opencode.ts` spawn, docs/specs/opencode-v2/prd.md Stories 1 and 10

---

## 2026-10-20 — A stopped OpenCode contact stays silent

**Decision:** When an OpenCode contact is stopped while its turn still runs in the shared service, Multi-Code raises nothing for that session: no Finished, no Needs-you, no red badge, nothing on the phone or to the secretary. The next start reopens the session, with the result in it.

**Why:** Simplest of the two; alert tracking stays tied to the contact's terminal, as it is for Claude.

**Alternatives considered:** keep alerting for a stopped contact's session (about half a day more: alert state would have to outlive the terminal process).

**Source:** builder, 2026-10-20, in session
**Affects:** docs/specs/opencode-v2/prd.md Story 11; the OpenCode attention logic

---

## 2026-10-16 — OpenCode 2 runs the way its VS Code extension runs it

**Decision:** Multi-Code starts OpenCode 2 as OpenCode's own VS Code extension does: plain `opencode` in a terminal, attached to the user's shared background service. It adds only `--session ses_<id>` (an id Multi-Code picks) and per-process TUI settings through `OPENCODE_CLI_CONFIG_CONTENT`: tabs off, and a report-only TUI plugin that reports which session the TUI is showing. Multi-Code puts nothing into the server: no server plugin, no `OPENCODE_CONFIG_CONTENT`. It reads state from the service's event stream (`GET /api/event`, found through `~/.local/state/opencode/service.json`) and answers permission and question dialogs from the phone and the secretary through the service's API, not keystrokes. Stopping a contact closes its TUI only; a running turn finishes in the service, as it does when a VS Code terminal closes.

**Why:** The builder sees Multi-Code as an enhanced terminal for the CLIs, so OpenCode should behave in it as in any terminal. A plugin in a TUI's env would leak into the shared service whenever that TUI is the one to start it, because the service inherits its starter's whole environment. Tabs are off following OpenCode's own precedent for hosts that manage several terminals (`tabs.mode: auto` turns them off inside Herdr), and because Multi-Code's sidebar already lists the sessions. An API answer names its request by id, so it cannot land in the wrong dialog, which a keystroke can.

**Alternatives considered:** a private `--standalone` server per contact with the ported plugin (closest to V1, but N servers on one database, keystroke answers and no API); one Multi-Code-owned `opencode serve` with every TUI on `--server` (an extra process whose lifetime and environment Multi-Code must manage).

**Consequences:** sessions from VS Code and from Multi-Code share one pool, and `/open` shows each other's. An OpenCode upgrade replaces the service, interrupting running turns, which the new service resumes. A permission left unanswered for 60 minutes gets its turn interrupted (`inactivity`). CLAUDE.md's report-only rule gains one exception when this is built: answering a dialog through the CLI's own API, as the builder would by keypress.

**Source:** builder, 2026-10-16; docs/timeline/2026-10-16_backend-expansion-research.md ("process, session and tab model"); `sdks/vscode/src/extension.ts` in anomalyco/opencode v2.0.29
**Affects:** `backends/opencode*.ts` (spawn, state, transcript), `secretary/dialog.ts`, the phone answer path, CLAUDE.md "Architecture" and "Session monitoring".

---

## 2026-10-16 — OpenCode support moves to 2.x only

**Decision:** Multi-Code supports OpenCode 2.x and drops 1.x. No dual-version support.

**Why:** OpenCode 2 changes every surface Multi-Code uses: the plugin API, event payloads, the database tables, and the TUI's dialogs. Supporting both was feasible for about two more days of work, but every later OpenCode TUI change would then need measuring twice. OpenCode 1.x is at its end: 1.19.0 (2026-10-11) mainly adds the upgrade path to 2, and the two versions cannot be installed side by side. The builder chose one version over a transition window.

**Source:** builder, 2026-10-16; comparison of OpenCode v1.19.0 and v2.0.29 in docs/timeline/2026-10-16_backend-expansion-research.md
**Affects:** `workspace/app/src/main/backends/opencode*.ts`, `secretary/dialog.ts`, the OpenCode quick actions; every OpenCode user of Multi-Code must upgrade to 2.x.

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
