import { describe, expect, it } from "vitest";
import { arrowsBetween, inputIndex } from "./promptClick";

// "❯ line one" / "  line two": text from column 2, one column a character.
const cols = (text: string, from = 2) => Array.from(text, (_, i) => from + i);
const rows = [cols("line one"), cols("line two")];

describe("inputIndex", () => {
  it("counts characters before the cell, a row break as one", () => {
    expect(inputIndex(rows, { row: 0, col: 2 })).toBe(0);
    expect(inputIndex(rows, { row: 0, col: 7 })).toBe(5);
    expect(inputIndex(rows, { row: 1, col: 2 })).toBe(9);
  });

  it("puts a click past a row's end at that end, and on the prompt mark at its start", () => {
    expect(inputIndex(rows, { row: 0, col: 60 })).toBe(8);
    expect(inputIndex(rows, { row: 1, col: 0 })).toBe(9);
  });

  it("counts a wide character once, a click on its right half landing after it", () => {
    // "修好了" from column 2: characters at 2, 4 and 6.
    const wide = [[2, 4, 6]];
    expect(inputIndex(wide, { row: 0, col: 4 })).toBe(1);
    expect(inputIndex(wide, { row: 0, col: 5 })).toBe(2);
  });
});

describe("arrowsBetween", () => {
  it("is Left (negative) from the end of line two back to 'one' on line one", () => {
    // The caret after "line two" (column 10); "one" starts at column 7.
    expect(arrowsBetween(rows, { row: 1, col: 10 }, { row: 0, col: 7 })).toBe(-12);
  });

  it("is Right (positive) going forward, and zero on the caret itself", () => {
    expect(arrowsBetween(rows, { row: 0, col: 2 }, { row: 1, col: 4 })).toBe(11);
    expect(arrowsBetween(rows, { row: 0, col: 5 }, { row: 0, col: 5 })).toBe(0);
  });
});
