# Markdown View Epic — Gaps

Open questions and parked scope from 2026-07-09 ideation.

## Open Gaps

| ID | Question | Status | Notes |
|----|----------|--------|-------|
| G-001 | Phase-2: clickable `.md` paths in terminal output | Deferred (phase 2) | xterm link provider matches `*.md` paths in PTY output; click opens the file in the View section. Heavier than manual input — needs a terminal link provider + focus/expand View + load. Deferred by builder during ideation. |
| G-002 | Phase-2: "Preview in View" entry on changed `.md` files in Git section | Deferred (phase 2) | Git section already lists changed files; add a per-file action for `.md` entries that opens them in View. Lighter than the terminal one. Deferred by builder. |

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| R-001 | Single file vs multi-file tabs | Single file, replace-on-open. No tabs in MVP. | 2026-07-09 ideation |
| R-002 | Open-path state scope (per-instance vs global) | Per-instance; switching instance follows the new instance's state. Required for correct relative-path resolution. | 2026-07-09 ideation |
| R-003 | Which file types render | `.md`/`.markdown` only; everything else refused with a plain error. | 2026-07-09 ideation |
| R-004 | Behavior on not-found / unreadable / wrong-type / oversized | Plain inline error, no dialog, no crash. Size cap ~2MB. | 2026-07-09 ideation |
| R-005 | Math and Mermaid in MVP? | Yes — remark-math + rehype-katex + Mermaid. Mermaid failure degrades to raw code block. | 2026-07-09 ideation |
| R-006 | Auto-refresh on file change? | No file-watching in MVP. Manual refresh button only. | 2026-07-09 ideation |
| R-007 | Raw HTML in markdown | Not executed — react-markdown safe default, no `rehype-raw`. | 2026-07-09 ideation |
