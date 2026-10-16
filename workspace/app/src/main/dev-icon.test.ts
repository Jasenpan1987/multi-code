import { describe, expect, it } from "vitest";
import { paintDevSash } from "./dev-icon";

const ORANGE = [0x0c, 0x82, 0xe8, 0xff];
const DARK = [0x05, 0x5a, 0xa3, 0xff];
const BLUE = [0xc0, 0x60, 0x20, 0xff];

// A square BGRA bitmap, every pixel `fill`.
function bitmap(size: number, fill: number[]) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return data;
}

function pixel(data: Uint8Array, size: number, x: number, y: number) {
  const at = (y * size + x) * 4;
  return [...data.subarray(at, at + 4)];
}

describe("paintDevSash", () => {
  // On a 128 icon the sash's centre line is where x + y + 1 = 192; the text
  // sits around (96, 96), so (125, 66) is bare sash.
  it("paints the sash opaque orange, over the icon and its transparent corner", () => {
    const icon = bitmap(128, BLUE);
    paintDevSash(icon, 128, 128);
    expect(pixel(icon, 128, 125, 66)).toEqual(ORANGE);

    const empty = bitmap(128, [0, 0, 0, 0]);
    paintDevSash(empty, 128, 128);
    expect(pixel(empty, 128, 125, 66)).toEqual(ORANGE);
  });

  it("leaves the rest of the icon as it was, the far corner included", () => {
    const icon = bitmap(128, BLUE);
    paintDevSash(icon, 128, 128);
    expect(pixel(icon, 128, 0, 0)).toEqual(BLUE);
    expect(pixel(icon, 128, 64, 40)).toEqual(BLUE);
    expect(pixel(icon, 128, 127, 127)).toEqual(BLUE);
  });

  it("edges the orange in dark on both sides", () => {
    const icon = bitmap(128, BLUE);
    paintDevSash(icon, 128, 128);
    const row = Array.from({ length: 128 }, (_, x) => pixel(icon, 128, x, 100));
    const dark = row.flatMap((p, x) => (p.every((v, i) => v === DARK[i]) ? [x] : []));
    expect(dark.some((x) => x < 91)).toBe(true);
    expect(dark.some((x) => x > 91)).toBe(true);
  });

  it("blends the outer edges over transparency rather than stepping", () => {
    const empty = bitmap(128, [0, 0, 0, 0]);
    paintDevSash(empty, 128, 128);
    const alphas = Array.from({ length: 128 }, (_, x) => pixel(empty, 128, x, 100)[3]);
    expect(alphas.some((a) => a > 0 && a < 255)).toBe(true);
  });

  it("writes DEV in white along the sash", () => {
    // Large enough that the gaps between strokes span several pixels.
    const size = 512;
    const icon = bitmap(size, BLUE);
    paintDevSash(icon, size, size);
    // Up the centre line, which runs through the letters' middle: D crosses it
    // twice, E once (its middle bar joins the upright), V twice.
    const white: boolean[] = [];
    for (let x = size / 2; x < size; x++) {
      const [b, g, r] = pixel(icon, size, x, size * 1.5 - 1 - x);
      white.push(b > 128 && g > 128 && r > 128);
    }
    const runs = white.filter((w, i) => w && !white[i - 1]).length;
    expect(runs).toBe(5);
    expect(pixel(icon, size, 384, 383)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it("scales with the icon", () => {
    const icon = bitmap(256, BLUE);
    paintDevSash(icon, 256, 256);
    expect(pixel(icon, 256, 250, 133)).toEqual(ORANGE);
    expect(pixel(icon, 256, 128, 80)).toEqual(BLUE);
  });
});
