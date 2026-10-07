// What a paired phone is shown for an OpenCode dialog, and the keystrokes that answer
// it. The dialogs are the ones OpenCode 1.18.35 sent through Multi-Code's plugin
// (T-409 fixtures); the keystrokes were checked against the live TUI (T-411: each
// answered its dialog when sent 0.36s after the dialog's event).

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  keystrokeForPermission,
  keystrokeForQuestion,
  MULTI_QUESTION_TOOL_LABEL,
  PERMISSION_LABELS,
  PERMISSION_TOOL,
  permissionDetail,
  QUESTION_TOOL_LABEL,
  questionDetail,
} from "./opencodePrompt";
import { opencodeBackend } from "./opencode";

function asked(fixture: string, type: string): Record<string, unknown> {
  const { events } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "__fixtures__/opencode-plugin", `${fixture}.json`), "utf8")
  ) as { events: { type: string; properties: Record<string, unknown> }[] };
  const event = events.find((e) => e.type === type);
  if (!event) throw new Error(`${fixture} has no ${type}`);
  return event.properties;
}

describe("permissionDetail", () => {
  it("names what is asked and offers the dialog's three options in order", () => {
    const detail = permissionDetail(asked("permission-once", "permission.asked"));
    expect(detail.tool).toBe(PERMISSION_TOOL);
    expect(detail.question).toBe("Permission required: bash: touch a.txt");
    expect(detail.options.map((o) => o.label)).toEqual([...PERMISSION_LABELS]);
  });

  it("still offers the options when the event names nothing", () => {
    const detail = permissionDetail({});
    expect(detail.question).toBe("Permission required");
    expect(detail.options).toHaveLength(3);
  });
});

describe("questionDetail", () => {
  it("offers the question's options plus OpenCode's own free-text one", () => {
    const detail = questionDetail(asked("question", "question.asked"));
    expect(detail?.tool).toBe(QUESTION_TOOL_LABEL);
    expect(detail?.question).toBe("Do you prefer tea or coffee?");
    expect(detail?.options.map((o) => o.label)).toEqual(["tea", "coffee", "Type your own answer"]);
  });

  it("marks a box with several questions as not one tap", () => {
    // An Enter per question, then one more to submit (T-409, question-multi).
    expect(questionDetail(asked("question-multi", "question.asked"))?.tool).toBe(
      MULTI_QUESTION_TOOL_LABEL
    );
  });

  it("marks a multi-select question as not one tap", () => {
    const detail = questionDetail({
      questions: [{ question: "Fruit?", multiple: true, options: [{ label: "Apple" }] }],
    });
    expect(detail?.tool).toBe(MULTI_QUESTION_TOOL_LABEL);
  });

  it("is null when there is nothing to offer", () => {
    expect(questionDetail({})).toBeNull();
    expect(questionDetail({ questions: [{ question: "?", options: [] }] })).toBeNull();
  });
});

describe("keystrokeForPermission", () => {
  // Verified against a live dialog: it opens on "Allow once", right arrow moves
  // one step per press, and digits do nothing at all.
  it("sends only Enter for the option already selected", () => {
    expect(keystrokeForPermission(0, 3)).toBe("\r");
  });

  it("sends one right arrow per step to reach later options", () => {
    expect(keystrokeForPermission(2, 3)).toBe("\x1b[C\x1b[C\r");
  });

  it("confirms Allow always's second screen with another Enter", () => {
    // "This will allow the following patterns until OpenCode is restarted …
    // Confirm / Cancel": without it the dialog is left open on that screen.
    expect(keystrokeForPermission(1, 3)).toBe("\x1b[C\r\r");
  });

  it("never sends digits, which the dialog ignores", () => {
    for (let i = 0; i < 3; i++) {
      expect(keystrokeForPermission(i, 3)).not.toMatch(/[0-9]/);
    }
  });

  it("declines out-of-range and non-integer indices", () => {
    // Confirming the wrong option here grants or refuses the wrong thing, so
    // declining is the only safe answer.
    expect(keystrokeForPermission(3, 3)).toBeNull();
    expect(keystrokeForPermission(-1, 3)).toBeNull();
    expect(keystrokeForPermission(1.5, 3)).toBeNull();
    expect(keystrokeForPermission(0, 0)).toBeNull();
  });
});

describe("multi-select questions", () => {
  // Verified by driving a real `multiple: true` box: options render as
  // checkboxes ("1. [ ] Apple"), the hint changes from "enter submit" to "enter
  // toggle", and submitting is a second stage reached with Tab. One tap can't
  // express that, and sending the single-select keystrokes would tick a checkbox
  // and leave the agent blocked while the phone showed the prompt as answered.
  it("is reported under a distinct tool name", () => {
    // The name is what routes the answer path to a refusal, so it's asserted
    // here as well as at the routing site.
    expect(MULTI_QUESTION_TOOL_LABEL).not.toBe(QUESTION_TOOL_LABEL);
  });

  it("has no keystroke mapping, so the answer path must refuse", () => {
    // There is deliberately no keystrokeForMultiQuestion: refusing is correct
    // until the toggle-then-confirm flow is actually implemented.
    expect(
      opencodeBackend.keystrokeForChoice(MULTI_QUESTION_TOOL_LABEL, 0, 4)
    ).toBeNull();
    expect(
      opencodeBackend.keystrokeForChoice(MULTI_QUESTION_TOOL_LABEL, 2, 4)
    ).toBeNull();
  });

  it("still answers single-select questions", () => {
    // Guard against the refusal being applied too broadly.
    expect(opencodeBackend.keystrokeForChoice(QUESTION_TOOL_LABEL, 1, 4)).toBe(
      "\x1b[B\r"
    );
  });
});

describe("opencodeBackend.keystrokeForChoice", () => {
  it("routes each dialog kind to its own axis", () => {
    // The whole point of per-backend routing: these must not be interchangeable.
    expect(opencodeBackend.keystrokeForChoice(PERMISSION_TOOL, 2, 3)).toBe(
      "\x1b[C\x1b[C\r"
    );
    expect(opencodeBackend.keystrokeForChoice(QUESTION_TOOL_LABEL, 1, 3)).toBe(
      "\x1b[B\r"
    );
  });

  it("refuses a dialog it doesn't recognize", () => {
    expect(opencodeBackend.keystrokeForChoice("SomethingNew", 0, 3)).toBeNull();
  });

  it("never sends digits, which no OpenCode dialog accepts", () => {
    for (const tool of [PERMISSION_TOOL, QUESTION_TOOL_LABEL]) {
      const keys = opencodeBackend.keystrokeForChoice(tool, 2, 4);
      expect(keys).not.toMatch(/[0-9]/);
    }
  });
});

describe("keystrokeForQuestion", () => {
  // The question box is a vertical list, so it navigates on the other axis.
  it("uses down arrows, not right arrows", () => {
    expect(keystrokeForQuestion(0, 4)).toBe("\r");
    expect(keystrokeForQuestion(1, 4)).toBe("\x1b[B\r");
    expect(keystrokeForQuestion(3, 4)).toBe("\x1b[B\x1b[B\x1b[B\r");
  });

  it("differs from the permission mapping for the same index", () => {
    // Guards against the two being collapsed into one helper again: sending
    // left/right to a vertical list does nothing.
    expect(keystrokeForQuestion(1, 3)).not.toBe(keystrokeForPermission(1, 3));
  });

  it("declines out-of-range indices", () => {
    expect(keystrokeForQuestion(4, 4)).toBeNull();
    expect(keystrokeForQuestion(-1, 4)).toBeNull();
  });
});
