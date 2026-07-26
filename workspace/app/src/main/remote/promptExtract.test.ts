import { describe, expect, it } from "vitest";
import { extractPromptDetail, keystrokeForOption } from "./promptExtract";

describe("extractPromptDetail", () => {
  it("reads options out of an AskUserQuestion payload", () => {
    const detail = extractPromptDetail("AskUserQuestion", {
      questions: [
        {
          question: "Which database?",
          header: "DB",
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "Embedded" },
          ],
        },
      ],
    });

    expect(detail?.tool).toBe("AskUserQuestion");
    expect(detail?.question).toBe("Which database?");
    // The CLI appends its own "Other" entry, so the phone's indices must line
    // up with a list that includes it.
    expect(detail?.options.map((o) => o.label)).toEqual([
      "Postgres",
      "SQLite",
      "Other",
    ]);
    expect(detail?.options[0].description).toBe("Relational");
  });

  it("falls back to the header when a question has no question text", () => {
    const detail = extractPromptDetail("AskUserQuestion", {
      questions: [{ header: "Auth method", options: [{ label: "OAuth" }] }],
    });
    expect(detail?.question).toBe("Auth method");
  });

  it("skips malformed option entries rather than emitting blank buttons", () => {
    const detail = extractPromptDetail("AskUserQuestion", {
      questions: [
        {
          question: "Pick",
          options: [{ label: "Real" }, { description: "no label" }, null, "str"],
        },
      ],
    });
    expect(detail?.options.map((o) => o.label)).toEqual(["Real", "Other"]);
  });

  it("treats a four-option question as four options plus Other", () => {
    const detail = extractPromptDetail("AskUserQuestion", {
      questions: [
        {
          question: "Which approach?",
          options: [
            { label: "A" },
            { label: "B" },
            { label: "C" },
            { label: "D" },
          ],
        },
      ],
    });
    expect(detail?.options).toHaveLength(5);
  });

  it("maps ExitPlanMode to the plan-approval choices", () => {
    const detail = extractPromptDetail("ExitPlanMode", { plan: "do things" });
    expect(detail?.tool).toBe("ExitPlanMode");
    expect(detail?.options).toHaveLength(3);
  });

  it("summarizes a Bash permission prompt with the command", () => {
    const detail = extractPromptDetail("Bash", { command: "rm -rf build" });
    expect(detail?.tool).toBe("Bash");
    expect(detail?.question).toBe("Bash: rm -rf build");
    expect(detail?.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and don't ask again",
      "No",
    ]);
  });

  it("summarizes file tools with the path", () => {
    const detail = extractPromptDetail("Edit", { file_path: "/tmp/a.ts" });
    expect(detail?.question).toBe("Edit: /tmp/a.ts");
  });

  it("degrades to a generic permission question with no usable input", () => {
    const detail = extractPromptDetail("MysteryTool", null);
    expect(detail?.question).toBe("Allow MysteryTool?");
    expect(detail?.options).toHaveLength(3);
  });

  it("returns null when there is no tool name", () => {
    expect(extractPromptDetail("", {})).toBeNull();
  });

  it("falls back to permission options when questions is empty", () => {
    // An AskUserQuestion with no questions can't be rendered as its own choices,
    // so it must not produce an empty option list the phone would show as a
    // prompt with no buttons.
    const detail = extractPromptDetail("AskUserQuestion", { questions: [] });
    expect(detail?.options.length).toBeGreaterThan(0);
  });
});

describe("keystrokeForOption", () => {
  it("maps an index to its 1-based option number", () => {
    expect(keystrokeForOption(0, 4)).toBe("1");
    expect(keystrokeForOption(3, 4)).toBe("4");
  });

  it("rejects an out-of-range index", () => {
    expect(keystrokeForOption(-1, 3)).toBeNull();
    expect(keystrokeForOption(3, 3)).toBeNull();
  });

  it("rejects a non-integer index", () => {
    expect(keystrokeForOption(1.5, 4)).toBeNull();
  });

  it("declines when a prompt has no options", () => {
    expect(keystrokeForOption(0, 0)).toBeNull();
  });

  it("declines past 9 options, where digit keys stop being unambiguous", () => {
    expect(keystrokeForOption(0, 10)).toBeNull();
  });
});
