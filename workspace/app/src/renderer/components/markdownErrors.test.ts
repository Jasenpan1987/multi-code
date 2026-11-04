import { describe, it, expect } from "vitest";
import { readFileErrorMessage } from "./markdownErrors";

describe("readFileErrorMessage", () => {
  it("maps not-found to a file-not-found message with the path", () => {
    expect(readFileErrorMessage("not-found", "/tmp/missing.md")).toBe(
      "⚠ File not found: /tmp/missing.md"
    );
  });

  it("maps unsupported to an only-.md message with the path", () => {
    expect(readFileErrorMessage("unsupported", "/tmp/notes.txt")).toBe(
      "⚠ Only .md files can be viewed: /tmp/notes.txt"
    );
  });

  it("maps too-large to a size-limit message with the path", () => {
    expect(readFileErrorMessage("too-large", "/tmp/huge.md")).toBe(
      "⚠ File too large to preview (>2MB): /tmp/huge.md"
    );
  });

  it("always includes the offending path in the message", () => {
    for (const err of ["not-found", "unsupported", "too-large"] as const) {
      expect(readFileErrorMessage(err, "/x/y.md")).toContain("/x/y.md");
    }
  });
});
