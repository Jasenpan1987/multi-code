import { describe, expect, it } from "vitest";
import { overviewMarks } from "./diffOverview";
import type { DiffLineKind, DiffRow } from "../../shared/types";

const row = (kind: DiffLineKind): DiffRow => ({
  kind,
  oldLine: kind === "add" ? null : 1,
  newLine: kind === "del" ? null : 1,
  oldText: kind === "add" ? null : "x",
  newText: kind === "del" ? null : "x",
});
const rows = (...kinds: DiffLineKind[]) => kinds.map(row);

describe("overviewMarks", () => {
  it("has no marks for an all-context diff", () => {
    expect(overviewMarks(rows("context", "context"))).toEqual([]);
  });

  it("merges consecutive changed rows into one run per side", () => {
    expect(
      overviewMarks(rows("context", "del", "del", "context", "add", "add", "add"))
    ).toEqual([
      { side: "old", start: 1, end: 3 },
      { side: "new", start: 4, end: 7 },
    ]);
  });

  it("marks a replacement on both lanes", () => {
    expect(overviewMarks(rows("replace", "replace", "context"))).toEqual([
      { side: "old", start: 0, end: 2 },
      { side: "new", start: 0, end: 2 },
    ]);
  });

  it("keeps a run going across a replace that borders a pure add", () => {
    expect(overviewMarks(rows("replace", "add", "context"))).toEqual([
      { side: "old", start: 0, end: 1 },
      { side: "new", start: 0, end: 2 },
    ]);
  });

  it("closes a run that reaches the last row", () => {
    expect(overviewMarks(rows("context", "add"))).toEqual([
      { side: "new", start: 1, end: 2 },
    ]);
  });
});
