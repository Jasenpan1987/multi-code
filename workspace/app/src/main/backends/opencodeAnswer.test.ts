// A phone tap on an OpenCode dialog becomes an API answer: the shapes are the ones
// opencodePrompt.ts reports for OpenCode 2 (opencode-v2 T-604), the answers the ones
// the service's reply endpoints take (docs/timeline/2026-10-20_opencode-v2-source-reading.md).

import { describe, expect, it } from "vitest";
import { answerForChoice } from "./opencodeAnswer";
import { MULTI_QUESTION_TOOL_LABEL, PERMISSION_TOOL, QUESTION_TOOL_LABEL } from "./opencodePrompt";
import type { DialogRef } from "./types";
import type { PromptDetail } from "../remote/promptExtract";

const PERMISSION_REF: DialogRef = { kind: "permission", sessionId: "ses_1", requestId: "per_1" };
const FORM_REF: DialogRef = { kind: "form", sessionId: "ses_1", requestId: "frm_1" };

const permission = (labels: string[]): PromptDetail => ({
  tool: PERMISSION_TOOL,
  question: "Permission required: shell: rm -rf build",
  options: labels.map((label) => ({ label })),
});

const question = (tool: string, labels: string[]): PromptDetail => ({
  tool,
  question: "Which db?",
  options: labels.map((label) => ({ label, description: `${label} option` })),
});

describe("answerForChoice", () => {
  it("answers a three-option permission by the tapped option's label", () => {
    const detail = permission(["Allow once", "Always allow", "Reject"]);
    expect(answerForChoice(detail, PERMISSION_REF, 0)).toEqual({ kind: "permission", decision: "once" });
    expect(answerForChoice(detail, PERMISSION_REF, 1)).toEqual({ kind: "permission", decision: "always" });
    expect(answerForChoice(detail, PERMISSION_REF, 2)).toEqual({ kind: "permission", decision: "reject" });
  });

  it("answers a two-option permission, with no always, by label and not by position", () => {
    const detail = permission(["Allow once", "Reject"]);
    expect(answerForChoice(detail, PERMISSION_REF, 0)).toEqual({ kind: "permission", decision: "once" });
    // The second button is Reject here, not Always allow.
    expect(answerForChoice(detail, PERMISSION_REF, 1)).toEqual({ kind: "permission", decision: "reject" });
  });

  it("refuses an index out of range, or not a whole number", () => {
    const detail = permission(["Allow once", "Always allow", "Reject"]);
    for (const index of [-1, 3, 7, 0.5, Number.NaN]) {
      expect(answerForChoice(detail, PERMISSION_REF, index), String(index)).toBeNull();
    }
    expect(answerForChoice(permission(["Allow once", "Reject"]), PERMISSION_REF, 2)).toBeNull();
    expect(answerForChoice(question(QUESTION_TOOL_LABEL, ["Postgres"]), FORM_REF, 1)).toBeNull();
  });

  it("refuses a label it doesn't know rather than guess the decision", () => {
    // OpenCode 1.x's label, and anything else.
    const detail = permission(["Allow once", "Allow always", "Reject", "Something new"]);
    expect(answerForChoice(detail, PERMISSION_REF, 1)).toBeNull();
    expect(answerForChoice(detail, PERMISSION_REF, 3)).toBeNull();
  });

  it("answers a single-select question with the option's label as field q0", () => {
    const detail = question(QUESTION_TOOL_LABEL, ["Postgres", "SQLite"]);
    expect(answerForChoice(detail, FORM_REF, 1)).toEqual({ kind: "form", answer: { q0: "SQLite" } });
  });

  it("refuses a multi-select question or a box of several questions: one tap can't answer them", () => {
    const detail = question(MULTI_QUESTION_TOOL_LABEL, ["Postgres", "SQLite"]);
    expect(answerForChoice(detail, FORM_REF, 0)).toBeNull();
  });

  it("refuses a ref of the other kind, and a dialog it doesn't know", () => {
    expect(answerForChoice(permission(["Allow once", "Reject"]), FORM_REF, 0)).toBeNull();
    expect(answerForChoice(question(QUESTION_TOOL_LABEL, ["Postgres"]), PERMISSION_REF, 0)).toBeNull();
    expect(answerForChoice(question("Bash", ["Yes", "No"]), PERMISSION_REF, 0)).toBeNull();
  });
});
