// A brief's audio as the phone gets it (epic secretary-bar, NFR Data: at most 1 MB a
// minute over cellular data). The speech server's WAV is 2.9 MB a minute (24 kHz) to
// 5.3 MB (44.1 kHz), 16-bit PCM.
//
// Made here, in memory, because the secretary keeps briefs and audio off the disk
// (voice-secretary PRD, Privacy). macOS's `afconvert` would make AAC, but it opens
// its input and output as seekable files, never a pipe: `/dev/stdin` fails with
// "Couldn't open input file" and `/dev/stdout` with "delete output file" (measured
// 2026-11-06), so it would need the audio on disk.
//
// So the phone gets a WAV it can play as it is, in one of two forms:
//   - "adpcm": IMA ADPCM (Microsoft's, format 0x11), 4 bits a sample, mono, at the
//     server's rate up to 24 kHz: 0.72 MB a minute at 24 kHz, 0.67 at 22.05 kHz.
//     WebKit on macOS plays it (Playwright's WebKit, 2026-11-06), through the same
//     Core Audio decoders iOS has; the iPhone itself is the open question (G-804).
//   - "pcm": 16-bit PCM, mono, at the same rate: 2.9 MB a minute. What the desktop
//     plays, for a phone that can't play the first.
// A rate above 24 kHz is brought down by a whole factor first (44.1 → 22.05 kHz,
// 48 → 24 kHz), behind a low-pass filter, so nothing above the new Nyquist folds
// back into the speech. Stereo is mixed to mono.
//
// Anything that isn't 16-bit PCM WAV, or is far longer than any brief, is returned as
// it came. Nothing here throws, and nothing here touches the disk.

import { findPcm16 } from "./loudness";

export type PhoneAudioFormat = "adpcm" | "pcm";

// The highest rate the phone is sent: speech needs no more, and 4 bits a sample
// at 24 kHz is what fits the 1 MB a minute.
export const MAX_PHONE_RATE = 24000;

// Ten minutes at 48 kHz stereo, in samples: past it the audio goes as it came. A
// brief runs under a minute; this only keeps a server sending something huge from
// holding main up for long.
const MAX_SAMPLES = 48000 * 2 * 600;

// The low-pass filter's length (odd, so it has a centre tap) and its cut-off, as a
// share of the new Nyquist: the edge of the passband, with the window's transition
// above it.
const FILTER_TAPS = 63;
const CUTOFF = 0.85;

// 512 bytes a block for mono: 4 of header and 1017 samples, about 42 ms at 24 kHz.
const BLOCK_ALIGN = 512;
const SAMPLES_PER_BLOCK = (BLOCK_ALIGN - 4) * 2 + 1;

export function phoneAudio(wav: Buffer, format: PhoneAudioFormat): Buffer {
  const pcm = findPcm16(wav);
  if (!pcm) return wav;
  const { dataOffset, frames, channels, sampleRate } = pcm;
  if (frames === 0 || frames * channels > MAX_SAMPLES) return wav;

  const mono = toMono(wav, dataOffset, frames, channels);
  const factor = Math.ceil(sampleRate / MAX_PHONE_RATE);
  const samples = factor > 1 ? decimate(mono, factor) : mono;
  const rate = Math.round(sampleRate / factor);
  return format === "adpcm" ? imaWav(toInt16(samples), rate) : pcmWav(toInt16(samples), rate);
}

// Each frame's channels averaged, as floats in [-1, 1). Read through a copy, so the
// view is aligned whatever the Buffer's offset in its pool (WAV is little-endian, as
// every Mac is).
function toMono(wav: Buffer, offset: number, frames: number, channels: number): Float32Array {
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + offset, wav.byteOffset + offset + frames * channels * 2));
  const out = new Float32Array(frames);
  const scale = 1 / channels / 32768;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[f * channels + c];
    out[f] = sum * scale;
  }
  return out;
}

// Every `factor`-th sample of the signal low-passed under the new Nyquist: a
// Blackman-windowed sinc, computed only at the samples kept.
function decimate(input: Float32Array, factor: number): Float32Array {
  const half = (FILTER_TAPS - 1) / 2;
  const cutoff = (0.5 / factor) * CUTOFF;
  const taps = new Float32Array(FILTER_TAPS);
  let sum = 0;
  for (let i = 0; i < FILTER_TAPS; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const window =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (FILTER_TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (FILTER_TAPS - 1));
    taps[i] = sinc * window;
    sum += taps[i];
  }
  // Unity gain at DC.
  for (let i = 0; i < FILTER_TAPS; i++) taps[i] /= sum;

  // Past either end the signal is silence: only the taps over real samples count.
  const out = new Float32Array(Math.ceil(input.length / factor));
  for (let o = 0; o < out.length; o++) {
    const start = o * factor - half;
    const from = Math.max(0, -start);
    const to = Math.min(FILTER_TAPS, input.length - start);
    let acc = 0;
    for (let i = from; i < to; i++) acc += input[start + i] * taps[i];
    out[o] = acc;
  }
  return out;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768)));
  }
  return out;
}

function pcmWav(samples: Int16Array, rate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// The IMA ADPCM step table and how each code moves along it.
const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_MOVES = [-1, -1, -1, -1, 2, 4, 6, 8];

// Mono IMA ADPCM in blocks of BLOCK_ALIGN bytes. Each block starts from a real
// sample and the step index the last one ended on; the last block is padded with
// silence, and the `fact` chunk says how many samples are real.
function imaWav(samples: Int16Array, rate: number): Buffer {
  const blocks = Math.ceil(samples.length / SAMPLES_PER_BLOCK);
  const data = Buffer.alloc(blocks * BLOCK_ALIGN);
  let index = 0;
  for (let b = 0; b < blocks; b++) {
    const first = b * SAMPLES_PER_BLOCK;
    const at = b * BLOCK_ALIGN;
    let predicted = samples[first];
    data.writeInt16LE(predicted, at);
    data[at + 2] = index;
    for (let i = 1; i < SAMPLES_PER_BLOCK; i++) {
      const sample = first + i < samples.length ? samples[first + i] : 0;
      const step = STEPS[index];
      let diff = sample - predicted;
      let code = 0;
      if (diff < 0) {
        code = 8;
        diff = -diff;
      }
      let delta = step >> 3;
      if (diff >= step) {
        code |= 4;
        diff -= step;
        delta += step;
      }
      if (diff >= step >> 1) {
        code |= 2;
        diff -= step >> 1;
        delta += step >> 1;
      }
      if (diff >= step >> 2) {
        code |= 1;
        delta += step >> 2;
      }
      predicted = Math.max(-32768, Math.min(32767, predicted + (code & 8 ? -delta : delta)));
      index = Math.max(0, Math.min(88, index + INDEX_MOVES[code & 7]));
      // Two samples a byte, the earlier in the low nibble.
      const byte = at + 4 + ((i - 1) >> 1);
      data[byte] |= (i - 1) % 2 === 0 ? code : code << 4;
    }
  }

  const header = Buffer.alloc(60);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(52 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(20, 16);
  header.writeUInt16LE(0x11, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(Math.round((rate * BLOCK_ALIGN) / SAMPLES_PER_BLOCK), 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(4, 34);
  header.writeUInt16LE(2, 36);
  header.writeUInt16LE(SAMPLES_PER_BLOCK, 38);
  header.write("fact", 40, "latin1");
  header.writeUInt32LE(4, 44);
  header.writeUInt32LE(samples.length, 48);
  header.write("data", 52, "latin1");
  header.writeUInt32LE(data.length, 56);
  return Buffer.concat([header, data]);
}
