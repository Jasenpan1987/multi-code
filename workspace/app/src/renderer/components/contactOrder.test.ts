// The DOM half: which edge of a row a pointer means.

import { describe, expect, it } from "vitest";
import { dropsBefore } from "./contactOrder";

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
