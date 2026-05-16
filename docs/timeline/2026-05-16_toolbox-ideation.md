# Toolbox Epic — Initial Ideation

**Date:** 2026-05-16
**Type:** ideation
**Participants:** Jasen (builder)
**Source:** (verbal, builder-described — interview via OMT/digest)

## Summary

Builder wants to add a third column ("toolbox") to the existing two-column UI (contact list | terminal). The toolbox is per-instance and accordion-style: only one section expanded at a time, the expanded one fills available vertical space. MVP includes two sections — Git status and Quick Actions. The deeper purpose is to position Multi-Code as a lightweight agent orchestration hub, with quick handoff to a real IDE-backed Claude Code when deep code work is needed.

## Key Decisions

- **Layout** — Three-column: contact list | terminal | toolbox. Decided by builder, reason: existing two-column layout has space on the right and tabs would hide info.
- **Section organization** — Accordion (one expanded at a time, fills vertical space). Decided by builder. Reason: clean focus, scales well as future sections are added.
- **Default expanded section** — Git. Decided by builder. Reason: most common reason to glance at the toolbox is to check current branch state.
- **Per-instance scope** — Each instance has its own toolbox state (Git reflects that instance's cwd, buttons act on that instance). Decided by builder.
- **Editor for "Go to Code Base"** — Hardcode VS Code for MVP. Decided by builder. Reason: keep MVP small; configurability is a future epic.
- **No file-jumping in MVP** — Originally builder wanted "AI mentions a file → click to jump there" but cut it. Reason: scope reduction; the broader "Go to Code Base" button covers the main use case.
- **Quick Actions defined as** — buttons that either (a) trigger system-level actions or (b) auto-type common claude slash commands into the terminal. Builder reframed during interview.
- **Git refresh strategy** — 5-second polling (not file-watching, not event-driven). Decided by builder. Reason: simplicity over precision.
- **Resume Elsewhere button** — copies `claude --resume <session-id>` to clipboard. Decided by builder. Reason: enables handoff to IDE-integrated Claude Code when deep code work is needed.

## Facts Learned

- Multi-Code's role in the builder's workflow: lightweight agent orchestration hub. Heavy code work happens in IDE-integrated Claude Code; Multi-Code is the "dispatcher" that watches and triggers.
- The toolbox is designed for **future extensibility** — accordion model was chosen partly because it scales gracefully when more sections are added.
- session-watcher already reads sessionId from `~/.claude/sessions/<pid>.json` — needed for the Resume Elsewhere button.
- `--continue` (currently used at spawn) and `--resume <session-id>` are both available in claude CLI.

## Open Questions

(See `docs/specs/toolbox/gaps.md`)

## Action Items

- [ ] Builder + AI: write PRD next (`prd` skill)

## New Terms

| Term | Meaning | Example |
|------|---------|---------|
| Toolbox | Third column in main UI, per-instance utility panel | (this epic) |
| Section (toolbox) | One vertical slot in the toolbox accordion | Git section, Quick Actions section |
| Quick Action | A button in the Quick Actions section, either system-level or auto-types a slash command | "Show Cost" → types `/cost` |
| Resume Elsewhere | Copying `claude --resume <session-id>` to clipboard for handoff to another Claude Code instance | (Quick Action button) |

## MVP Scope (locked at end of session)

### Git section
- Current branch name
- File counts: new (untracked) / modified (unstaged) / staged
- Remote status: ahead/behind
- 5-second polling
- Graceful fallback if cwd is not a git repo

### Quick Actions section
- **Go to Code Base** — system: open/activate VS Code on the instance's cwd
- **Show Cost** — types `/cost` into terminal
- **Clear** — types `/clear` into terminal
- **Compact** — types `/compact` into terminal
- **Resume Elsewhere** — copies `claude --resume <session-id>` to clipboard

### Behavior rules
- Accordion: only one section expanded at a time
- Default state: Git expanded
- Per-instance state (toolbox state belongs to the selected instance)

## Cut from MVP

- Section 3 ("AI-mentioned files clickable to jump")
- Configurable editor (Cursor, JetBrains, etc.)
- Jumping to specific file:line
- File-watching or event-driven git refresh
