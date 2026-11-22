import { describe, it, expect } from "vitest";
import { isMarkdownPath, readFileErrorMessage } from "./markdownErrors";

describe("readFileErrorMessage", () => {
  it("maps not-found to a file-not-found message with the path", () => {
    expect(readFileErrorMessage("not-found", "/tmp/missing.md")).toBe(
      "⚠ File not found: /tmp/missing.md"
    );
  });

  it("maps unsupported (a binary file or a folder) to a not-text message with the path", () => {
    expect(readFileErrorMessage("unsupported", "/tmp/logo.png")).toBe(
      "⚠ Not a text file: /tmp/logo.png"
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

describe("isMarkdownPath", () => {
  it("renders .md and .markdown, in any case", () => {
    expect(isMarkdownPath("/x/README.md")).toBe(true);
    expect(isMarkdownPath("/x/notes.MARKDOWN")).toBe(true);
  });

  it("shows code, data and other text as it is", () => {
    for (const p of ["/x/a.ts", "/x/b.json", "/x/c.sql", "/x/readme.md.bak", "/x/page.mdx", "/x/Makefile"]) {
      expect(isMarkdownPath(p)).toBe(false);
    }
  });
});
