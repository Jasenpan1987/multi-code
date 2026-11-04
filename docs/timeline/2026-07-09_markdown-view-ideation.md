# Markdown View Section — Ideation & Alignment

**Date:** 2026-07-09
**Type:** ideation
**Participants:** Jasen (builder)
**Source:** (verbal, builder-described — interview via OMT/interview)

## Summary

Builder wants a fourth toolbox section, "View", alongside Git / Quick Actions / Terminal. Its purpose: render a Markdown file inline so the builder can read agent-generated `.md` output (reports, plans, specs) without leaving Multi-Code. The common trigger is "an agent generates a markdown file and hands back its path" — builder pastes that path into View and reads the rendered result.

MVP is deliberately a single-file reader: paste a path, hit enter, see rendered Markdown; manual refresh to re-read. Two later features (click a path in the terminal / a `.md` in Git status to open it in View) are explicitly deferred to phase 2.

Rendering is richer than "plain markdown" — the builder specifically wants **math (KaTeX)** and **Mermaid diagrams** in the MVP, because agent output frequently contains both.

## Key Decisions

- **New section, not a new column** — "View" is a fourth accordion section (`id="view"`) in the existing Toolbox, reusing the current per-instance expand mechanism. Decided by builder. Reason: consistent with Git/Quick Actions/Terminal; no layout rework.
- **Single file, replace-on-open** — View shows one file at a time; opening a new path replaces the current one. Decided by builder. Reason: core use is "glance at the md an agent just produced", not a multi-doc reader; right column is narrow, tabs would crowd it.
- **Per-instance state** — Each instance remembers its own currently-open path. Switching instance follows the new instance's state (may be empty, may be its previously-open file). Decided by builder. Reason: relative paths must resolve against each instance's cwd; a global "current md" would resolve the wrong cwd. Consistent with existing `expandedByInstance` model.
- **`.md`/`.markdown` only** — Any other extension (`.txt`, `.json`, no extension, a directory) is refused with a plain error, not rendered. Decided by builder (reversed a mid-interview decision to render `.txt` as plain text). Reason: the real scenario only ever produces Markdown files; a plain-text branch is effort spent on a case that doesn't happen.
- **Path resolution** — Absolute paths (`/…`, `C:…`) and `~` used as-is / expanded; otherwise resolved against `instance.cwd`. Decided by builder.
- **Read on the main side** — A new `read-file` IPC handler does path resolution + extension check + size check + read, in the main process, so illegal cases are rejected before the renderer tries to display anything. Decided by builder.
- **Size cap 2MB** — Files over ~2MB are refused with an error rather than rendered, to avoid freezing the UI. Recommended by BA, accepted by builder.
- **Math + Mermaid in MVP** — remark-math + rehype-katex for math; Mermaid code blocks rendered asynchronously to SVG. Decided by builder (added mid-interview; overrides the earlier "no math/mermaid" cut).
- **Mermaid failure → raw code block** — If a Mermaid diagram fails to render (e.g. bad syntax), that block degrades to a plain code block showing the raw definition; it must never crash the whole document. Decided by builder.
- **No raw HTML** — react-markdown stays on its safe default (no `rehype-raw`); markdown-embedded HTML/scripts are not executed. Recommended by BA, accepted.
- **Manual refresh only** — A refresh button re-reads the current path. No file-watching in MVP. Decided by builder.

## Facts Learned

- The Toolbox sidebar is an accordion of hardcoded `<ToolboxSection>` blocks keyed by string `id`; there is no central tabs array or union type, so adding a section is: new component + one `<ToolboxSection id="view">` block in `Toolbox.tsx`.
- There is currently **no** IPC handler that reads an arbitrary file path — this feature must add one (`read-file`), wired through `preload.ts` and typed in `shared/types.ts`.
- There is currently **no** markdown-rendering dependency in the repo; react-markdown, remark-gfm, remark-math, rehype-katex, katex, and mermaid all need to be added.
- `instance.cwd` is already threaded into the Toolbox and used by GitSection to build absolute paths (`${cwd}/${file.path}`) — the same resolution approach applies.

## Open Questions

(See `docs/specs/markdown-view/gaps.md` — the two phase-2 features are parked there.)

## Action Items

- [ ] Builder + AI: write PRD (`prd` skill) or go straight to kanban / implementation.

## New Terms

| Term | Meaning | Example |
|------|---------|---------|
| View section | Fourth toolbox section that renders a Markdown file inline | (this epic) |
| Replace-on-open | Opening a new path replaces the currently-shown file (no tabs) | Open B while A is shown → A is gone |

## MVP Scope (locked at end of session)

### View section
- Fourth accordion section, `id="view"`, in the existing Toolbox
- Top bar: path input + refresh button
- Single file; opening a new path replaces the current
- Per-instance open-path state; switching instance follows the new instance
- Path resolution: relative → `instance.cwd`; absolute and `~` supported
- Extension gate: `.md`/`.markdown` only; else plain error
- Error/empty states: not-found / unreadable / wrong-extension / >2MB → plain inline error (no dialog, no crash); nothing open → hint to paste a path
- Rendering: react-markdown + remark-gfm + remark-math + rehype-katex + Mermaid (async SVG; failure → raw code block); no raw HTML

### Main process
- New `read-file` IPC handler: resolve path, check extension, check size (≤2MB), read contents; return typed result (contents or error kind)
- Exposed via `preload.ts`; signature added to `ElectronAPI` in `shared/types.ts`

## Deferred to Phase 2

- Clickable `.md` paths in terminal output (xterm link provider) → open in View
- "Preview in View" entry on changed `.md` files in the Git section

## Cut from MVP

- Multi-file tabs
- Non-`.md` files (including plain-text rendering)
- File-watching / auto-refresh on change
- Code-block syntax highlighting (gfm's default fenced-code box is enough)
