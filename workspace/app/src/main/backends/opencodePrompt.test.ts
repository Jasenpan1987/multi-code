// Tests for OpenCode's dialog detection and keystroke mapping.
//
// The permission fixture is REAL terminal output, captured by driving an actual
// `opencode` process through a PTY until it asked for external-directory access.
// Hand-written escape sequences would only prove the parser matches this file's
// own assumptions; a recording of the CLI is what makes these tests mean
// something. Regenerate it by capturing PTY output around a live dialog if a
// future OpenCode release changes its layout.

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildPermissionDetail,
  hasPermissionDialog,
  keystrokeForPermission,
  keystrokeForQuestion,
  permissionSubject,
  MULTI_QUESTION_TOOL_LABEL,
  PERMISSION_LABELS,
  PERMISSION_TOOL,
  QUESTION_TOOL_LABEL,
  visibleText,
} from "./opencodePrompt";
import { opencodeBackend } from "./opencode";

const fixture = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "opencode-permission.txt"),
  "utf8"
);

describe("visibleText", () => {
  it("keeps the glyphs a human would read", () => {
    const text = visibleText(fixture);
    expect(text).toContain("Permission required");
    expect(text).toContain("Allow once");
  });

  it("removes the escape sequences around them", () => {
    const text = visibleText(fixture);
    expect(text).not.toContain("\x1b[");
    expect(text).not.toContain("38;5;");
  });

  it("strips OSC sequences without eating following text", () => {
    expect(visibleText("\x1b]11;?\x07after")).toBe("after");
    expect(visibleText("\x1b]0;title\x1b\\after")).toBe("after");
  });

  it("leaves plain text untouched", () => {
    expect(visibleText("no escapes here")).toBe("no escapes here");
  });
});

describe("hasPermissionDialog", () => {
  it("detects the dialog in real captured output", () => {
    expect(hasPermissionDialog(visibleText(fixture))).toBe(true);
  });

  it("ignores the heading alone", () => {
    // The heading survives in scrollback after a dialog is answered, so it
    // must not be enough on its own.
    expect(hasPermissionDialog("Permission required")).toBe(false);
  });

  it("requires the whole option row", () => {
    expect(
      hasPermissionDialog("Permission required ... Allow once   Allow always")
    ).toBe(false);
  });

  it("stays false for ordinary output", () => {
    expect(hasPermissionDialog("$ pnpm test\n126 passed")).toBe(false);
    expect(hasPermissionDialog("")).toBe(false);
  });
});

describe("permissionSubject", () => {
  it("extracts what is being asked from real output", () => {
    expect(permissionSubject(visibleText(fixture))).toBe(
      "Access external directory /etc"
    );
  });

  it("stops before the Patterns block", () => {
    // OpenCode lists the globs it would grant under a "Patterns" heading; that
    // belongs in the terminal view, not in a one-line phone summary.
    const subject = permissionSubject(visibleText(fixture));
    expect(subject).not.toContain("Patterns");
    expect(subject).not.toContain("/etc/*");
  });

  it("returns undefined when there is no heading", () => {
    expect(permissionSubject("nothing here")).toBeUndefined();
  });
});

describe("buildPermissionDetail", () => {
  it("builds tappable options from real output", () => {
    const detail = buildPermissionDetail(visibleText(fixture));
    expect(detail.tool).toBe("Permission");
    expect(detail.question).toBe(
      "Permission required: Access external directory /etc"
    );
    expect(detail.options.map((o) => o.label)).toEqual([...PERMISSION_LABELS]);
  });

  it("still returns options when the subject can't be read", () => {
    // Losing the subject line should degrade to a usable prompt, not to nothing.
    const detail = buildPermissionDetail("Permission required");
    expect(detail.question).toBe("Permission required");
    expect(detail.options).toHaveLength(3);
  });
});

describe("keystrokeForPermission", () => {
  // Verified against a live dialog: it opens on "Allow once", right arrow moves
  // one step per press, and digits do nothing at all.
  it("sends only Enter for the option already selected", () => {
    expect(keystrokeForPermission(0, 3)).toBe("\r");
  });

  it("sends one right arrow per step to reach later options", () => {
    expect(keystrokeForPermission(1, 3)).toBe("\x1b[C\r");
    expect(keystrokeForPermission(2, 3)).toBe("\x1b[C\x1b[C\r");
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
    expect(opencodeBackend.keystrokeForChoice(PERMISSION_TOOL, 1, 3)).toBe(
      "\x1b[C\r"
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
