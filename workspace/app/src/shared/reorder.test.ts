// Drag-to-reorder arithmetic, shared by the renderer's preview and the main process's
// apply step. The cases that matter are the ones where an index shifts under you:
// dragging downward removes the row before the target index is used, so a naive splice
// lands one slot short.

import { describe, expect, it } from "vitest";
import { aliveFirst, moveInOrder } from "./reorder";

const ids = ["a", "b", "c", "d"];

describe("moveInOrder — dragging downward", () => {
  it("drops after a lower row", () => {
    expect(moveInOrder(ids, "a", "c", false)).toEqual(["b", "c", "a", "d"]);
  });

  it("drops before a lower row", () => {
    expect(moveInOrder(ids, "a", "c", true)).toEqual(["b", "a", "c", "d"]);
  });

  it("moves to the very end", () => {
    expect(moveInOrder(ids, "a", "d", false)).toEqual(["b", "c", "d", "a"]);
  });
});

describe("moveInOrder — dragging upward", () => {
  it("drops before a higher row", () => {
    expect(moveInOrder(ids, "d", "b", true)).toEqual(["a", "d", "b", "c"]);
  });

  it("drops after a higher row", () => {
    expect(moveInOrder(ids, "d", "b", false)).toEqual(["a", "b", "d", "c"]);
  });

  it("moves to the very top", () => {
    expect(moveInOrder(ids, "d", "a", true)).toEqual(["d", "a", "b", "c"]);
  });
});

// Identity, not just equality: the caller skips the IPC round trip and the re-render
// when nothing moved.
describe("moveInOrder — no-ops return the same array", () => {
  it("dropping on itself", () => {
    expect(moveInOrder(ids, "b", "b", true)).toBe(ids);
  });

  it("dropping just below the row above", () => {
    expect(moveInOrder(ids, "b", "a", false)).toBe(ids);
  });

  it("dropping just above the row below", () => {
    expect(moveInOrder(ids, "b", "c", true)).toBe(ids);
  });

  it("an unknown dragged id", () => {
    expect(moveInOrder(ids, "zz", "a", true)).toBe(ids);
  });

  it("an unknown target", () => {
    expect(moveInOrder(ids, "a", "zz", true)).toBe(ids);
  });
});

describe("moveInOrder — edges", () => {
  it("handles a two-item list", () => {
    expect(moveInOrder(["a", "b"], "b", "a", true)).toEqual(["b", "a"]);
    expect(moveInOrder(["a", "b"], "a", "b", false)).toEqual(["b", "a"]);
  });

  it("never loses or duplicates an id", () => {
    const long = ["a", "b", "c", "d", "e", "f"];
    for (const drag of long) {
      for (const target of long) {
        for (const before of [true, false]) {
          const out = moveInOrder(long, drag, target, before);
          expect([...out].sort()).toEqual([...long].sort());
          expect(out).toHaveLength(long.length);
        }
      }
    }
  });
});

// The builder's example (2026-11-10), with neutral names: web, billing and api stored in
// that order, billing stopped; then search added; then billing started again.
describe("aliveFirst", () => {
  type Row = { id: string; status: "running" | "stopped" };
  const ids = (rows: Row[]) => aliveFirst(rows).map((r) => r.id);
  const run = (id: string): Row => ({ id, status: "running" });
  const stop = (id: string): Row => ({ id, status: "stopped" });

  it("puts running contacts above stopped ones, each in stored order", () => {
    expect(ids([run("web"), stop("billing"), run("api")])).toEqual([
      "web",
      "api",
      "billing",
    ]);
  });

  it("shows a new running contact (stored first) at the top", () => {
    expect(ids([run("search"), run("web"), stop("billing"), run("api")])).toEqual([
      "search",
      "web",
      "api",
      "billing",
    ]);
  });

  it("puts a contact that starts again back where it was among the running ones", () => {
    expect(ids([run("search"), run("web"), run("billing"), run("api")])).toEqual([
      "search",
      "web",
      "billing",
      "api",
    ]);
  });

  it("keeps stored order inside the stopped group", () => {
    expect(ids([stop("a"), run("b"), stop("c"), stop("d")])).toEqual(["b", "a", "c", "d"]);
  });
});
