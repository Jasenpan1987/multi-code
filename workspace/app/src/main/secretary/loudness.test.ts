// Loudness normalization on synthetic WAVs shaped like the speech server's: quiet
// speech-like tone with a few short peaks far above it, so a plain gain to the
// target would clip and the limiter has to do its part.

import { describe, expect, it } from "vitest";

import { TARGET_DBFS, gatedRms, normalizeLoudness } from "./loudness";

const RATE = 24000;

function db(v: number): number {
  return 20 * Math.log10(v);
}

// A 16-bit PCM WAV. `extra` adds chunks between fmt and data, as some encoders do.
function wav(
  samples: Int16Array,
  opts: { channels?: number; bits?: number; format?: number; dataSize?: number; extra?: Buffer } = {}
): Buffer {
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(opts.format ?? 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(RATE, 12);
  fmt.writeUInt32LE((RATE * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "latin1");
  dataHead.writeUInt32LE(opts.dataSize ?? pcm.length, 4);
  const extra = opts.extra ?? Buffer.alloc(0);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + fmt.length + extra.length + dataHead.length + pcm.length, 4);
  head.write("WAVE", 8, "latin1");
  return Buffer.concat([head, fmt, extra, dataHead, pcm]);
}

// `seconds` of a 220 Hz tone at `levelDbfs` RMS, a quarter of it silent (pauses),
// with a short burst every second at `peakDbfs`.
function speechLike(seconds: number, levelDbfs: number, peakDbfs: number): Int16Array {
  const n = seconds * RATE;
  const out = new Int16Array(n);
  const amp = 10 ** (levelDbfs / 20) * Math.SQRT2 * 32768;
  const peak = 10 ** (peakDbfs / 20) * 32768;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const pause = t % 4 >= 3;
    let v = pause ? 0 : amp * Math.sin(2 * Math.PI * 220 * t);
    // 2 ms burst at the start of each second.
    if (!pause && i % RATE < RATE / 500) v = peak * Math.sin(2 * Math.PI * 1000 * t);
    out[i] = Math.round(v);
  }
  return out;
}

function pcmOf(buf: Buffer, offset = 44): Int16Array {
  const copy = buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + buf.length);
  return new Int16Array(copy);
}

function loudnessOf(samples: Int16Array): number {
  const f = Float32Array.from(samples, (v) => v / 32768);
  return db(gatedRms(f, 1, RATE / 20)!);
}

function peakOf(samples: Int16Array): number {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  return db(peak / 32768);
}

