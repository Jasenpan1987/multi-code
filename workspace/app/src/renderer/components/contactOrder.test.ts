// The DOM half: which edge of a row a pointer means.

import { describe, expect, it } from "vitest";
import { dropsBefore, pinManagerFirst } from "./contactOrder";

describe("dropsBefore", () => {
  const rect = { top: 100, height: 40 };

  it("is before in the top half", () => {
    expect(dropsBefore(100, rect)).toBe(true);
    expect(dropsBefore(119, rect)).toBe(true);
  });

  it("is after in the bottom half", () => {
    expect(dropsBefore(120, rect)).toBe(false);
    expect(dropsBefore(139, rect)).toBe(false);
  });
});

describe("pinManagerFirst", () => {
  const mgr = { id: "m", isManager: true };
  const a = { id: "a", isManager: false };
  const b = { id: "b", isManager: false };
  const c = { id: "c", isManager: false };

  it("moves the manager to the front", () => {
    expect(pinManagerFirst([a, b, mgr, c])).toEqual([mgr, a, b, c]);
  });

  it("keeps the projects in their stored order", () => {
    expect(pinManagerFirst([c, a, mgr, b]).map((i) => i.id)).toEqual([
      "m",
      "c",
      "a",
      "b",
    ]);
  });

  it("returns the same array when the manager is already first", () => {
    const list = [mgr, a, b];
    expect(pinManagerFirst(list)).toBe(list);
  });

  it("returns the same array when there is no manager", () => {
    const list = [a, b, c];
    expect(pinManagerFirst(list)).toBe(list);
  });

  it("survives an empty list", () => {
    const list: { id: string; isManager: boolean }[] = [];
    expect(pinManagerFirst(list)).toBe(list);
  });
});
