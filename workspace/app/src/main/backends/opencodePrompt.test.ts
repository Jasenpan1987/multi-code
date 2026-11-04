// What a paired phone is shown for an OpenCode 2 dialog, and the request the secretary
// gets with it. The dialogs are the ones OpenCode 2.0.32's service published (T-601
// fixtures, __fixtures__/opencode-v2/); the shapes are the ones the answer path reads
// (secretary/dialog.ts, opencode-v2 T-607).

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  formDetail,
  formToolCall,
  isQuestionForm,
  MULTI_QUESTION_TOOL_LABEL,
  PERMISSION_TOOL,
  permissionDetail,
  permissionToolCall,
  QUESTION_TOOL_LABEL,
} from "./opencodePrompt";
import { toFormInfo, toPermissionRequest, type FormInfo, type PermissionRequest } from "./opencodeService";
import { dialogOf } from "../secretary/dialog";
import { opencodeBackend } from "./opencode";

function firstEvent(fixture: string, type: string): Record<string, unknown> {
  const { frames } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "__fixtures__/opencode-v2", `${fixture}.json`), "utf8")
  ) as { frames: { event?: { type: string; data: Record<string, unknown> } }[] };
  const frame = frames.find((f) => f.event?.type === type);
  if (!frame?.event) throw new Error(`${fixture} has no ${type}`);
  return frame.event.data;
}

function permissionOf(fixture: string): PermissionRequest {
  const request = toPermissionRequest(firstEvent(fixture, "permission.asked"));
  if (!request) throw new Error(`${fixture}: permission.asked doesn't parse`);
  return request;
}

function formOf(fixture: string): FormInfo {
  const form = toFormInfo(firstEvent(fixture, "form.created").form);
  if (!form) throw new Error(`${fixture}: form.created doesn't parse`);
  return form;
}

describe("permissionDetail", () => {
  it("names what is asked and offers the TUI's three options when there is a pattern to save", () => {
    const detail = permissionDetail(permissionOf("permission-once"));
    expect(detail.tool).toBe(PERMISSION_TOOL);
    expect(detail.question).toBe("Permission required: shell: touch once.txt");
    expect(detail.options.map((o) => o.label)).toEqual(["Allow once", "Always allow", "Reject"]);
  });

  it("says what each option does in OpenCode 2", () => {
    const [once, always, reject] = permissionDetail(permissionOf("permission-once")).options;
    expect(once.description).toBe("Permit this one action");
    // Saved per project with no expiry (permission-always), not "until restart" as 1.x.
    expect(always.description).toBe(
      'OpenCode saves "touch *" for this project and allows it from now on'
    );
    // Without a reason the turn stops (permission-reject); with one the agent goes on.
    expect(reject.description).toMatch(/turn stops.*reason/);
  });

  it("offers Allow once / Reject alone when the request has nothing to save", () => {
    // permission-no-save: `permission.asked` carries no `save` key at all.
    const request = permissionOf("permission-no-save");
    expect(request.save).toBeUndefined();
    const detail = permissionDetail(request);
    expect(detail.question).toBe("Permission required: question: *");
    expect(detail.options.map((o) => o.label)).toEqual(["Allow once", "Reject"]);
    expect(permissionDetail({ ...request, save: [] }).options).toHaveLength(2);
  });

  it("joins several resources and caps the question", () => {
    const base = permissionOf("permission-once");
    expect(permissionDetail({ ...base, resources: ["a", "b"] }).question).toBe(
      "Permission required: shell: a, b"
    );
    expect(permissionDetail({ ...base, resources: [] }).question).toBe("Permission required: shell");
    const long = permissionDetail({ ...base, resources: ["x".repeat(500)] }).question!;
    expect(long).toHaveLength(240);
  });

  it("is read by its labels, in both shapes", () => {
    // The shapes secretary/dialog.ts reads (T-607), which a paired phone answers with.
    const effects = (fixture: string) => {
      const request = permissionOf(fixture);
      const call = permissionToolCall(request);
      const event = {
        kind: "needs-you" as const,
        seq: 1,
        at: 0,
        prompt: { detail: permissionDetail(request), ...call },
      };
      const dialog = dialogOf(event, "opencode");
      return dialog?.kind === "permission" ? dialog.options.map((o) => o.effect) : null;
    };
    expect(effects("permission-once")).toEqual(["allow-once", "allow-always", "deny"]);
    expect(effects("permission-no-save")).toEqual(["allow-once", "deny"]);
  });
});

