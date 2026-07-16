# Markdown View Epic — Gaps

Open questions and parked scope from 2026-07-09 ideation.

## Open Gaps

_None — all Markdown View gaps resolved (MVP + phase 2 complete)._

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-003 | P2-003: how to serve local images to the renderer | Shipped: custom `mdimg://` protocol mapping to on-disk files, scoped to the open `.md` file's directory subtree, extension-gated + size-capped. Matches VSCode (`asWebviewUri`) / Obsidian (`app://`); rejected data-URL. Remote images untouched; SVG excluded (script risk). | 2026-07-10 |
| R-001 | Single file vs multi-file tabs | Single file, replace-on-open. No tabs in MVP. | 2026-07-09 ideation |
| R-002 | Open-path state scope (per-instance vs global) | Per-instance; switching instance follows the new instance's state. Required for correct relative-path resolution. | 2026-07-09 ideation |
| R-003 | Which file types render | `.md`/`.markdown` only; everything else refused with a plain error. | 2026-07-09 ideation |
| R-004 | Behavior on not-found / unreadable / wrong-type / oversized | Plain inline error, no dialog, no crash. Size cap ~2MB. | 2026-07-09 ideation |
| R-005 | Math and Mermaid in MVP? | Yes — remark-math + rehype-katex + Mermaid. Mermaid failure degrades to raw code block. | 2026-07-09 ideation |
| R-006 | Auto-refresh on file change? | No file-watching in MVP. Manual refresh button only. | 2026-07-09 ideation |
| R-007 | Raw HTML in markdown | Not executed — react-markdown safe default, no `rehype-raw`. | 2026-07-09 ideation |
| G-002 | Phase-2: "Preview in View" on changed `.md` files in Git section | Shipped as P2-002 — Git `FileRow` shows a "View" affordance for `.md`/`.markdown` entries that opens the file in the View section and expands it. | 2026-07-10 |
| G-001 | Phase-2: clickable `.md` paths in terminal output | Shipped as P2-001 — `TerminalView` registers an xterm link provider (`mdPathMatch.findMdPaths`); clicking a `.md`/`.markdown` path dispatches `md-open`, opening it in the View section. Claude terminal only; shell terminal not wired. | 2026-07-10 |
