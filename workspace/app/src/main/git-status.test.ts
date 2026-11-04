// Porcelain's rename form is the reason this file exists: `R  old -> new` was
// being taken whole as a path, which put a nonsense directory in the Git section
// and made the diff for a renamed file come back as a brand-new one.

import { describe, expect, it } from "vitest";
import { splitRename } from "./git-status";

describe("splitRename", () => {
  it("splits a rename into its two paths", () => {
    expect(splitRename("docs/old.md -> docs/new.md")).toEqual({
      path: "docs/new.md",
      oldPath: "docs/old.md",
    });
  });

  it("leaves an ordinary path alone, with no oldPath", () => {
    expect(splitRename("src/main/git-status.ts")).toEqual({
      path: "src/main/git-status.ts",
    });
  });

  it("splits on the last arrow, so an arrow in a filename survives", () => {
    expect(splitRename("a -> b -> c/final.txt")).toEqual({
      path: "c/final.txt",
      oldPath: "a -> b",
    });
  });

  it("is not fooled by an arrow without the surrounding spaces", () => {
    expect(splitRename("weird->name.txt")).toEqual({
      path: "weird->name.txt",
    });
  });
});
