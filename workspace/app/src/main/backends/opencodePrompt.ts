// What a paired phone is shown for an OpenCode 2 dialog, and the request behind it
// for the secretary.
//
// The dialogs come from the user's shared OpenCode service: `permission.asked` and
// `form.created` on its event stream, or its pending lists after a reconnect
// (backends/opencodeAttention.ts). Both are answered through the service's API by
// the request's id (backends/opencodeAnswer.ts, secretary/dialog.ts), so every
// prompt reported here carries a DialogRef and no keystrokes are involved. Shapes
// as OpenCode 2.0.32 sends them: docs/timeline/2026-10-20_opencode-v2-spike.md
// (G-603) and the fixtures in __fixtures__/opencode-v2/.

import type { PromptToolCall } from "./types";
import type { PromptDetail } from "../remote/promptExtract";
import type { FormInfo, PermissionRequest } from "./opencodeService";

// Tool names this module reports. The answer paths dispatch on them (opencodeAnswer.ts,
// secretary/dialog.ts), so the values are load-bearing rather than cosmetic.
export const PERMISSION_TOOL = "Permission";
export const QUESTION_TOOL_LABEL = "Question";
// A question box one tap can't answer: a multi-select field, or several questions in
// one form. Reported under its own name so the phone's answer path refuses it and
// shows it read-only; the secretary still answers it in one go through the API.
export const MULTI_QUESTION_TOOL_LABEL = "Question (multi-select)";

// Same shape as the Claude side's PromptDetail (the activity callback carries
// either), so it's imported rather than redeclared.
export type OpencodePromptDetail = PromptDetail;

const MAX_QUESTION_CHARS = 240;

// The TUI's own labels, in its order (packages/tui/src/routes/session/permission.tsx:
// 232-240). "Always allow" is there only when the request has something to save; with
// nothing to save the TUI offers Allow once / Reject (permission-no-save), and an
// `always` reply would act as `once` anyway. The answer paths map these labels back
// to decisions, so they must stay exactly these strings.
const ALLOW_ONCE = "Allow once";
const ALWAYS_ALLOW = "Always allow";
const REJECT = "Reject";

// The descriptions say what each choice does in OpenCode 2, which is not what 1.x
// did: `always` saves the pattern per project with no expiry (permission-always: the
// rule lands in the DB `permission` table), and a Reject without a reason ends the
// turn (permission-reject: `execution.interrupted{shutdown}`), while one with a reason
// lets the agent carry on (permission-api-reject-reason).
function alwaysDescription(save: string[]): string {
  const patterns = save.map((p) => `"${p}"`).join(", ");
  return `OpenCode saves ${patterns} for this project and allows it from now on`.slice(
    0,
    MAX_QUESTION_CHARS
  );
}

// A permission request: `{id, sessionID, action: "shell", resources: ["touch a.txt"],
// save?: ["touch *"], metadata?}`. A request with no `save` key at all is a real shape
// (the question tool's own check, permission-no-save), not a malformed one.
export function permissionDetail(request: PermissionRequest): OpencodePromptDetail {
  const resources = request.resources.filter((r) => r.length > 0);
  const subject = [request.action, resources.join(", ")].filter(Boolean).join(": ");
  const save = (request.save ?? []).filter((p) => p.length > 0);
  const options: OpencodePromptDetail["options"] = [
    { label: ALLOW_ONCE, description: "Permit this one action" },
  ];
  if (save.length > 0) options.push({ label: ALWAYS_ALLOW, description: alwaysDescription(save) });
  options.push({
    label: REJECT,
    description: "Refuse: the turn stops, or the agent is told why when a reason is given",
  });
  return {
    tool: PERMISSION_TOOL,
    question: (subject ? `Permission required: ${subject}` : "Permission required").slice(
      0,
      MAX_QUESTION_CHARS
    ),
    options,
  };
}

// The request for the secretary: what the permission guards (`shell`, `edit`, …) and
// the specifics, plus the ref the answer goes to. The ref names the request's own
// session, a subagent's included: a reply to another session's request is a 404.
export function permissionToolCall(request: PermissionRequest): PromptToolCall {
  return {
    toolName: request.action,
    toolInput: { resources: request.resources, metadata: request.metadata, save: request.save },
    dialog: { kind: "permission", sessionId: request.sessionID, requestId: request.id },
  };
}

