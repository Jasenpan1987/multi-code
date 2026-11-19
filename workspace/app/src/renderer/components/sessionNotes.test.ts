import { describe, expect, it } from "vitest";
import { clip, firstLine, formatNoteTime, nextNoted, notesLabel } from "./sessionNotes";

// Local time, as the builder's clock shows it.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("formatNoteTime", () => {
  const now = at(2026, 11, 19, 9, 5);

  it("says Today and Yesterday by the calendar, not by 24 hours", () => {
    expect(formatNoteTime(at(2026, 11, 19, 0, 1), now)).toBe("Today 00:01");
    expect(formatNoteTime(at(2026, 11, 18, 18, 42), now)).toBe("Yesterday 18:42");
    expect(formatNoteTime(at(2026, 11, 18, 0, 0), now)).toBe("Yesterday 00:00");
  });

  it("gives the weekday within the last week", () => {
    // 2026-11-16 is a Monday.
    expect(formatNoteTime(at(2026, 11, 16, 7, 3), now)).toBe("Mon 07:03");
    expect(formatNoteTime(at(2026, 11, 13, 23, 59), now)).toBe("Fri 23:59");
  });

  it("gives the date from a week back, and the year when it isn't this one", () => {
    expect(formatNoteTime(at(2026, 11, 12, 18, 0), now)).toBe("12 Nov 18:00");
    expect(formatNoteTime(at(2025, 12, 31, 18, 0), now)).toBe("31 Dec 2025 18:00");
  });

  it("gives a date for a time ahead of the clock other than today", () => {
    expect(formatNoteTime(at(2026, 11, 21, 8, 0), now)).toBe("21 Nov 08:00");
  });
});

describe("firstLine", () => {
  it("skips blank lines and trims", () => {
    expect(firstLine("\n   \n  continue the refund flow  \nthen tests")).toBe(
      "continue the refund flow"
    );
    expect(firstLine("明天继续做退款\n别忘了跑测试")).toBe("明天继续做退款");
    expect(firstLine("")).toBe("");
  });
});

describe("nextNoted", () => {
  const order = ["a", "b", "c", "d"];

  it("goes to the next noted session after the selected one, wrapping round", () => {
    expect(nextNoted(order, new Set(["b", "d"]), "b")).toBe("d");
    expect(nextNoted(order, new Set(["b", "d"]), "d")).toBe("b");
    expect(nextNoted(order, new Set(["a"]), "c")).toBe("a");
  });

  it("starts at the top with nothing selected", () => {
    expect(nextNoted(order, new Set(["c", "b"]), null)).toBe("b");
  });

  it("has nowhere to go when only the selected one has a note", () => {
    expect(nextNoted(order, new Set(["b"]), "b")).toBeNull();
    expect(nextNoted(order, new Set(), "b")).toBeNull();
  });
});

describe("notesLabel", () => {
  it("says note or notes", () => {
    expect(notesLabel(1)).toBe("1 note");
    expect(notesLabel(2)).toBe("2 notes");
  });
});

describe("clip", () => {
  it("cuts past the limit with an ellipsis", () => {
    expect(clip("abcdef", 3)).toBe("abc…");
    expect(clip("abc", 3)).toBe("abc");
  });
});
