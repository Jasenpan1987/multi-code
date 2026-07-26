// Turns the tool_use that blocked the agent into something a phone can render
// as buttons, and turns a button tap back into the keystrokes the CLI's TUI
// expects.
//
// FRAGILITY WARNING. The *reading* half is stable: it parses the session JSONL,
// which is structured data the CLI writes for its own use. The *answering* half
// (`keystrokeForOption`) is not — it depends on Claude Code's option boxes
// accepting number keys, which is a UI convention, not an API. If a CLI release
// changes its key handling, remote answering breaks while remote viewing keeps
// working. That is why the phone always keeps a raw terminal view: the buttons
// are a convenience layered on top, never the only way in.

import type { PromptOption } from "../../shared/remote-protocol";

export interface PromptDetail {
  tool: string;
  question?: string;
  options: PromptOption[];
}

// Permission prompts (Bash, Write, Edit, …) all render the same three-choice
// box. The exact wording differs slightly per tool but the positions don't.
const PERMISSION_OPTIONS: PromptOption[] = [
  { label: "Yes", description: "Allow this once" },
  { label: "Yes, and don't ask again", description: "Allow for this session" },
  { label: "No", description: "Reject and tell the agent what to do instead" },
];

const PLAN_OPTIONS: PromptOption[] = [
  { label: "Yes", description: "Approve the plan and start working" },
  { label: "Yes, with auto-accept edits", description: "Approve and skip edit prompts" },
  { label: "No", description: "Keep planning" },
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

// Keystrokes that select option `index` in an on-screen option box.
//
// Claude Code's boxes accept the option's number directly (1-based). Returns
// null for an out-of-range index or for boxes with more than 9 options, where
// digits stop being unambiguous — the caller then declines the request rather
// than sending a keystroke that might pick the wrong thing.
export function keystrokeForOption(
  index: number,
  optionCount: number
): string | null {
  if (!Number.isInteger(index)) return null;
  if (index < 0 || index >= optionCount) return null;
  if (optionCount > 9) return null;
  return String(index + 1);
}
