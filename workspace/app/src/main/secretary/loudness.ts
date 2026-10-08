// Brings a brief's audio to an ordinary speech loudness (T-515). The speech server's
// output sits around -27 dBFS, about 10 dB under what macOS's own `say` produces
// (measured 2026-10-08: -16 to -18 dBFS), so the builder had to turn the Mac all the
// way up to hear a brief.
//
// A plain gain can't close that gap: the server's speech has a crest factor of 18-22
// dB (a few short peaks well above the rest), so the gain that reaches the target
// would push those peaks past full scale. So: one gain to the target, then a
// limiter that pulls only the peaks under a ceiling.
//
// The limiter is a moving minimum of the gain each frame needs, smoothed by a moving
// average of the same width. Every frame in the average's window has that frame
// inside its own minimum's window, so the smoothed gain never exceeds what any frame
// needs: no sample can clip, by construction rather than by a final clamp. The gain
// then recovers no faster than RELEASE_MS, so it doesn't flutter between peaks.
//
// Anything that isn't 16-bit PCM WAV is returned as it came. Nothing here throws.

// -18 at first, near macOS `say`; raised 1.5 dB (about 20% louder) after the
// builder listened at normal volume and still found it a little quiet (2026-10-09).
export const TARGET_DBFS = -16.5;
// Under full scale, so a player's own resampling can't push a peak over.
const CEILING_DBFS = -1;
// A near-silent clip shouldn't have its noise floor lifted to speech level.
const MAX_GAIN_DB = 20;
// Loudness is measured over 50 ms blocks louder than this, so pauses don't count.
const GATE_DBFS = -50;
const BLOCK_MS = 50;
// Half the width of the limiter's window: how early the gain starts to dip ahead of
// a peak, and how long the dip takes.
const LOOKAHEAD_MS = 5;
const RELEASE_MS = 80;
// Three times the longest brief, mono at the server's 24 kHz, counted in samples so
// extra channels can't get past it. Past it the audio plays as it came: the work
// here is synchronous in main and allocates ~40 bytes a sample, so a server sending
// something huge mustn't freeze the app.
const MAX_SAMPLES = 24000 * 180;

export function normalizeLoudness(wav: Buffer): Buffer {
  const pcm = findPcm16(wav);
  if (!pcm) return wav;
  const { dataOffset, frames, channels, sampleRate } = pcm;
  if (frames === 0 || frames * channels > MAX_SAMPLES) return wav;

  // A copy, so the view is aligned whatever the Buffer's offset in its pool. WAV is
  // little-endian, as is every platform Electron ships on.
  const pcmBytes = frames * channels * 2;
  const input = new Int16Array(wav.buffer.slice(wav.byteOffset + dataOffset, wav.byteOffset + dataOffset + pcmBytes));
  const samples = new Float32Array(frames * channels);
  const framePeak = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const i = f * channels + c;
      const v = input[i] / 32768;
      samples[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    framePeak[f] = peak;
  }

  const loudness = gatedRms(samples, channels, Math.round((sampleRate * BLOCK_MS) / 1000));
  if (loudness === null) return wav;
  const gain = Math.min(dbToLinear(TARGET_DBFS) / loudness, dbToLinear(MAX_GAIN_DB));

  const ceiling = dbToLinear(CEILING_DBFS);
  const need = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const level = framePeak[f] * gain;
    need[f] = level > ceiling ? ceiling / level : 1;
  }
  const half = Math.max(1, Math.round((sampleRate * LOOKAHEAD_MS) / 1000));
  const smooth = movingAverage(movingMin(need, half), half);
  const recover = 1 - Math.exp(-1 / ((sampleRate * RELEASE_MS) / 1000));

  const output = new Int16Array(frames * channels);
  let env = 1;
  for (let f = 0; f < frames; f++) {
    env = Math.min(smooth[f], env + (1 - env) * recover);
    for (let c = 0; c < channels; c++) {
      const i = f * channels + c;
      // Toward zero, not to nearest: rounding up could land a hair over the ceiling.
      const v = Math.trunc(samples[i] * gain * env * 32768);
      output[i] = Math.max(-32768, Math.min(32767, v));
    }
  }
  const out = Buffer.from(wav);
  out.set(new Uint8Array(output.buffer), dataOffset);
  return out;
}

// RMS over the blocks above the gate, or null when every block is below it.
export function gatedRms(samples: Float32Array, channels: number, blockFrames: number): number | null {
  const blockLen = Math.max(1, blockFrames) * channels;
  const gate = dbToLinear(GATE_DBFS) ** 2;
  let sum = 0;
  let kept = 0;
  for (let start = 0; start < samples.length; start += blockLen) {
    const end = Math.min(samples.length, start + blockLen);
    let blockSum = 0;
    for (let i = start; i < end; i++) blockSum += samples[i] * samples[i];
    if (blockSum / (end - start) <= gate) continue;
    sum += blockSum;
    kept += end - start;
  }
  return kept === 0 ? null : Math.sqrt(sum / kept);
}

// KSDATAFORMAT_SUBTYPE_PCM, 00000001-0000-0010-8000-00aa00389b71, as stored.
const PCM_SUBFORMAT = Buffer.from("0100000000001000800000aa00389b71", "hex");

// The data chunk of a 16-bit PCM WAV, or null for anything else. Walks the chunks
// rather than assuming a 44-byte header, and trusts no size past the buffer's end
// (a streamed WAV can carry a placeholder data size).
function findPcm16(wav: Buffer) {
  if (wav.length < 12) return null;
  if (wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") {
    return null;
  }
  let format: { channels: number; sampleRate: number } | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("latin1", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      // A fmt chunk shorter than PCM's 16 bytes, or cut off, can't be read.
      if (size < 16 || body + 16 > wav.length) return null;
      const audioFormat = wav.readUInt16LE(body);
      const channels = wav.readUInt16LE(body + 2);
      const sampleRate = wav.readUInt32LE(body + 4);
      const bits = wav.readUInt16LE(body + 14);
      // 1 is PCM; 0xfffe (extensible) is PCM only when its SubFormat GUID says so.
      const pcm =
        audioFormat === 1 ||
        (audioFormat === 0xfffe &&
          size >= 40 &&
          body + 40 <= wav.length &&
          wav.subarray(body + 24, body + 40).equals(PCM_SUBFORMAT));
      format = pcm && bits === 16 && channels > 0 && sampleRate > 0 ? { channels, sampleRate } : null;
      if (!format) return null;
    } else if (id === "data") {
      if (!format) return null;
      const bytes = Math.min(size, wav.length - body);
      return { ...format, dataOffset: body, frames: Math.floor(bytes / (2 * format.channels)) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

// out[i] = min(values[i - half .. i + half]), clipped at the ends. A monotonic
// queue keeps it linear; a brief is a million frames.
function movingMin(values: Float32Array, half: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    for (; next < n && next <= i + half; next++) {
      while (tail > head && values[queue[tail - 1]] >= values[next]) tail--;
      queue[tail++] = next;
    }
    while (queue[head] < i - half) head++;
    out[i] = values[queue[head]];
  }
  return out;
}

// out[i] = mean(values[i - half .. i + half]), clipped at the ends.
function movingAverage(values: Float32Array, half: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}
