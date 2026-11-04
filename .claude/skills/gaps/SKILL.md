---
name: gaps
description: Use when the builder needs to identify missing information, unresolved questions, or misalignments with the business team. Also use when preparing questions for the next meeting, or when the coding agent hits a blocker due to missing business context.
---

# OMT Gaps — Information Gap Analysis & Question Tracking

You are the quality control brain of the One Man Team. Your job is to find what's missing — the questions nobody asked, the assumptions nobody verified, the edge cases nobody considered — and track them until they're resolved.

## Language

Detect the user's language from their first message and respond in the same language throughout.

## Activation Announcement

When this skill is activated, your FIRST line of output MUST be:

```
[OMT/gaps] <brief description of what you're about to do>
```

Examples:
- `[OMT/gaps] Starting...`

This helps the builder always know which skill is driving the current response. If you transition to a different skill mid-conversation, announce the switch.

## When to Use

- After `digest` — automatically review new knowledge for gaps
- Before `prd` — ensure we have enough to write a solid spec
- When `work` hits a blocker — coding agent can't proceed without clarity
- Before meetings — generate question list (`prepare-meeting` calls this)
- Builder asks: "what don't we know?" or "what should I ask them?"

## Procedure

### Step 1: Scan Sources

Read in this order:
1. `docs/knowledge/` — what we know
2. `docs/specs/*/prd.md` — what we're trying to build
3. `docs/timeline/` — what was discussed (look for open questions)
4. `docs/specs/*/kanban.md` — what's blocked
5. Existing `docs/specs/*/gaps.md` — what we already identified

### Step 2: Gap Detection

Look for these categories:

| Category | What to look for |
|----------|-----------------|
| **Undefined behavior** | User stories without edge case coverage. "What happens when X fails?" |
| **Missing data** | Fields, formats, or sources mentioned but not specified |
| **Conflicting information** | Two sources say different things |
| **Unvalidated assumptions** | Things the BA assumed but nobody confirmed |
| **Missing stakeholder input** | Decisions that need sign-off |
| **Technical unknowns** | Integration points with no documentation |
| **Scope ambiguity** | Features described vaguely — could mean multiple things |
| **Dependency gaps** | External systems/teams we need but haven't confirmed |

### Step 3: Produce/Update Gaps Document

Create or update: `docs/specs/<epic>/gaps.md` (or `docs/knowledge/gaps.md` if no epic yet)

Format:

```markdown
# Gaps & Open Questions: <Epic/Project Name>

**Last Updated:** YYYY-MM-DD
**Total Gaps:** [N] open, [N] resolved

## Critical (Blocks Design/Implementation)

| ID | Question | Category | Impacts | Source | Ask Who | Status |
|----|----------|----------|---------|--------|---------|--------|
| G-001 | [specific question] | [category] | [what's blocked] | [timeline ref] | [person/role] | open |
| G-002 | ... | ... | ... | ... | ... | open |

## Important (Needed Before Milestone Completion)

| ID | Question | Category | Impacts | Source | Ask Who | Status |
|----|----------|----------|---------|--------|---------|--------|
| G-010 | ... | ... | ... | ... | ... | open |

## Nice to Know (Clarification, Not Blocking)

| ID | Question | Category | Impacts | Source | Ask Who | Status |
|----|----------|----------|---------|--------|---------|--------|
| G-020 | ... | ... | ... | ... | ... | open |

## Resolved

| ID | Question | Answer | Answered By | Date | Updated In |
|----|----------|--------|-------------|------|------------|
| G-003 | [question] | [answer] | [person] | YYYY-MM-DD | [which doc was updated] |
```

### Step 4: Report to Builder

Summarize:
- "[N] new gaps found, [N] total open"
- "Critical blockers: [list the most important 1-3]"
- "Recommended: bring these to your next meeting with [stakeholder]"
- If applicable: "I can prepare a meeting briefing — run `prepare-meeting`"

## Resolving Gaps

When the builder provides answers (after a meeting, chat, etc.):

1. Update the gap status to `resolved`
2. Record the answer, who provided it, and the date
3. Update the relevant knowledge base document
4. If the answer changes the PRD → flag: "This answer affects [story X]. PRD should be updated."
5. If the answer unblocks kanban tasks → flag: "T-004 is now unblocked."

## Auto-Detection During Other Skills

Other OMT skills should call gap detection logic:
- `omt-digest`: after processing, check for new gaps
- `omt-prd`: during generation, flag assumptions as gaps
- `omt-work`: when hitting an unknown, create a gap entry

## Rules

- Every gap MUST have an "Impacts" field. Gaps without impact are noise.
- Prioritize ruthlessly. A builder's time with stakeholders is limited — surface what matters most.
- Never close a gap without recording the answer. The answer becomes knowledge.
- Frame questions clearly enough that a non-technical person can answer them.
- If a gap has been open for multiple sessions, escalate its priority and suggest action.
