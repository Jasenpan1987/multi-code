// What a paired phone is shown for an OpenCode 2 dialog, and the request behind it
// for the secretary.
//
// The dialogs come from the user's shared OpenCode service: `permission.asked` and
// `form.created` on its event stream, or its pending lists after a reconnect
// (backends/opencodeAttention.ts). Both are answered through the service's API by
// the request's id (secretary/dialog.ts, for the secretary and a paired phone alike),
// so every prompt reported here carries a DialogRef and no keystrokes are involved. Shapes
// as OpenCode 2.0.32 sends them: docs/timeline/2026-10-20_opencode-v2-spike.md
// (G-603) and the fixtures in __fixtures__/opencode-v2/.

import type { PromptToolCall } from "./types";
import type { PromptDetail } from "../remote/promptExtract";
import type { FormInfo, PermissionRequest } from "./opencodeService";

// Tool names this module reports. The answer path dispatches on them
// (secretary/dialog.ts), so the values are load-bearing rather than cosmetic.
export const PERMISSION_TOOL = "Permission";
export const QUESTION_TOOL_LABEL = "Question";
// A question box with a multi-select field, or several questions in one form. Named
// apart from the one-question box for the summary line; both are answered whole, in
// one go through the API, from the questions in the tool call (formToolCall).
export const MULTI_QUESTION_TOOL_LABEL = "Question (multi-select)";

// Same shape as the Claude side's PromptDetail (the activity callback carries
// either), so it's imported rather than redeclared.
export type OpencodePromptDetail = PromptDetail;

const MAX_QUESTION_CHARS = 240;

// The TUI's own labels, in its order (packages/tui/src/routes/session/permission.tsx:
// 232-240). "Always allow" is there only when the request has something to save; with
// nothing to save the TUI offers Allow once / Reject (permission-no-save), and an
// `always` reply would act as `once` anyway. The answer path maps these labels back
// to decisions (secretary/dialog.ts), so they must stay exactly these strings.
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

// The summary of a form: its first question and that question's options. Only a
// question form has options to show. The whole box, every question of it, reaches
// the secretary and a paired phone through formToolCall. No "Type your own answer"
// row: an API answer takes typed text directly, so there is no row to pick for it.
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