// The question tool asks through a form tagged `metadata.kind: "question"`, one field
// per question (`q0`, `q1`, …), `title` the header, `description` the question,
// `type` "string" or "multiselect" (question-single, question-multi, question-two).
// Any other form is an MCP elicitation or a plugin's, with fields of its own.
export function isQuestionForm(form: FormInfo): boolean {
  return form.metadata?.kind === "question";
}

function fieldOptions(field: FormInfo["fields"][number]): OpencodePromptDetail["options"] {
  const options: OpencodePromptDetail["options"] = [];
  for (const option of field.options ?? []) {
    if (!option.label) continue;
    options.push(
      option.description ? { label: option.label, description: option.description } : { label: option.label }
    );
  }
  return options;
}

// What the phone shows for a form. Only a question form has options to show, and
// only the first field's: the phone answers one single-select question with one tap
// (field `q0`, opencodeAnswer.ts) and shows anything bigger read-only. No "Type your
// own answer" row: OpenCode 1.x's TUI listed one and the phone navigated to it, but an
// API answer takes typed text directly, so the phone has nothing to tap for it.
// Undefined when there is nothing to offer: the phone then shows the terminal.
export function formDetail(form: FormInfo): OpencodePromptDetail | undefined {
  if (!isQuestionForm(form)) return undefined;
  const first = form.fields[0];
  if (!first) return undefined;
  const options = fieldOptions(first);
  if (options.length === 0) return undefined;
  const oneTap = form.fields.length === 1 && first.type === "string";
  const question = first.description || first.title;
  return {
    tool: oneTap ? QUESTION_TOOL_LABEL : MULTI_QUESTION_TOOL_LABEL,
    ...(question ? { question: question.slice(0, MAX_QUESTION_CHARS) } : {}),
    options,
  };
}

// The request for the secretary. A question form is told as Claude's AskUserQuestion
// input is (`questions`, with `multiple` as OpenCode 1.x named it), in field order, so
// the secretary's answer for question `i` goes to field `q<i>`. Any other form is
// passed as it is: the secretary doesn't answer those, but a brief can name them.
export function formToolCall(form: FormInfo): PromptToolCall {
  const dialog = { kind: "form" as const, sessionId: form.sessionID, requestId: form.id };
  if (!isQuestionForm(form)) {
    return { toolName: "form", toolInput: { title: form.title, fields: form.fields }, dialog };
  }
  const questions = form.fields.map((field) => ({
    question: field.description,
    header: field.title,
    options: fieldOptions(field),
    multiple: field.type === "multiselect",
  }));
  return { toolName: "question", toolInput: { questions }, dialog };
}

// ── OpenCode 1.x keystrokes ──────────────────────────────────────────────────
//
// Still named by backends/opencode.ts `keystrokeForChoice`, which T-610 deletes along
// with these: OpenCode 2's dialogs are answered through the API above, and its keys
// differ anyway (spike, G-603). Measured on 1.18.35 (T-411): a permission is a
// horizontal row navigated with Right, a single-select question a vertical list
// navigated with Down; digits do nothing in either.

// The 1.x dialog's options, left to right. Not OpenCode 2's labels.
const PERMISSION_LABELS = ["Allow once", "Allow always", "Reject"] as const;

// Right arrows from the first option to `index`, then Enter. 1.x's "Allow always"
// opened a confirmation screen, hence its second Enter. Null when the index is out
// of range, so the caller declines rather than confirm whatever is highlighted.
export function keystrokeForPermission(index: number, optionCount: number): string | null {
  if (!Number.isInteger(index)) return null;
  if (index < 0 || index >= optionCount) return null;
  const confirm = PERMISSION_LABELS[index] === "Allow always" ? "\r" : "";
  return "\x1b[C".repeat(index) + "\r" + confirm;
}

// Down arrows from the first option to `index`, then Enter. Single-select only: a 1.x
// multi-select box toggles on Enter and submits from a second stage, so it is
// reported under MULTI_QUESTION_TOOL_LABEL and gets no keys at all.
export function keystrokeForQuestion(index: number, optionCount: number): string | null {
  if (!Number.isInteger(index)) return null;
  if (index < 0 || index >= optionCount) return null;
  return "\x1b[B".repeat(index) + "\r";
}
