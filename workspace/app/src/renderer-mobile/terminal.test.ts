// The terminal fallback's bytes and palette: what each key puts on the PTY, and
// the 256-colour slots OpenCode's dialogs depend on.

import { describe, expect, it } from "vitest";
import { KEYS, TERMINAL_THEME } from "./terminal";

describe("key row", () => {
  it("sends the bytes a terminal sends for each key", () => {
    expect(Object.fromEntries(KEYS.map((k) => [k.label, k.data]))).toEqual({
      Esc: "\x1b",
      Tab: "\t",
      "⇧Tab": "\x1b[Z",
      "↑": "\x1b[A",
      "↓": "\x1b[B",
      "←": "\x1b[D",
      "→": "\x1b[C",
      "␣": " ",
      "⏎": "\r",
      "^C": "\x03",
    });
  });
});

describe("palette", () => {
  const slots = TERMINAL_THEME.extendedAnsi ?? [];
  const slot = (n: number) => slots[n - 16];

  it("sets every slot from 16 to 255", () => {
    expect(slots).toHaveLength(240);
    for (const colour of slots) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps the colour cube at its standard values", () => {
    expect(slot(16)).toBe("#000000");
    expect(slot(215)).toBe("#ffaf5f");
    expect(slot(231)).toBe("#ffffff");
  });

  it("lifts OpenCode's near-black panel backgrounds and leaves the rest of the ramp", () => {
    expect(slot(232)).toBe("#1b1c20");
    expect(slot(234)).toBe("#26282e");
    expect(slot(238)).toBe("#42464f");
    expect(slot(239)).toBe("#4e4e4e");
    expect(slot(255)).toBe("#eeeeee");
  });

  it("makes slot 8 legible on those panels", () => {
    expect(TERMINAL_THEME.brightBlack).toBe("#9aa0aa");
  });
});