describe("permissionToolCall", () => {
  it("carries the action, what it touches, and the request's own session and id", () => {
    const request = permissionOf("subagent-permission");
    expect(permissionToolCall(request)).toEqual({
      toolName: "shell",
      toolInput: { resources: ["ls -la sub-once.txt"], metadata: undefined, save: ["ls *"] },
      // The subagent's session, which is the one the reply has to name.
      dialog: {
        kind: "permission",
        sessionId: "ses_eaabb5cbbffeN3yPU2VkSyVIdK",
        requestId: "per_15544b792001B1484uLFDySezd",
      },
    });
  });
});

describe("formDetail", () => {
  it("a single-select question: its options and no free-text row", () => {
    const form = formOf("question-single");
    expect(isQuestionForm(form)).toBe(true);
    expect(formDetail(form)).toEqual({
      tool: QUESTION_TOOL_LABEL,
      question: "Which fruit do you prefer?",
      options: [
        { label: "Apple", description: "Choose Apple" },
        { label: "Banana", description: "Choose Banana" },
        { label: "Cherry", description: "Choose Cherry" },
      ],
    });
  });

  it("a multi-select question is shown read-only, with its options", () => {
    const detail = formDetail(formOf("question-multi"));
    expect(detail?.tool).toBe(MULTI_QUESTION_TOOL_LABEL);
    expect(detail?.options.map((o) => o.label)).toEqual(["Cheese", "Ham", "Olives"]);
  });

  it("a form of two questions is shown read-only, with the first", () => {
    const detail = formDetail(formOf("question-two"));
    expect(detail).toMatchObject({
      tool: MULTI_QUESTION_TOOL_LABEL,
      question: "Which drink would you like?",
      options: [{ label: "Tea" }, { label: "Coffee" }],
    });
  });

  it("falls back to the header when a question has no text", () => {
    const form = formOf("question-single");
    const [field] = form.fields;
    const detail = formDetail({ ...form, fields: [{ ...field, description: undefined }] });
    expect(detail?.question).toBe("Favorite fruit");
  });

  it("has nothing to offer for a question without options, or a form that isn't a question", () => {
    const form = formOf("question-single");
    expect(formDetail({ ...form, fields: [{ ...form.fields[0], options: [] }] })).toBeUndefined();
    expect(formDetail({ ...form, fields: [] })).toBeUndefined();
    const elicitation: FormInfo = {
      id: "frm_mcp",
      sessionID: "ses_1",
      title: "Log in",
      fields: [{ key: "token", type: "string", options: [{ value: "a", label: "a" }] }],
    };
    expect(isQuestionForm(elicitation)).toBe(false);
    expect(formDetail(elicitation)).toBeUndefined();
  });
});

describe("formToolCall", () => {
  it("a question form reads as AskUserQuestion's input, questions in field order", () => {
    const form = formOf("question-two");
    const call = formToolCall(form);
    expect(call).toEqual({
      toolName: "question",
      toolInput: {
        questions: [
          {
            question: "Which drink would you like?",
            header: "Drink",
            options: [
              { label: "Tea", description: "A hot cup of tea" },
              { label: "Coffee", description: "A hot cup of coffee" },
            ],
            multiple: false,
          },
          {
            question: "Which size would you like?",
            header: "Size",
            options: expect.any(Array),
            multiple: false,
          },
        ],
      },
      dialog: { kind: "form", sessionId: form.sessionID, requestId: form.id },
    });
  });

  it("marks a multi-select question", () => {
    const call = formToolCall(formOf("question-multi"));
    expect((call.toolInput as { questions: { multiple: boolean }[] }).questions[0].multiple).toBe(true);
  });

  it("passes any other form on as it is", () => {
    const fields = [{ key: "token", type: "string", title: "API token" }];
    expect(formToolCall({ id: "frm_mcp", sessionID: "ses_1", title: "Log in", fields })).toEqual({
      toolName: "form",
      toolInput: { title: "Log in", fields },
      dialog: { kind: "form", sessionId: "ses_1", requestId: "frm_mcp" },
    });
  });
});

// A paired phone's Stop (mobile-v2 Story 6): two Escs, far enough apart that they
// aren't read as one Alt+Esc, well inside the 5 s the TUI counts them in (G-303).
describe("interrupt", () => {
  it("is Esc twice, 250 ms apart, as measured", () => {
    expect(opencodeBackend.interrupt).toEqual({ keys: ["\x1b", "\x1b"], gapMs: 250 });
  });
});
