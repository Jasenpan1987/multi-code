// The Dock icon of a dev run: the same icon with an orange sash across its
// lower-right corner reading DEV, in the orange of the window's own DEV badge
// (.version-badge-dev). A dev run and the installed app often sit in the Dock at
// once, and without it the two icons look the same.
//
// Painted at startup rather than kept as a second image, so it follows the icon
// whenever the icon changes. No Electron here, so the tests run in plain Node;
// index.ts does the nativeImage part.

// In image widths. The sash's centre line runs where x + y is this many widths
// from the top-left corner, so it crosses the right and bottom edges between
// about 35% and 65% of the way down and across.
const CENTRE = 1.5;
// Half the sash's width, and its dark edge, measured across the sash. Wide
// enough to read at the Dock's smallest sizes.
const HALF_WIDTH = 0.11;
const EDGE = 0.015;
// The letters' height, as a share of the sash's width, and their stroke, as a
// share of their height.
const TEXT_HEIGHT = 0.55;
const STROKE = 0.18;
// Samples a pixel is split into each way, so the slanted letters aren't jagged.
const SAMPLES = 4;

// BGRA, the order nativeImage's bitmaps use on macOS.
const ORANGE = [0x0c, 0x82, 0xe8]; // #e8820c
const DARK = [0x05, 0x5a, 0xa3]; // #a35a05
const WHITE = [0xff, 0xff, 0xff];

type Point = [number, number];

// D, E, V as the centre lines of their strokes, in letter heights, y down. Lines
// rather than a pixel grid, so the strokes stay solid when slanted.
const LETTERS: { width: number; lines: Point[][] }[] = [
  {
    width: 0.5,
    lines: [[[0, 0], [0.28, 0], [0.5, 0.18], [0.5, 0.82], [0.28, 1], [0, 1], [0, 0]]],
  },
  {
    width: 0.48,
    lines: [
      [[0.48, 0], [0, 0], [0, 1], [0.48, 1]],
      [[0, 0.5], [0.4, 0.5]],
    ],
  },
  { width: 0.56, lines: [[[0, 0], [0.28, 1], [0.56, 0]]] },
];
// Between one letter's centre lines and the next.
const GAP = 0.3;
// The letters' segments, set one after another along a line, and their width.
const TEXT = (() => {
  const segments: [Point, Point][] = [];
  let start = 0;
  for (const { width, lines } of LETTERS) {
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1];
        const [bx, by] = line[i];
        segments.push([[ax + start, ay], [bx + start, by]]);
      }
    }
    start += width + GAP;
  }
  return { segments, width: start - GAP };
})();

/**
 * Paints the sash into `bgra` in place: 4 bytes a pixel, premultiplied alpha,
 * the layout of `NativeImage.toBitmap()`. The sash is opaque, and its edges are
 * blended by how much of each pixel they cover, so they don't look jagged.
 *
 * The text reads up the sash, from its lower-left end, centred where the sash
 * crosses the icon's diagonal.
 */
export function paintDevSash(
  bgra: Uint8Array,
  width: number,
  height: number
): void {
  const centre = (CENTRE * width) / Math.SQRT2;
  const half = HALF_WIDTH * width;
  const edge = EDGE * width;
  const letterHeight = TEXT_HEIGHT * 2 * half;
  // The text's reach across the sash, from its centre line, strokes included.
  const textReach = (letterHeight * (1 + STROKE)) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Distance in pixels from this pixel's centre to the sash's centre line.
      const across = Math.abs((x + y + 1) / Math.SQRT2 - centre);
      const outer = coverage(half + edge - across);
      if (outer === 0) continue;
      const at = (y * width + x) * 4;
      blend(bgra, at, DARK, outer);
      blend(bgra, at, ORANGE, coverage(half - across));
      if (across > textReach + 1) continue;
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const qx = x + (sx + 0.5) / SAMPLES;
          const qy = y + (sy + 0.5) / SAMPLES;
          // In letter heights: along the sash, up and to the right, from the
          // text's start; and down from the letters' top.
          const along = (qx - qy) / Math.SQRT2 / letterHeight + TEXT.width / 2;
          const down = ((qx + qy) / Math.SQRT2 - centre) / letterHeight + 0.5;
          if (onStroke(along, down)) hits++;
        }
      }
      blend(bgra, at, WHITE, hits / (SAMPLES * SAMPLES));
    }
  }
}

function onStroke(x: number, y: number): boolean {
  const reach = STROKE / 2;
  for (const [a, b] of TEXT.segments) {
    if (distanceToSegment(x, y, a, b) <= reach) return true;
  }
  return false;
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

// How much of a pixel lies inside an edge `inside` pixels away from its centre.
function coverage(inside: number): number {
  return Math.min(1, Math.max(0, inside + 0.5));
}

// An opaque colour over a premultiplied pixel, `amount` of the way.
function blend(bgra: Uint8Array, at: number, color: number[], amount: number) {
  if (amount === 0) return;
  for (let c = 0; c < 3; c++) {
    bgra[at + c] = Math.round(color[c] * amount + bgra[at + c] * (1 - amount));
  }
  bgra[at + 3] = Math.round(255 * amount + bgra[at + 3] * (1 - amount));
}
