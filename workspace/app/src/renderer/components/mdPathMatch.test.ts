import { describe, it, expect } from "vitest";
import { findMdPaths } from "./mdPathMatch";

describe("findMdPaths", () => {
  it("matches a bare relative path", () => {
    const m = findMdPaths("see docs/readme.md for details");
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe("docs/readme.md");
    // "see " is 4 chars, so start index 4
    expect(m[0].start).toBe(4);
    expect(m[0].end).toBe(4 + "docs/readme.md".length - 1);
  });

  it("matches absolute and ~ paths", () => {
    expect(findMdPaths("/Users/me/x.md")[0].path).toBe("/Users/me/x.md");
    expect(findMdPaths("~/notes/todo.markdown")[0].path).toBe(
      "~/notes/todo.markdown"
    );
    expect(findMdPaths("./local.md")[0].path).toBe("./local.md");
  });

  it("matches .markdown as well as .md", () => {
    expect(findMdPaths("a/b.markdown")[0].path).toBe("a/b.markdown");
  });

  it("is case-insensitive on the extension", () => {
    expect(findMdPaths("README.MD")[0].path).toBe("README.MD");
  });

  it("finds multiple paths on one line", () => {
    const m = findMdPaths("edit a.md and b/c.md now");
    expect(m.map((x) => x.path)).toEqual(["a.md", "b/c.md"]);
  });

  it("does not swallow surrounding punctuation", () => {
    expect(findMdPaths("(see foo.md)")[0].path).toBe("foo.md");
    expect(findMdPaths("`bar.md`")[0].path).toBe("bar.md");
    expect(findMdPaths('"baz.md"')[0].path).toBe("baz.md");
    expect(findMdPaths("<qux.md>")[0].path).toBe("qux.md");
    expect(findMdPaths("file: notes.md, next")[0].path).toBe("notes.md");
  });

  it("does not match non-markdown extensions", () => {
    expect(findMdPaths("app.mdx has no link")).toEqual([]);
    expect(findMdPaths("readme.md.bak nope")).toEqual([]);
    expect(findMdPaths("plain.txt or code.ts")).toEqual([]);
  });

  it("returns nothing for a line with no path", () => {
    expect(findMdPaths("just some regular output")).toEqual([]);
    expect(findMdPaths("")).toEqual([]);
  });

  it("reports ranges usable as 1-based inclusive after +1", () => {
    // "x.md" at index 0..3 -> xterm range x: 1..4
    const m = findMdPaths("x.md");
    expect(m[0].start + 1).toBe(1);
    expect(m[0].end + 1).toBe(4);
  });

  it("is not corrupted by repeated calls (stateful regex reset)", () => {
    findMdPaths("first.md");
    const second = findMdPaths("second.md");
    expect(second).toHaveLength(1);
    expect(second[0].path).toBe("second.md");
  });
});
