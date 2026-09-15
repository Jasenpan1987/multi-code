// The text is the feature here, so the text is what gets tested.
//
// A freshly created manager stops on the CLI's workspace-trust dialog whose default
// answer is "No, exit" — press Enter and the manager you just made shuts down. If
// this warning stops naming the option to pick, or stops saying that Enter alone is
// wrong, the hint is decoration and the failure it prevents comes back silently.

import { describe, expect, it } from "vitest";
import {
  TRUST_ANSWER,
  TRUST_DIALOG_OPTIONS,
  TRUST_DIALOG_QUESTION,
  TRUST_HINT_PARAGRAPHS,
  TRUST_HINT_TITLE,
} from "./managerTrustText";

const all = TRUST_HINT_PARAGRAPHS.join("\n");

describe("the trust hint text", () => {
  it("names the exact option to pick", () => {
    expect(all).toContain(TRUST_ANSWER);
    expect(TRUST_ANSWER).toBe("Yes, I trust this folder");
  });

  it("warns that pressing Enter alone is the wrong answer", () => {
    expect(all).toMatch(/Do not just press Enter/);
    expect(all).toMatch(/No, exit/);
    expect(all).toMatch(/shut down the manager/);
  });

  it("says how to get to the right option", () => {
    // Naming the answer isn't enough — it's the second item, so the user needs to
    // know to move the selection before submitting.
    expect(all).toMatch(/down arrow/);
  });

  it("says nothing is wrong if the question never appears", () => {
    // An already-trusted folder shows no dialog. Without this line the user waits
    // for a prompt that isn't coming and assumes the hint means something broke.
    expect(all).toMatch(/doesn't appear at all, nothing is wrong/);
  });

  it("reassures that the folder is safe to trust", () => {
    expect(all).toMatch(/belongs to Multi-Code/);
  });

  it("reproduces the dialog with the wrong answer listed first", () => {
    // The UI highlights options[0] as the default, matching the CLI. Reordering
    // these would show the user a picture that doesn't match their screen.
    expect(TRUST_DIALOG_OPTIONS[0]).toBe("No, exit");
    expect(TRUST_DIALOG_OPTIONS[1]).toBe(TRUST_ANSWER);
    expect(TRUST_DIALOG_QUESTION).toMatch(/Quick safety check/);
  });

  it("has a title that says what is happening rather than warning of an error", () => {
    expect(TRUST_HINT_TITLE).toBe("Your manager is starting up");
  });
});
