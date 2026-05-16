let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

let messageBuffer: AudioBuffer | null = null;
let onlineBuffer: AudioBuffer | null = null;

async function loadSound(url: string): Promise<AudioBuffer | null> {
  try {
    const ctx = getAudioContext();
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer);
  } catch {
    return null;
  }
}

function playBuffer(buffer: AudioBuffer | null, volume = 0.5) {
  if (!buffer) return;
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume();
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

/**
 * Play "di di di di" message notification sound.
 */
export function playMessageSound() {
  playBuffer(messageBuffer, 0.4);
}

/**
 * Play door knock sound when agent comes online.
 */
export function playCoughSound() {
  playBuffer(onlineBuffer, 0.5);
}

// Pre-load sounds on startup
async function init() {
  messageBuffer = await loadSound("./assets/message.mp3");
  onlineBuffer = await loadSound("./assets/online.mp3");
}

init();
