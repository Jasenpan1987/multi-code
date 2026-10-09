import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../process-manager", () => ({}));

import { interpretReply, parseInterpretation, promptInput, REPLY_PROMPT } from "./replyInterpreter";
import type { Dialog } from "./dialog";

const QUESTIONS: Dialog = {
  kind: "questions",
  backend: "claude",
  questions: [
    { question: "Which framework?", multiSelect: false, options: [{ label: "React" }, { label: "Vue" }] },
  ],
};

describe("the prompt", () => {
  it("is the one the live cases passed on, byte for byte", () => {
    // replyInterpreter.live.test.ts: 18 of 18, twice, on 2026-10-10 (T-532, the STE80
    // template). A deliberate change gets a new hash here and a fresh live run.
    expect(crypto.createHash("sha256").update(REPLY_PROMPT).digest("hex")).toBe(
      "8c7e55fb61b480b9d85a2e9484542ec9cc32228a6068dd66fb2f4b41fd87f22d"
    );
  });
});

describe("promptInput", () => {
  it("numbers questions and options from 1, as the builder hears them", () => {
    expect(promptInput({ dialog: QUESTIONS, brief: "b", earlier: [], reply: "Vue" })).toEqual({
      dialog: {
        kind: "questions",
        questions: [
          {
            number: 1,
            question: "Which framework?",
            multiSelect: false,
            options: [
              { number: 1, label: "React" },
              { number: 2, label: "Vue" },
            ],
          },
        ],
      },
      brief: "b",
      earlier: [],
      reply: "Vue",
    });
  });

  it("clips a long tool input, which can be a whole file", () => {
    const dialog: Dialog = {
      kind: "permission",
      backend: "claude",
      toolName: "Write",
      toolInput: { content: "x".repeat(20_000) },
      options: [{ effect: "allow-once", label: "Yes" }],
    };
    const input = promptInput({ dialog, brief: "", earlier: [], reply: "?" }) as {
      dialog: { input: { content: string } };
    };
    expect(input.dialog.input.content.length).toBeLessThan(7_000);
  });
});

describe("parseInterpretation", () => {
  it("reads each action", () => {
    expect(parseInterpretation({ action: "ask", message: "Which one?" })).toEqual({
      ok: true,
      action: "ask",
      message: "Which one?",
    });
    expect(
      parseInterpretation({ action: "choose", effect: "deny", feedback: "use wget", explicit: false, message: "Denied." })
    ).toEqual({
      ok: true,
      action: "choose",
      choice: { effect: "deny", feedback: "use wget", explicit: false },
      message: "Denied.",
    });
    expect(
      parseInterpretation({
        action: "choose",
        answers: [{ question: 1, picks: [2], text: "" }],
        message: "Vue.",
      })
    ).toEqual({
      ok: true,
      action: "choose",
      choice: { answers: [{ question: 1, picks: [2], text: "" }] },
      message: "Vue.",
    });
  });

  it("fails anything else, so nothing is pressed", () => {
    expect(parseInterpretation({ action: "choose", effect: "allow-once" }).ok).toBe(false);
    expect(parseInterpretation({ action: "press", message: "x" }).ok).toBe(false);
    expect(parseInterpretation({ action: "choose", effect: "yolo", message: "x" }).ok).toBe(false);
    expect(parseInterpretation({ action: "choose", answers: [{ picks: [1] }], message: "x" }).ok).toBe(false);
    expect(
      parseInterpretation({ action: "choose", answers: [{ question: 1, picks: ["2"] }], message: "x" }).ok
    ).toBe(false);
    expect(parseInterpretation({ action: "choose", message: "x" }).ok).toBe(false);
    // Feedback that isn't text would be dropped while the message says it was sent.
    expect(
      parseInterpretation({ action: "choose", effect: "deny", feedback: { text: "use wget" }, message: "x" }).ok
    ).toBe(false);
    // Not normalized into something pressable: picks 1 dropped would submit text alone.
    expect(
      parseInterpretation({ action: "choose", answers: [{ question: 1, picks: 1, text: "GraphQL" }], message: "x" }).ok
    ).toBe(false);
    expect(
      parseInterpretation({ action: "choose", answers: [{ question: 1, picks: [], text: 3 }], message: "x" }).ok
    ).toBe(false);
  });
});

describe("interpretReply", () => {
  it("passes the CLI's failure through and never throws", async () => {
    const failing = async () => ({ ok: false as const, reason: "timed out after 60 s" });
    await expect(
      interpretReply({ dialog: QUESTIONS, brief: "", earlier: [], reply: "Vue" }, { run: failing })
    ).resolves.toEqual({ ok: false, reason: "timed out after 60 s" });
    const throwing = async () => {
      throw new Error("spawn ENOENT");
    };
    await expect(
      interpretReply({ dialog: QUESTIONS, brief: "", earlier: [], reply: "Vue" }, { run: throwing })
    ).resolves.toEqual({ ok: false, reason: "spawn ENOENT" });
  });
});
