# Kanban: Markdown View

**Generated:** 2026-07-09
**Source:** 2026-07-09 markdown-view ideation (no separate PRD — aligned via /omt:interview, decisions in timeline + decisions.md)
**Total Tasks:** 5 (MVP) + 2 (phase 2, deferred)
**Milestones:** M1 (Markdown View MVP)

## Task Overview

```mermaid
graph TD
    T001[T-001: View section shell + per-instance open-path state] --> T003[T-003: Base markdown rendering]
    T002[T-002: read-file IPC + validation] --> T003
    T003 --> T004[T-004: Math + Mermaid rendering]
    T003 --> T005[T-005: Error + empty states]
    P1[P2-001: Clickable .md paths in terminal]
    P2[P2-002: Preview-in-View from Git section]
```

**Critical path:** T-001 / T-002 (parallel) → T-003 → T-004 (longest chain — full rendering depends on shell + IPC + base render).

**Parallelizable:**
- T-001 (renderer shell) and T-002 (main-process IPC) have no dependency — do them in parallel.
- After T-003 lands: T-004 (math/mermaid) and T-005 (error/empty states) are independent.

## Milestone 1: Markdown View MVP

### T-001: View section shell + per-instance open-path state
- **Type:** feature
- **Status:** done
- **Description:** Add a fourth accordion section "View" to the Toolbox. In `workspace/app/src/renderer/components/Toolbox.tsx`, add a `<ToolboxSection id="view" title="View" ...>` block after the Terminal section, rendering a new `MarkdownSection` component (pass `instance` and `active={isExpanded("view")}`). Create `MarkdownSection` in `workspace/app/src/renderer/components/` with: a top bar containing a path `<input>` (placeholder e.g. "Paste a .md path, Enter to open") and a "Refresh" button, and a body area below (empty for now — rendering lands in T-003). Wire per-instance open-path state: add a `Map<instanceId, string>` (open path per instance) in `App.tsx` alongside the existing `expandedByInstance`, with a setter mirroring `handleExpandSection`. Pass the current instance's open path + an `onOpenPath(path)` setter down through `Toolbox` to `MarkdownSection`. Submitting the input (Enter) or clicking Refresh calls `onOpenPath`. Switching instances shows the new instance's open path (which may be empty). Follow the `active` early-return pattern (`if (!active) return null;`).
- **Acceptance:**
  - A fourth "View" section header appears in the toolbox, below Terminal
  - Expanding it shows the path input + Refresh button; collapsing hides the body
  - Typing a path and pressing Enter stores it as this instance's open path (verify via state; rendering comes in T-003)
  - Switching to another instance clears/changes the shown path to that instance's own open path; switching back restores it
  - No crash when nothing is open
- **Blocks:** T-003
- **Blocked by:** none
- **Parallel with:** T-002
- **Notes:** Mirror the existing `expandedByInstance` machinery in `App.tsx` exactly (a second `useState<Map<string,string>>` + a `useCallback` setter keyed on `selectedId`). Keep styling compact (QQ aesthetic); reuse existing toolbox/section CSS classes where possible, add a `markdown-section` block to `workspace/app/src/renderer/styles/`. Do NOT wire rendering here — this task is shell + state only.

---

