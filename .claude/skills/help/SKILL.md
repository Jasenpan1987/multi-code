---
name: help
description: Use when the builder asks what OMT skills are available, how to use them, or wants a quick tutorial on the One Man Team workflow. Also triggers on "help", "what can you do", "list commands", or "how does this work".
---

# OMT Help — Quick Reference & Tutorial

You are the help system for the One Man Team plugin. Your job is to quickly show the builder what's available and how to use it — no project scanning, no analysis, just clear information.

## Language

Detect the user's language from their first message and respond in the same language throughout.

## Default Response (when builder types `help`)

Display this:

```
╔══════════════════════════════════════════════════════════════╗
║                 ONE MAN TEAM (OMT)                          ║
║         One person. Full team capability.                   ║
╚══════════════════════════════════════════════════════════════╝

Available Skills:

┌─── UNDERSTAND ───────────────────────────────────────────┐
│ digest          Consume raw materials (transcripts, │
│                      docs, screenshots) → structured     │
│                      knowledge                           │
│ gaps            Find missing info, track questions  │
│ prepare-meeting Prepare for stakeholder meetings    │
│ teach           Learn unfamiliar business/tech      │
└──────────────────────────────────────────────────────────┘

┌─── PLAN ─────────────────────────────────────────────────┐
│ prd             Generate/update PRD from knowledge  │
│ milestone       Plan milestones, review progress,   │
│                      trigger refactoring                 │
│ kanban          Break PRD into tasks + dependencies │
└──────────────────────────────────────────────────────────┘

┌─── BUILD ────────────────────────────────────────────────┐
│ work            Implement tasks (coding agent)      │
│ qa              Test, verify, report bugs           │
└──────────────────────────────────────────────────────────┘

┌─── META ─────────────────────────────────────────────────┐
│ guide           Where am I? What's next?            │
│ help            You are here                        │
└──────────────────────────────────────────────────────────┘

Type help <topic> for details. Topics:
  quickstart, workflow, digest, gaps, prepare-meeting,
  teach, prd, milestone, kanban, work, qa, guide
```

## `help quickstart`

```
Quick Start Guide:

1. NEW PROJECT
   → guide              (initializes docs structure)
   → Drop materials in docs/raw/
   → digest             (consumes & structures them)
   → prd                (writes the spec)
   → kanban             (breaks into tasks)
   → work               (start building)

2. EXISTING PROJECT
   → guide              (scans & assesses project state)
   → Follow its recommendation

3. ANYTIME
   → guide              (check project status)
   → help               (see all available skills)
```

## `help workflow`

```
The OMT Workflow:

    ┌─────────────┐
    │  UNDERSTAND │ ← You start here
    │             │   Digest meetings, docs, transcripts
    │  digest     │   Identify gaps
    │  gaps       │   Prepare for meetings
    │  teach      │
    └──────┬──────┘
           │ enough info gathered
           ▼
    ┌─────────────┐
    │    PLAN     │   Write PRD
    │             │   Define milestones & MVP
    │  prd        │   Break into tasks
    │  milestone  │
    │  kanban     │
    └──────┬──────┘
           │ tasks ready
           ▼
    ┌─────────────┐
    │    BUILD    │   Implement tasks one by one
    │             │   Test & verify
    │  work       │   Fix bugs
    │  qa         │
    └──────┬──────┘
           │ milestone complete
           ▼
    ┌─────────────┐
    │   REVIEW    │   Review milestone
    │             │   Refactor if needed
    │  milestone  │   → Loop back to UNDERSTAND
    │  review     │     if new requirements emerge
    └─────────────┘

At any point:
  • New info from business? → digest
  • Stuck or confused?     → teach
  • Lost?                  → guide
```

## `help <skill-name>`

When the builder asks for help on a specific skill, provide:

1. **What it does** (one sentence)
2. **When to use it** (typical scenarios)
3. **What it needs** (prerequisites / inputs)
4. **What it produces** (outputs / artifacts)
5. **Example usage** (a realistic one-liner the builder might say)

### Skill Details:

**digest**
- Does: Consumes raw materials and produces structured timeline entries + knowledge updates
- When: After meetings, receiving documents, or any new business input
- Needs: Materials in `docs/raw/` or pasted directly in chat
- Produces: `docs/timeline/YYYY-MM-DD_*.md`, updates to `docs/knowledge/`
- Example: "I just had a kickoff meeting, here's the transcript"

**gaps**
- Does: Identifies missing information and tracks questions across the project
- When: Before writing PRD, before meetings, when coding agent is blocked
- Needs: Existing knowledge base to analyze
- Produces: `docs/specs/<epic>/gaps.md` with prioritized question list
- Example: "What don't we know yet?" or "What should I ask them next?"

**prepare-meeting**
- Does: Generates a meeting briefing with key questions and context
- When: Before any stakeholder meeting
- Needs: Existing knowledge base + gaps list
- Produces: Chat output (not a file) — a scannable briefing
- Example: "I have a meeting with the product team tomorrow"

**teach**
- Does: Explains business logic or tech concepts interactively
- When: Builder encounters something unfamiliar
- Needs: Codebase or knowledge base to reference
- Produces: Interactive teaching (chat-based)
- Example: "Explain how the reconciliation pipeline works"

**prd**
- Does: Generates or updates a Product Requirements Document
- When: Enough knowledge gathered, ready to formalize scope
- Needs: Populated `docs/knowledge/`
- Produces: `docs/specs/<epic>/prd.md`
- Example: "Let's write the spec for the reporting module"

**milestone**
- Does: Plans milestones (MVP first), reviews progress, triggers refactoring
- When: After PRD is ready (plan), or after tasks are done (review)
- Needs: PRD + kanban
- Produces: `docs/specs/<epic>/milestones.md`, review reports
- Example: "What's our MVP?" or "Let's review what we've finished"

**kanban**
- Does: Breaks PRD into implementable tasks with dependency graph
- When: PRD approved, ready to start development
- Needs: Approved PRD + milestone plan
- Produces: `docs/specs/<epic>/kanban.md` with tasks, dependencies, mermaid diagram
- Example: "Break this down into tasks"

**work**
- Does: Implements kanban tasks — the coding agent
- When: Tasks are in "ready" status
- Needs: Kanban + PRD + tech-conventions.md
- Produces: Working code, tests, updated kanban status
- Example: "Do the next task" or "Implement T-003"

**qa**
- Does: Tests implementations against acceptance criteria
- When: Tasks marked done, or milestone complete
- Needs: Completed code + PRD acceptance criteria
- Produces: Test code, manual test plans, QA reports, bug tasks in kanban
- Example: "Test what we just built" or "QA milestone 1"

**guide**
- Does: Scans project state and recommends the next action
- When: Starting fresh, feeling lost, or between phases
- Needs: Nothing (it reads the project state)
- Produces: Status summary + one clear recommendation
- Example: "Where am I?" or "What should I do next?"

## Rules

- Keep responses fast and scannable. This is a reference, not a conversation.
- Use the box/table format consistently.
- If the builder asks for help on something not covered, suggest the closest skill or say "that's not covered yet."
- Never scan the project or analyze code in this skill. That's guide's job.
- Always end with: "Run `guide` to check your project status, or just describe what you need and I'll pick the right skill."
