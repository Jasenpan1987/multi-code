import { describe, expect, it } from "vitest";
import { refForRange } from "./diffRef";
import type { DiffRow } from "../../shared/types";

const ctx = (oldLine: number, newLine: number): DiffRow => ({
  kind: "context",
  oldLine,
  newLine,
  oldText: "x",
  newText: "x",
});
const del = (oldLine: number): DiffRow => ({
  kind: "del",
  oldLine,
  newLine: null,
  oldText: "gone",
  newText: null,
});
const add = (newLine: number): DiffRow => ({
  kind: "add",
  oldLine: null,
  newLine,
  oldText: null,
  newText: "new",
});

const P = "src/a.ts";

describe("refForRange", () => {
  it("gives a bare line number for a single row", () => {
    const rows = [ctx(1, 1), ctx(2, 2), ctx(3, 3)];
    expect(refForRange(rows, 1, 1, P)).toEqual({
      ref: "@src/a.ts:2",
      fellBack: false,
    });
  });

  it("gives a range for several rows", () => {
    const rows = [ctx(1, 1), ctx(2, 2), ctx(3, 3), ctx(4, 4)];
    expect(refForRange(rows, 1, 3, P)).toEqual({
      ref: "@src/a.ts:2-4",
      fellBack: false,
    });
  });

  it("uses new-version numbers, not old ones", () => {
    // An insertion above shifts the new side: old 2 is new 4.
    const rows = [ctx(1, 1), add(2), add(3), ctx(2, 4)];
    expect(refForRange(rows, 3, 3, P).ref).toBe("@src/a.ts:4");
  });

  it("ignores deleted rows inside a mixed range", () => {
    const rows = [ctx(1, 1), del(2), del(3), ctx(4, 2)];
    // The range covers rows 0..3; only lines 1 and 2 exist in the new file.
    expect(refForRange(rows, 0, 3, P)).toEqual({
      ref: "@src/a.ts:1-2",
      fellBack: false,
    });
  });

  it("falls back to the line above for a deletion-only selection", () => {
    const rows = [ctx(1, 1), ctx(2, 2), del(3), del(4), ctx(5, 3)];
    expect(refForRange(rows, 2, 3, P)).toEqual({
      ref: "@src/a.ts:2",
      fellBack: true,
    });
  });

  it("falls back downwards when the deletion is at the top of the file", () => {
    const rows = [del(1), del(2), ctx(3, 1), ctx(4, 2)];
    expect(refForRange(rows, 0, 1, P)).toEqual({
      ref: "@src/a.ts:1",
      fellBack: true,
    });
  });

  it("falls back upwards when the deletion is at the end of the file", () => {
    const rows = [ctx(1, 1), ctx(2, 2), del(3)];
    expect(refForRange(rows, 2, 2, P)).toEqual({
      ref: "@src/a.ts:2",
      fellBack: true,
    });
  });

  it("drops the line number when the whole file was deleted", () => {
    const rows = [del(1), del(2), del(3)];
    expect(refForRange(rows, 0, 2, P)).toEqual({
      ref: "@src/a.ts",
      fellBack: true,
    });
  });

  it("handles a range selected bottom-up", () => {
    const rows = [ctx(1, 1), ctx(2, 2), ctx(3, 3)];
    expect(refForRange(rows, 2, 0, P).ref).toBe("@src/a.ts:1-3");
  });

  it("clamps a range that runs past the rows", () => {
    const rows = [ctx(1, 1), ctx(2, 2)];
    expect(refForRange(rows, 0, 99, P).ref).toBe("@src/a.ts:1-2");
  });

  it("survives an empty diff", () => {
    expect(refForRange([], 0, 0, P)).toEqual({
      ref: "@src/a.ts",
      fellBack: false,
    });
  });
});
