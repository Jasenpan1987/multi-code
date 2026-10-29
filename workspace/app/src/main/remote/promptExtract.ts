// Turns the tool_use that blocked the agent into the dialog's one-line summary and
// options (PromptDetail): what the secretary's dialog reader (secretary/dialog.ts)
// starts from, and the line a paired phone shows. It parses the session's hook
// payload, structured data the CLI sends for its own use. Answering is not done
// here: secretary/dialog.ts plans the keys, with flows measured on the CLI.

import type { PromptOption } from "../../shared/remote-protocol";

export interface PromptDetail {
  tool: string;
  question?: string;
  options: PromptOption[];
}

// Permission prompts (Bash, Write, Edit, …) all render the same three-choice
// box. The exact wording differs slightly per tool but the positions don't. How
// long "don't ask again" lasts differs too (a Bash rule is kept for the project,
// edits are allowed for the session), so its description doesn't say.
const PERMISSION_OPTIONS: PromptOption[] = [
  { label: "Yes", description: "Allow this once" },
  { label: "Yes, and don't ask again", description: "Allow it, and stop asking for calls like it" },
  { label: "No", description: "Reject and tell the agent what to do instead" },
];

// In the CLI's order, which puts auto-accept first (in auto mode it reads "Yes, and
// use auto mode"): docs/timeline/2026-10-10_reply-key-flows-spike.md. This list had
// the first two the other way round, so the phone's plain "Yes" picked auto-accept.
const PLAN_OPTIONS: PromptOption[] = [
  { label: "Yes, auto-accept edits", description: "Approve and skip edit prompts" },
  { label: "Yes, manually approve edits", description: "Approve and ask before each edit" },
  { label: "No", description: "Keep planning and say what to change" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Pull the options out of an AskUserQuestion payload. Only the first question is
// used: the CLI presents questions one box at a time, so the first unanswered
// one is what the user is actually staring at.
function extractAskUserQuestion(
  input: Record<string, unknown>
): PromptDetail | null {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const first = asRecord(questions[0]);
  if (!first) return null;

  const rawOptions = Array.isArray(first.options) ? first.options : [];
  const options: PromptOption[] = [];
  for (const raw of rawOptions) {
    const option = asRecord(raw);
    if (!option) continue;
    const label = asString(option.label);
    if (!label) continue;
    options.push({ label, description: asString(option.description) });
  }

  // The CLI appends its own "Other" escape hatch to every question box, so the
  // phone should offer it too — otherwise the option indices the phone sends
  // would line up with a shorter list than the one on screen.
  options.push({ label: "Other", description: "Type a custom answer instead" });

  return {
    tool: "AskUserQuestion",
    question: asString(first.question) ?? asString(first.header),
    options,
  };
}

// Best-effort one-line summary of what a tool is about to do, so the phone shows
// "Bash: rm -rf build" instead of a bare "Bash".
function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown> | null
): string | undefined {
  if (!input) return undefined;
  switch (toolName) {
    case "Bash":
      return asString(input.command);
    case "Write":
    case "Edit":
    case "Read":
    case "NotebookEdit":
      return asString(input.file_path);
    case "WebFetch":
      return asString(input.url);
    case "Task":
      return asString(input.description);
    default:
      return asString(input.description) ?? asString(input.command);
  }
}

// Map a blocked tool_use to a renderable prompt. Returns null when the tool
// carries no user-facing decision, in which case the phone just shows the raw
// terminal and the user types.
export function extractPromptDetail(
  toolName: string,
  rawInput: unknown
): PromptDetail | null {
  const input = asRecord(rawInput);

  if (toolName === "AskUserQuestion" && input) {
    const detail = extractAskUserQuestion(input);
    if (detail) return detail;
  }

  if (toolName === "ExitPlanMode") {
    return {
      tool: "ExitPlanMode",
      question: "Ready to code?",
      options: PLAN_OPTIONS,
    };
  }

  if (!toolName) return null;

  // Anything else that sits unpaired is the CLI waiting on a permission
  // decision for that tool.
  const summary = summarizeToolInput(toolName, input);
  return {
    tool: toolName,
    question: summary ? `${toolName}: ${summary}` : `Allow ${toolName}?`,
    options: PERMISSION_OPTIONS,
  };
}
