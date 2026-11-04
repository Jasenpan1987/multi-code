# Handoff: Markdown View feature

**For:** the next session (fresh context) picking up implementation.
**Created:** 2026-07-09
**Updated:** 2026-07-09 — T-001 + T-002 landed; start from T-003.

## What this is

A new "View" section in Multi-Code's right toolbox that renders a Markdown file
inline. User pastes a `.md` path (usually one an agent just generated), hits
Enter, and reads the rendered result without leaving the app.

## Progress so far

- **T-001 done** (renderer shell + per-instance open-path state) — commit `8601037`.
- **T-002 done** (`read-file` IPC + validation) — commit `8601037`.
- **T-003 is `ready`** (base markdown rendering) — this is where the next
  session starts. T-004 (math/mermaid) and T-005 (error/empty states) stay
  `blocked` until T-003 lands, then run in parallel.

`pnpm type` and `pnpm lint` are green as of that commit. Kanban reflects all of
the above (statuses + changelog).

## What already exists (built by T-001 / T-002 — don't rebuild)

- `MarkdownSection` component at `workspace/app/src/renderer/components/MarkdownSection.tsx`
  — shell only: a top bar with a path `<input>` + "Refresh" button, and a body
  area that currently shows a "Rendering coming soon" placeholder when a path is
  open. **T-003 fills in the body with real rendering.** Props already wired:
  `{ instance, active, openPath, onOpenPath }`.
- Per-instance open-path state in `App.tsx`: `openPathByInstance:
  Map<instanceId, string>` + `handleOpenPath` setter (mirrors
  `expandedByInstance`/`handleExpandSection`), cleaned up in `handleRemove`.
  Threaded down through `Toolbox` as `openPath` / `onOpenPath`.
- 4th `<ToolboxSection id="view" title="View">` block in `Toolbox.tsx`, after
  Terminal.
- `read-file` IPC handler in `workspace/app/src/main/ipc-handlers.ts`:
  resolves absolute / `~` / cwd-relative paths, gates on `.md`/`.markdown`
  extension, rejects missing files / directories / >2MB, never throws. Returns a
  `ReadFileResult` discriminated union (`{ ok:true, path, content }` |
  `{ ok:false, path, error: "not-found"|"unsupported"|"too-large" }`).
- Exposed as `window.electronAPI.readFile(instanceId, path)` in `preload.ts`;
  `ReadFileResult` + `ReadFileError` typed in `shared/types.ts`.
- `.markdown-section` styling in `workspace/app/src/renderer/styles/global.css`
  (matches the existing `.dialog-input` / `.browse-btn` convention; no separate
  dark-theme override, same as those).

## Read these first (in order)

1. `docs/specs/markdown-view/kanban.md` — the 5 MVP tasks, dependencies, acceptance criteria. **This is the work list.** T-001/T-002 are `done`; start at T-003.
2. `docs/timeline/2026-07-09_markdown-view-ideation.md` — the full aligned understanding + locked MVP scope.
3. `docs/knowledge/decisions.md` — top 3 entries (2026-07-09) are this feature's binding decisions.
4. `docs/specs/markdown-view/gaps.md` — the 2 deferred phase-2 items.

## The locked decisions (don't re-litigate)

- **Single file, replace-on-open.** No tabs.
- **Per-instance open-path state**, mirroring `App.tsx`'s `expandedByInstance` Map. Switching instance follows the new instance's state. (Already implemented.)
- **`.md`/`.markdown` only.** Everything else (`.txt`, `.json`, no ext, directory, >2MB) → plain inline error, no dialog, no crash. (Enforced in `read-file`.)
- **Rendering = react-markdown + remark-gfm + remark-math + rehype-katex + mermaid.** Math and Mermaid ARE in the MVP. Mermaid failure → degrade to raw code block, never crash. No raw HTML (no rehype-raw).
- **Manual refresh only**, no file-watching.
- Read/validate the file in the **main process** (`read-file` IPC), not the renderer. (Done.)

## Next up: T-003 (base rendering)

- In `MarkdownSection`, on open-path change or Refresh, call
  `window.electronAPI.readFile(instance.id, openPath)` and render
  `result.content` through `<ReactMarkdown remarkPlugins={[remarkGfm]}>` on
  `{ ok: true }`. A `useEffect` keyed on `[instance.id, openPath, refreshNonce]`
  is the clean shape; bump a `refreshNonce` counter from the Refresh button to
  force a re-read of the same path.
- Add deps: `react-markdown`, `remark-gfm`. Do NOT enable `rehype-raw`.
- Style a `.markdown-body` block (headings, lists, tables, code, links,
  blockquotes) readable in the narrow column; long code lines scroll within
  their block, don't break layout. Links open externally, not navigate the
  renderer.
- Error/empty-state rendering is T-005 — for T-003 a minimal loading + happy
  path is enough, but wiring the `readFile` call now is what unblocks both.

## Key code facts

- Toolbox is an accordion of hardcoded `<ToolboxSection>` blocks keyed by string `id` — no central tabs array. The `id="view"` block is already there.
- `MarkdownSection` receives `instance` (has `.id` and `.cwd`); pass `instance.id` to `readFile`. Path resolution against cwd already happens main-side.
- markdown deps NOT installed yet: react-markdown, remark-gfm (T-003), then remark-math, rehype-katex, katex, mermaid (T-004). Bundler is rspack — confirm it bundles these (esp. mermaid, which is large; consider dynamic import in T-004).

## Verify / build reminders

- `pnpm type` and `pnpm lint` must stay clean. They work normally now — a prior
  pnpm build-approval gate (`ERR_PNPM_IGNORED_BUILDS`) was resolved via
  `pnpm approve-builds` on this machine, so you should NOT need to fall back to
  running `npx tsc` / `npx oxlint` directly.
- `pnpm build` before any release; do NOT bump version on routine dev builds (see CLAUDE.md release process).
- This is a self-contained additive feature — it should not touch existing Git/Quick Actions/Terminal logic.
