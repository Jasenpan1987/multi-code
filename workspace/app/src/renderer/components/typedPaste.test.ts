import { describe, expect, it } from "vitest";
import { asTyping, mayType, typingChunks, wouldFold } from "./typedPaste";

describe("wouldFold", () => {
  it("is false for up to three lines and 800 characters", () => {
    expect(wouldFold("one\ntwo\nthree")).toBe(false);
    expect(wouldFold("x".repeat(800))).toBe(false);
  });

  it("is true past three lines or 800 characters", () => {
    expect(wouldFold("one\ntwo\nthree\nfour")).toBe(true);
    expect(wouldFold("one\r\ntwo\r\nthree\r\nfour")).toBe(true);
    expect(wouldFold("x".repeat(801))).toBe(true);
  });
});

describe("mayType", () => {
  it("keeps a paste that would open a menu or a mode in an empty input", () => {
    for (const t of ["/Users/x/notes.md\nmore", "!ls\nmore", "?help", "# note"]) {
      expect(mayType(t, false)).toBe(false);
    }
  });

  it("types it when the input already holds text, and types plain text", () => {
    expect(mayType("/Users/x/notes.md", true)).toBe(true);
    expect(mayType("fix the login\nredirect", false)).toBe(true);
  });
});

describe("asTyping", () => {
  it("makes every line break an LF and a tab four spaces", () => {
    expect(asTyping("a\r\nb\rc\nd\te")).toBe("a\nb\nc\nd    e");
  });

  it("drops other control characters, an Esc among them", () => {
    expect(asTyping("a\x1b[31mb\x07c")).toBe("a[31mbc");
  });

  it("closes a last @ token with a space", () => {
    expect(asTyping("look at @src/app.ts")).toBe("look at @src/app.ts ");
    expect(asTyping("mail me@example.com")).toBe("mail me@example.com");
  });
});

describe("typingChunks", () => {
  it("splits into pieces of the given size", () => {
    expect(typingChunks("abcdefg", 3)).toEqual(["abc", "def", "g"]);
  });

  it("never cuts an emoji or a CJK character", () => {
    const chunks = typingChunks("修好了😀看图二", 3);
    expect(chunks).toEqual(["修好了", "😀看图", "二"]);
  });
});