### T-002: read-file IPC handler + validation
- **Type:** feature
- **Status:** done
- **Description:** Add a `read-file` IPC handler in `workspace/app/src/main/ipc-handlers.ts` (inside `registerIpcHandlers()`). Signature: takes `(instanceId, rawPath)`. Behavior: (1) resolve the path — if `rawPath` is absolute (`/…`, or Windows `X:\`), use as-is; if it starts with `~`, expand against home (`os.homedir()`); otherwise resolve against the instance's `cwd` (look up via `processManager`, same way `get-git-status` does). (2) Reject if the resolved extension is not `.md` or `.markdown` → return `{ ok: false, error: "unsupported", path }`. (3) `stat` the file — if missing/unreadable → `{ ok: false, error: "not-found", path }`; if size > 2 MB → `{ ok: false, error: "too-large", path }`; if it's a directory → `{ ok: false, error: "unsupported", path }`. (4) Otherwise read as UTF-8 and return `{ ok: true, path: <resolved absolute path>, content }`. Wrap everything so no throw escapes to crash main. Expose via `preload.ts` as `window.electronAPI.readFile(instanceId, path)`. Add a `ReadFileResult` type + the method signature to `ElectronAPI` in `workspace/app/src/shared/types.ts`.
- **Acceptance:**
  - `readFile(id, "notes.md")` on a git-style relative path resolves against that instance's cwd and returns `{ ok: true, content }`
  - Absolute path and `~/…` path both resolve correctly
  - `.txt` / `.json` / no-extension / a directory → `{ ok: false, error: "unsupported" }`
  - Nonexistent path → `{ ok: false, error: "not-found" }`
  - A >2MB `.md` → `{ ok: false, error: "too-large" }`
  - No input can crash the main process (all fs ops guarded)
- **Blocks:** T-003
- **Blocked by:** none
- **Parallel with:** T-001
- **Notes:** `ipc-handlers.ts` already imports `resolve`/`dirname`/`basename` from `path`; add `extname` and `statSync`/`readFileSync` as needed (`fs` helpers already partially imported at top). Look at how `get-git-status` resolves the instance cwd via `processManager` and copy that lookup. Return a discriminated union (`ok: true | false`) so the renderer can switch on `error` cleanly. Extension check is case-insensitive.

---

### T-003: Base markdown rendering (react-markdown + remark-gfm)
- **Type:** feature
- **Status:** done
- **Description:** Add the markdown rendering pipeline to `MarkdownSection`. Install deps: `react-markdown`, `remark-gfm`. On open-path change or Refresh, call `window.electronAPI.readFile(instanceId, path)`; on `{ ok: true }`, render `content` through `<ReactMarkdown remarkPlugins={[remarkGfm]}>`. Do NOT enable `rehype-raw` — raw HTML stays inert. Style the rendered output (headings, lists, tables, code blocks, links, blockquotes) to be readable and compact within the narrow column; add a `markdown-body` CSS block. Links should open externally (via existing `openInVSCode`/shell-open pattern or `target=_blank` guarded) rather than navigate the renderer — pick the simplest safe option and note it. Loading state while reading.
- **Acceptance:**
  - Opening a real `.md` renders headings, lists, **bold**/*italic*, tables (gfm), fenced code blocks, links, blockquotes
  - Raw `<script>`/HTML in the markdown is NOT executed (renders inert or escaped)
  - Rendered content is readable in the narrow toolbox column (no horizontal overflow breaking layout — long code lines scroll within their block)
  - Refresh re-reads the file and re-renders updated content
  - Clicking a link does not blow away the app's renderer view
- **Blocks:** T-004, T-005
- **Blocked by:** T-001, T-002
- **Parallel with:** none
- **Notes:** This is the first task that adds renderer dependencies — confirm rspack bundles react-markdown cleanly (it's ESM, should be fine). Keep the component's data flow simple: `useEffect` keyed on `[instanceId, openPath, refreshNonce]` that calls `readFile` and sets local state. A `refreshNonce` counter bumped by the Refresh button is the cleanest way to force a re-read of the same path.

---

### T-004: Math (KaTeX) + Mermaid rendering
- **Type:** feature
- **Status:** ready
- **Description:** Extend the pipeline with math and diagrams. **Math:** install `remark-math` + `rehype-katex` + `katex`; add them to the ReactMarkdown plugin lists and import KaTeX's CSS. Inline (`$…$`) and block (`$$…$$`) math should render. **Mermaid:** install `mermaid`. Provide a custom code-block renderer to ReactMarkdown (`components={{ code: ... }}`) that detects language `mermaid`, and for those blocks calls `mermaid.render()` (async) to produce an SVG, rendering the SVG into the block. Initialize mermaid once (`mermaid.initialize({ startOnLoad: false })`). **Failure handling:** if `mermaid.render()` throws (bad syntax), catch it and fall back to rendering the block as a plain fenced code block showing the raw mermaid source (optionally a small "diagram failed to render" note). A mermaid failure must never crash the document or the app. Non-mermaid code blocks render as normal fenced code (from T-003).
- **Acceptance:**
  - A doc with `$E = mc^2$` inline and a `$$…$$` block renders formatted math (KaTeX)
  - A valid ```` ```mermaid ```` block renders as an SVG diagram
  - A ```` ```mermaid ```` block with broken syntax degrades to a raw code block showing the source — rest of the document still renders, app does not crash
  - KaTeX CSS is loaded (math is styled, not raw TeX)
  - Switching between two `.md` files with different mermaid blocks doesn't leak stale SVGs
- **Blocks:** none
- **Blocked by:** T-003
- **Parallel with:** T-005
- **Notes:** Mermaid in Electron renderer: it needs a DOM to measure/render into — running in the renderer process is fine. `mermaid.render(id, code)` returns a promise resolving to `{ svg }`; each block needs a unique id (use a counter or the block index — remember `Math.random`/`Date.now` are fine in app code, this constraint is only for workflow scripts). Watch bundle size — mermaid is large; confirm rspack build still succeeds and note the size delta. Consider dynamic `import()` of mermaid so it's only loaded when a mermaid block is actually encountered, if bundle size becomes a concern.

---

### T-005: Error states + empty state
- **Type:** feature
- **Status:** done
- **Description:** Render the non-happy states in `MarkdownSection` based on the `read-file` result. Map each `error` kind to a plain, compact inline message in the body area (no dialogs, no crash): `not-found` → "⚠ File not found: <path>"; `unsupported` → "⚠ Only .md files can be viewed: <path>"; `too-large` → "⚠ File too large to preview (>2MB): <path>". Empty state (no path opened yet for this instance) → a hint like "Paste a .md path above and press Enter." Ensure a stale render from a previous file is cleared when a new open fails (don't leave old content showing under an error).
- **Acceptance:**
  - Opening a nonexistent path shows the not-found message, no crash, no dialog
  - Opening a `.txt` (or directory) shows the unsupported-type message
  - Opening a >2MB `.md` shows the too-large message
  - With nothing opened, the empty-state hint shows
  - After a successful render, then opening a bad path, the old rendered content is replaced by the error (not shown underneath)
- **Blocks:** none
- **Blocked by:** T-003
- **Parallel with:** T-004
- **Notes:** The error kinds come straight from T-002's discriminated union — just switch on `result.error`. Keep messages one line, muted styling (reuse the `git-section-placeholder` styling idea). This task is small; it mainly makes the failure paths from T-002 visible and pleasant.

---

## Phase 2 (deferred — see gaps.md G-001, G-002)

### P2-001: Clickable `.md` paths in terminal output
- **Type:** feature
- **Status:** backlog (deferred)
- **Description:** Register an xterm.js link provider on the claude terminal (and/or the shell terminal) that matches `*.md` file paths in the output and renders them as clickable links. Clicking: resolve the path, expand the View section for that instance, and load the file (reuse T-001's `onOpenPath`). Needs a bridge from the terminal component up to the toolbox open-path setter.
- **Blocked by:** T-001..T-005 (MVP complete)
- **Notes:** Deferred during ideation — heavier than manual input (link provider + regex tuning for path detection + cross-component wiring). Revisit after MVP is in use.

### P2-002: "Preview in View" entry on changed `.md` files in Git section
- **Type:** feature
- **Status:** backlog (deferred)
- **Description:** In `GitSection`'s `FileRow`, for entries whose path ends in `.md`/`.markdown`, add a secondary action (e.g. a small "View" affordance next to the existing VS Code click) that opens the file in the View section instead of VS Code. Reuses T-001's open-path mechanism.
- **Blocked by:** T-001..T-005 (MVP complete)
- **Notes:** Lighter than P2-001 (Git already lists the files and has cwd). Deferred with P2-001.

---

## Legend

- **Blocks:** This task must complete before the listed tasks can start
- **Blocked by:** This task cannot start until the listed tasks complete
- **Parallel with:** These tasks have no dependency and can be worked simultaneously
- **Status values:** `backlog` → `ready` → `in-progress` → `done` (or `blocked`)

## Changelog

- 2026-07-09: Initial breakdown from ideation. 5 MVP tasks (T-001..T-005) + 2 deferred phase-2 tasks. T-001 and T-002 ready and parallelizable; T-003 blocked on both; T-004/T-005 blocked on T-003.
- 2026-07-09: T-001 + T-002 done (implemented in parallel). View section shell + per-instance open-path state wired through App→Toolbox→MarkdownSection; `read-file` IPC handler + `ReadFileResult` union added and exposed via preload. `pnpm type` / oxlint / eslint all green. T-003 now unblocked (ready).
- 2026-07-09: T-003 done. `MarkdownSection` now reads the open file (`useEffect` keyed on `[instance.id, openPath, refreshNonce]`, stale-response guarded) and renders via react-markdown + remark-gfm. Added `open-external` IPC (`shell.openExternal`, guarded to http/https/mailto) + `openExternal` in preload/types; links routed there via a custom `a` renderer + `shouldOpenExternally` helper (relative/exotic links stay inert). No rehype-raw — raw HTML stays escaped. Added `.markdown-body` CSS (compact, theme-aware, long code scrolls in-block). Deps: react-markdown@10, remark-gfm@4. New unit test `markdownLinks.test.ts` (6 tests). type/lint/build/test green; render verified through the real pipeline. T-004 + T-005 now unblocked (ready).
- 2026-07-09: T-005 done. Error/empty states in `MarkdownSection`: `read-file` error union mapped to one-line inline messages (not-found / unsupported / too-large) via a new `readFileErrorMessage` helper; empty state ("Paste a .md path above and press Enter.") shown when no path is open; the `.markdown-body` container now always renders and branches on empty/loading/ok/error so a failed open replaces old content (Loading branch beats stale result). New unit test `markdownErrors.test.ts` (4 tests). type/lint/test green (23 total); verified end-to-end against real bad files on disk. Only T-004 (math/mermaid) remains in the MVP.
