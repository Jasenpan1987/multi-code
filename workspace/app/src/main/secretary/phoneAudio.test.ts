// The phone's copy of a brief's audio: its size per minute (at most 1 MB, epic
// secretary-bar NFR Data), its WAV headers, and that what a decoder makes of it is
// still the speech: the ADPCM round trip stays close to the source, a rate above
// 24 kHz loses only what is above the new Nyquist, and stereo becomes mono.

import { describe, expect, it } from "vitest";
import { phoneAudio } from "./phoneAudio";

// 16-bit PCM WAV of `seconds` of `signal(t)` (in [-1, 1]) on every channel.
function wav(rate: number, seconds: number, signal: (t: number) => number, channels = 1): Buffer {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.round(signal(f / rate) * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (f * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Something like speech for the codec: a voice-band sweep with a slow loudness
// envelope and pauses.
const speechLike = (t: number) =>
  0.5 * Math.max(0, Math.sin(2 * Math.PI * 1.3 * t)) * Math.sin(2 * Math.PI * (180 + 900 * (0.5 + 0.5 * Math.sin(t))) * t);

const tone = (hz: number, level = 0.5) => (t: number) => level * Math.sin(2 * Math.PI * hz * t);

interface Fmt {
  format: number;
  channels: number;
  rate: number;
  blockAlign: number;
  bits: number;
  samplesPerBlock?: number;
  frames?: number;
  data: Buffer;
}

function readWav(file: Buffer): Fmt {
  expect(file.toString("latin1", 0, 4)).toBe("RIFF");
  expect(file.readUInt32LE(4)).toBe(file.length - 8);
  expect(file.toString("latin1", 8, 12)).toBe("WAVE");
  let fmt: Omit<Fmt, "data"> | null = null;
  let frames: number | undefined;
  for (let at = 12; at + 8 <= file.length; ) {
    const id = file.toString("latin1", at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = {
        format: file.readUInt16LE(body),
        channels: file.readUInt16LE(body + 2),
        rate: file.readUInt32LE(body + 4),
        blockAlign: file.readUInt16LE(body + 12),
        bits: file.readUInt16LE(body + 14),
        ...(size >= 20 ? { samplesPerBlock: file.readUInt16LE(body + 18) } : {}),
      };
    } else if (id === "fact") {
      frames = file.readUInt32LE(body);
    } else if (id === "data") {
      return { ...fmt!, ...(frames !== undefined ? { frames } : {}), data: file.subarray(body, body + size) };
    }
    at = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const MOVES = [-1, -1, -1, -1, 2, 4, 6, 8];

// The standard decoder (Microsoft's IMA ADPCM, mono), as a player would run it.
function decodeIma(f: Fmt): Float32Array {
  const out: number[] = [];
  for (let at = 0; at + f.blockAlign <= f.data.length; at += f.blockAlign) {
    let predicted = f.data.readInt16LE(at);
    let index = f.data[at + 2];
    out.push(predicted);
    for (let i = 4; i < f.blockAlign; i++) {
      for (const code of [f.data[at + i] & 15, f.data[at + i] >> 4]) {
        const step = STEPS[index];
        let delta = step >> 3;
        if (code & 4) delta += step;
        if (code & 2) delta += step >> 1;
        if (code & 1) delta += step >> 2;
        predicted = Math.max(-32768, Math.min(32767, predicted + (code & 8 ? -delta : delta)));
        index = Math.max(0, Math.min(88, index + MOVES[code & 7]));
        out.push(predicted);
      }
    }
  }
  return Float32Array.from(out.slice(0, f.frames ?? out.length), (v) => v / 32768);
}

function decodePcm(f: Fmt): Float32Array {
  const out = new Float32Array(f.data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = f.data.readInt16LE(i * 2) / 32768;
  return out;
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};

// Signal to noise of `got` against `want`, in dB.
function snr(want: Float32Array, got: Float32Array): number {
  const n = Math.min(want.length, got.length);
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < n; i++) {
    signal += want[i] * want[i];
    noise += (want[i] - got[i]) ** 2;
  }
  return 10 * Math.log10(signal / noise);
}

const perMinute = (bytes: number, seconds: number) => (bytes / seconds) * 60;

describe("phoneAudio", () => {
  it("makes a 24 kHz brief into IMA ADPCM under 1 MB a minute, close to the source", () => {
    const source = wav(24000, 10, speechLike);
    const out = phoneAudio(source, "adpcm");
    const f = readWav(out);
    expect(f).toMatchObject({ format: 0x11, channels: 1, rate: 24000, blockAlign: 512, bits: 4, samplesPerBlock: 1017 });
    expect(f.frames).toBe(240000);
    expect(f.data.length % 512).toBe(0);
    expect(perMinute(out.length, 10)).toBeLessThan(1_000_000);
    expect(perMinute(out.length, 10)).toBeGreaterThan(700_000);

    const want = decodePcm(readWav(source));
    const got = decodeIma(f);
    expect(got.length).toBe(want.length);
    expect(snr(want, got)).toBeGreaterThan(20);
  });

  it("brings 44.1 kHz down to 22.05 kHz, keeping the voice band and dropping what would fold back", () => {
    const voice = phoneAudio(wav(44100, 2, tone(1000)), "pcm");
    const f = readWav(voice);
    expect(f).toMatchObject({ format: 1, channels: 1, rate: 22050, bits: 16 });
    const got = decodePcm(f);
    expect(got.length).toBe(44100);
    // The filter's start and end aside, a 1 kHz tone keeps its level.
    expect(rms(got, 1000, 43000)).toBeCloseTo(0.5 / Math.SQRT2, 2);

    // 17 kHz is past 22.05 kHz's Nyquist: kept, it would come back as 5 kHz.
    const high = decodePcm(readWav(phoneAudio(wav(44100, 2, tone(17000)), "pcm")));
    expect(rms(high, 1000, 43000)).toBeLessThan(0.5 / Math.SQRT2 / 100);

    const compact = phoneAudio(wav(44100, 10, speechLike), "adpcm");
    expect(readWav(compact)).toMatchObject({ format: 0x11, rate: 22050 });
    expect(perMinute(compact.length, 10)).toBeLessThan(700_000);
  });

  it("brings 48 kHz to 24 kHz and keeps 16 kHz as it is", () => {
    expect(readWav(phoneAudio(wav(48000, 1, tone(440)), "adpcm")).rate).toBe(24000);
    expect(readWav(phoneAudio(wav(16000, 1, tone(440)), "adpcm")).rate).toBe(16000);
  });

  it("mixes stereo to mono", () => {
    const f = readWav(phoneAudio(wav(24000, 1, tone(440, 0.4), 2), "pcm"));
    expect(f.channels).toBe(1);
    expect(rms(decodePcm(f))).toBeCloseTo(0.4 / Math.SQRT2, 2);
  });

  it("gives back what isn't 16-bit PCM WAV as it came", () => {
    const notWav = Buffer.from("ID3 not a wav at all");
    expect(phoneAudio(notWav, "adpcm")).toBe(notWav);
    const float = wav(24000, 1, tone(440));
    float.writeUInt16LE(3, 20);
    expect(phoneAudio(float, "adpcm")).toBe(float);
    const empty = wav(24000, 0, tone(440));
    expect(phoneAudio(empty, "pcm")).toBe(empty);
  });
});
