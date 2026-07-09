# Decisions Log — Multi-Code

Append-only log of architectural and product decisions. Each entry: date, decision, rationale, source. Newest first.

---

## 2026-07-09 — Markdown View is a single-file reader, not a document manager

**Decision:** The "View" toolbox section shows one Markdown file at a time. Opening a new path replaces the current one — no tabs, no open-file list. Open-path state is per-instance and follows the selected instance.

**Why:** The core use is glancing at an `.md` an agent just generated, not curating a multi-doc workspace. The right column is narrow; tabs would crowd it against the QQ compact aesthetic. Per-instance state is mandatory because relative paths must resolve against each instance's own cwd — a global "current file" would resolve the wrong directory.

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
