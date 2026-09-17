import { describe, expect, it } from "vitest";
import { diffErrorMessage, offersEditorFallback } from "./diffErrors";

describe("diffErrorMessage", () => {
  it("names each state in plain words", () => {
    expect(diffErrorMessage("binary")).toBe("Binary file — no diff to show");
    expect(diffErrorMessage("no-changes")).toBe("No changes");
    expect(diffErrorMessage("not-found")).toBe("File not found");
  });

  it("carries the size into the too-large message", () => {
    expect(diffErrorMessage("too-large", "24310 lines")).toBe(
      "Diff too large to show (24310 lines) — open it in your editor"
    );
  });

  it("still reads as a sentence with no detail", () => {
    expect(diffErrorMessage("too-large")).toBe(
      "Diff too large to show — open it in your editor"
    );
    expect(diffErrorMessage("failed")).toBe("Could not read the diff");
  });

  it("surfaces the underlying error for a failure", () => {
    expect(diffErrorMessage("failed", "git: command not found")).toBe(
      "Could not read the diff: git: command not found"
    );
  });
});

describe("offersEditorFallback", () => {
  it("offers the editor only when the file itself is fine", () => {
    expect(offersEditorFallback("too-large")).toBe(true);
    expect(offersEditorFallback("binary")).toBe(true);
    // Nothing to open, or nothing to see.
    expect(offersEditorFallback("not-found")).toBe(false);
    expect(offersEditorFallback("no-changes")).toBe(false);
    expect(offersEditorFallback("failed")).toBe(false);
  });
});
