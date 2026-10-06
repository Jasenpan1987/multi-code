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

function playBuffer(
  buffer: AudioBuffer | null,
  volume = 0.5
): AudioBufferSourceNode | null {
  if (!buffer) return null;
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
  return source;
}

// The chime still playing for each instance, so acknowledging that instance can
// cut it short.
const playingByInstance = new Map<string, AudioBufferSourceNode>();

/**
 * Play the "di di di di" attention chime for an instance. A new event while that
 * instance's chime is still playing restarts it.
 */
export function playMessageSound(instanceId: string) {
  stopMessageSound(instanceId);
  const source = playBuffer(messageBuffer, 0.4);
  if (!source) return;
  playingByInstance.set(instanceId, source);
  source.onended = () => {
    if (playingByInstance.get(instanceId) === source) {
      playingByInstance.delete(instanceId);
    }
  };
}

/**
 * Stop an instance's chime if it is still playing. Harmless when it isn't.
 */
export function stopMessageSound(instanceId: string) {
  const source = playingByInstance.get(instanceId);
  if (!source) return;
  playingByInstance.delete(instanceId);
  try {
    source.stop();
  } catch {
    // Already ended between the lookup and the stop.
  }
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
