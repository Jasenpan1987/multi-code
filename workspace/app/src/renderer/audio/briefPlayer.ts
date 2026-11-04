// The one audio element every secretary brief plays through (epic voice-secretary,
// PRD Story 3: only one brief plays at a time). Loading a brief unloads whatever was
// loaded before, so starting one stops any other. Separate from sounds.ts: the chime
// is Web Audio and keeps its own rules (docs/specs/attention-alerts/prd.md).
//
// A brief is loaded under a key (instance and event seq), so a card can only stop,
// replay or release its own brief, never one that replaced it. The wav comes from
// main as bytes and plays from a Blob URL, revoked when the brief is unloaded.
//
// The element sits in the document, hidden (no `controls`), as
// `audio.secretary-audio`, so its state can be read over CDP.

let element: HTMLAudioElement | null = null;
let loadedKey: string | null = null;
let objectUrl: string | null = null;
// The loaded brief's audio couldn't be played (the element reported an error).
let failed = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function audio(): HTMLAudioElement {
  if (element) return element;
  element = document.createElement("audio");
  element.className = "secretary-audio";
  element.preload = "auto";
  for (const type of ["play", "pause", "ended", "emptied"]) {
    element.addEventListener(type, emit);
  }
  element.addEventListener("error", () => {
    // An error from unloading (src removed) is not about any brief.
    if (loadedKey === null) return;
    failed = true;
    emit();
  });
  document.body.appendChild(element);
  return element;
}

function unload() {
  if (element) {
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  loadedKey = null;
  failed = false;
}

// play() rejects when a pause or a new source interrupts it, which is how a stop or
// another brief ends this one. Nothing to report.
function start(el: HTMLAudioElement) {
  void el.play().catch(() => {});
}

export function playBrief(key: string, wav: Uint8Array): void {
  const el = audio();
  unload();
  // Copied into a fresh ArrayBuffer: a Blob part can't be a view on a shared buffer.
  objectUrl = URL.createObjectURL(new Blob([new Uint8Array(wav)], { type: "audio/wav" }));
  loadedKey = key;
  el.src = objectUrl;
  start(el);
  emit();
}

// From the start, if this brief is still the loaded one. False when it isn't, and
// the caller fetches the wav again.
export function replayBrief(key: string): boolean {
  if (!element || loadedKey !== key) return false;
  element.currentTime = 0;
  start(element);
  return true;
}

// Stop and rewind, keeping the brief loaded for a replay.
export function stopBrief(key: string): void {
  if (!element || loadedKey !== key) return;
  element.pause();
  element.currentTime = 0;
}

// Stop and let go of the audio, when the brief's card closes.
export function releaseBrief(key: string): void {
  if (loadedKey !== key) return;
  unload();
  emit();
}

export function isBriefPlaying(key: string): boolean {
  return element !== null && loadedKey === key && !element.paused && !element.ended;
}

export function briefPlaybackFailed(key: string): boolean {
  return loadedKey === key && failed;
}

export function subscribeBriefPlayback(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