describe("normalizeLoudness", () => {
  it("brings quiet speech to the target without a sample past -1 dBFS", () => {
    // Like the server's: -27 dBFS with peaks at -8, so the gain to the target
    // would put them above full scale.
    const input = wav(speechLike(8, -27, -8));
    const out = normalizeLoudness(input);
    const samples = pcmOf(out);
    expect(loudnessOf(samples)).toBeGreaterThan(TARGET_DBFS - 0.5);
    expect(loudnessOf(samples)).toBeLessThan(TARGET_DBFS + 0.5);
    expect(peakOf(samples)).toBeLessThanOrEqual(-1);
  });

  it("only pulls down around the peaks, leaving the rest at the plain gain", () => {
    const source = speechLike(4, -27, -6);
    const out = pcmOf(normalizeLoudness(wav(source)));
    // Halfway between two bursts, the tone is the input times one gain.
    const at = Math.round(RATE * 1.5);
    const ratios: number[] = [];
    for (let i = at; i < at + 200; i++) {
      if (Math.abs(source[i]) > 1000) ratios.push(out[i] / source[i]);
    }
    const spread = Math.max(...ratios) - Math.min(...ratios);
    expect(spread).toBeLessThan(0.01);
    // The bursts lift the measured loudness to about -26, so the gain is about 8 dB.
    expect(db(ratios[0])).toBeGreaterThan(7.5);
  });

  it("brings loud speech down to the target too", () => {
    const out = pcmOf(normalizeLoudness(wav(speechLike(4, -10, -2))));
    expect(loudnessOf(out)).toBeGreaterThan(TARGET_DBFS - 0.5);
    expect(loudnessOf(out)).toBeLessThan(TARGET_DBFS + 0.5);
  });

  it("lifts a very quiet clip by at most 20 dB", () => {
    const source = speechLike(4, -45, -40);
    const out = pcmOf(normalizeLoudness(wav(source)));
    expect(loudnessOf(out) - loudnessOf(source)).toBeCloseTo(20, 0);
  });

  it("keeps the header and length, and leaves the input untouched", () => {
    const input = wav(speechLike(2, -27, -6));
    const before = Buffer.from(input);
    const out = normalizeLoudness(input);
    expect(out).not.toBe(input);
    expect(out.length).toBe(input.length);
    expect(out.subarray(0, 44).equals(input.subarray(0, 44))).toBe(true);
    expect(input.equals(before)).toBe(true);
  });

  it("finds the data after other chunks and survives a placeholder data size", () => {
    const list = Buffer.alloc(8 + 5 + 1);
    list.write("LIST", 0, "latin1");
    list.writeUInt32LE(5, 4); // odd size: one pad byte follows
    const input = wav(speechLike(2, -27, -8), { extra: list, dataSize: 0xffffffff });
    const offset = 44 + list.length;
    const out = normalizeLoudness(input);
    expect(out.length).toBe(input.length);
    expect(loudnessOf(pcmOf(out, offset))).toBeGreaterThan(TARGET_DBFS - 0.5);
  });

  it("works on a byte offset the Int16 view couldn't use directly", () => {
    const inner = wav(speechLike(2, -27, -6));
    const outer = Buffer.alloc(inner.length + 1);
    inner.copy(outer, 1);
    const shifted = outer.subarray(1);
    const out = normalizeLoudness(shifted);
    expect(out.equals(normalizeLoudness(inner))).toBe(true);
  });

  it("handles stereo, limiting both channels together", () => {
    const mono = speechLike(2, -27, -6);
    const stereo = new Int16Array(mono.length * 2);
    for (let i = 0; i < mono.length; i++) {
      stereo[2 * i] = mono[i];
      stereo[2 * i + 1] = mono[i] >> 1;
    }
    const out = pcmOf(normalizeLoudness(wav(stereo, { channels: 2 })));
    expect(peakOf(out)).toBeLessThanOrEqual(-1);
    // The quieter channel stays half the louder one.
    let at = Math.round(RATE * 1.5);
    while (Math.abs(mono[at]) < 1000) at++;
    expect(out[2 * at + 1] / out[2 * at]).toBeCloseTo(0.5, 1);
  });

  it("takes an extensible header only when its SubFormat is PCM", () => {
    const samples = speechLike(2, -27, -8);
    const extensible = (subFormat: string) => {
      const ext = Buffer.alloc(8 + 24);
      ext.writeUInt16LE(22, 0); // cbSize, at fmt offset 16
      ext.writeUInt16LE(16, 2); // valid bits
      ext.writeUInt32LE(4, 4); // channel mask
      Buffer.from(subFormat, "hex").copy(ext, 8);
      const plain = wav(samples, { format: 0xfffe });
      // Grow fmt from 16 to 40 bytes and fix the sizes.
      const fmtEnd = 12 + 8 + 16;
      const out = Buffer.concat([plain.subarray(0, fmtEnd), ext.subarray(0, 24), plain.subarray(fmtEnd)]);
      out.writeUInt32LE(40, 16);
      out.writeUInt32LE(out.length - 8, 4);
      return out;
    };
    const pcm = extensible("0100000000001000800000aa00389b71");
    expect(loudnessOf(pcmOf(normalizeLoudness(pcm), 68))).toBeGreaterThan(TARGET_DBFS - 0.5);
    // The same GUID with the float subtype: left alone.
    const float = extensible("0300000000001000800000aa00389b71");
    expect(normalizeLoudness(float)).toBe(float);
  });

  it("leaves audio longer than three minutes as it came", () => {
    const long = wav(new Int16Array(24000 * 180 + 1).fill(300));
    expect(normalizeLoudness(long)).toBe(long);
    // The cap counts samples: few frames, but across 16 channels just past it.
    const wide = wav(new Int16Array(24000 * 180 + 16).fill(300), { channels: 16 });
    expect(normalizeLoudness(wide)).toBe(wide);
  });

  it("never lands a sample a hair over the ceiling by rounding", () => {
    // From review: rounding to nearest put this peak at 29205, over -1 dBFS (29204.51).
    const samples = new Int16Array(24000).fill(300);
    samples[12000] = 30000;
    const out = pcmOf(normalizeLoudness(wav(samples)));
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(10 ** (-1 / 20) * 32768);
  });

  it("refuses a fmt chunk shorter than PCM's 16 bytes", () => {
    // From review: a 14-byte fmt followed by a chunk whose id starts 10 00 would have
    // lent its first bytes as the bit depth.
    const fmt = Buffer.alloc(8 + 14);
    fmt.write("fmt ", 0, "latin1");
    fmt.writeUInt32LE(14, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(RATE, 12);
    fmt.writeUInt32LE(RATE * 2, 16);
    fmt.writeUInt16LE(2, 20);
    const odd = Buffer.from([0x10, 0x00, 0x78, 0x78, 0, 0, 0, 0]);
    const pcm = Buffer.from(speechLike(1, -27, -8).buffer);
    const data = Buffer.alloc(8);
    data.write("data", 0, "latin1");
    data.writeUInt32LE(pcm.length, 4);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "latin1");
    head.write("WAVE", 8, "latin1");
    const input = Buffer.concat([head, fmt, odd, data, pcm]);
    input.writeUInt32LE(input.length - 8, 4);
    expect(normalizeLoudness(input)).toBe(input);
  });

  it("returns anything it can't read as it came", () => {
    const samples = speechLike(1, -27, -6);
    const cases = [
      Buffer.from("not audio at all"),
      Buffer.from("RIFF\0\0\0\0WAVEfmt fake"),
      wav(samples, { bits: 24 }),
      wav(samples, { format: 3 }), // float
      wav(new Int16Array(RATE)), // silence: nothing above the gate
      wav(new Int16Array(0)),
    ];
    for (const input of cases) expect(normalizeLoudness(input)).toBe(input);
  });
});
