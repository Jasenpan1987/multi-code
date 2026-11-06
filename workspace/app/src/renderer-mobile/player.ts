// The phone's one player for briefs (epic secretary-bar, Story 3): one HTML audio
// element for the whole app, so a brief keeps playing as the builder moves between
// screens, and one brief at a time.
//
// iOS lets a page start sound only inside the tap that asks for it, so `play` must be
// called from the tap itself, with nothing awaited before it: the brief's audio path
// is already on the phone (RemoteBrief.audioUrl), and `play` sets it and starts in
// one go. An audio element, not Web Audio: it plays with the iPhone's silent switch
// on, as a video does (G-801), which the Audio Session API's "playback" asks for too
// where there is one. Once an element has played from a tap, iOS lets it play again
// without one, which is what the fallback below relies on.
//
// The Mac sends the compact IMA ADPCM WAV first. A phone that can't decode it
// (MEDIA_ERR_SRC_NOT_SUPPORTED) gets the PCM one, and keeps to PCM from then on.
//
// Nothing is kept: the response is `no-store`, and the element lets go of the audio
// when the brief ends or stops.

const PCM_KEY = "multicode.audio.pcm";
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// The parts of HTMLAudioElement used here, so tests can stand in for it.
export interface AudioLike {
  src: string;
  readonly ended: boolean;
  readonly error: { code: number } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: "playing" | "ended" | "error" | "pause", listener: () => void): void;
}

export interface PlayerEvents {
  playing(): void;
  ended(): void;
  // Stopped by something else: the lock screen's controls, a call coming in.
  stopped(): void;
  failed(message: string): void;
}

export interface PlayerEnv {
  createAudio(): AudioLike;
  storage: Storage | null;
}

export function browserPlayerEnv(): PlayerEnv {
  return {
    createAudio: () => new Audio(),
    get storage() {
      try {
        return localStorage;
      } catch {
        return null;
      }
    },
  };
}

export class BriefPlayer {
  private audio: AudioLike | null = null;
  // A brief is playing or starting: the element's events are about it. After a stop,
  // an end or a failure they are about nothing.
  private live = false;
  // Counts plays, so a play() promise from an earlier one is ignored.
  private current = 0;
  private url = "";
  private pcm = false;

  constructor(
    private readonly env: PlayerEnv,
    private readonly events: PlayerEvents
  ) {}

  // From the tap itself (see the top of this file). `title` is what the lock screen
  // shows while it plays.
  play(url: string, title: string) {
    const audio = this.element();
    this.current += 1;
    this.live = true;
    this.url = url;
    this.pcm = this.env.storage?.getItem(PCM_KEY) === "1";
    preferPlayback();
    this.start(audio, this.current);
    showOnLockScreen(title, () => {
      this.stop();
      this.events.stopped();
    });
  }

  stop() {
    this.current += 1;
    this.live = false;
    this.release();
  }

  private start(audio: AudioLike, play: number) {
    audio.src = this.pcm ? `${this.url}&f=pcm` : this.url;
    audio.play().catch((err: unknown) => {
      if (play !== this.current || !this.live) return;
      // A source that fails says so in its `error` event, and a stop aborts.
      if ((err as { name?: string } | null)?.name === "NotAllowedError") {
        this.live = false;
        this.release();
        this.events.failed("The phone didn't let it play. Tap Play again.");
      }
    });
  }

  private element(): AudioLike {
    if (this.audio) return this.audio;
    const audio = this.env.createAudio();
    audio.addEventListener("playing", () => {
      if (this.live) this.events.playing();
    });
    audio.addEventListener("ended", () => {
      if (!this.live) return;
      this.live = false;
      this.release();
      this.events.ended();
    });
    audio.addEventListener("pause", () => {
      // The end pauses first (HTML: "pause", then "ended"), and our own stop isn't live.
      if (!this.live || audio.ended || audio.error) return;
      this.live = false;
      this.release();
      this.events.stopped();
    });
    audio.addEventListener("error", () => {
      if (!this.live) return;
      const code = audio.error?.code;
      if (code === MEDIA_ERR_SRC_NOT_SUPPORTED && !this.pcm) {
        this.pcm = true;
        try {
          this.env.storage?.setItem(PCM_KEY, "1");
        } catch {
          // Full storage: PCM for this launch only.
        }
        this.start(audio, this.current);
        return;
      }
      this.live = false;
      this.release();
      this.events.failed(code === MEDIA_ERR_NETWORK ? "The voice didn't load. Tap Play again." : "The voice couldn't play.");
    });
    this.audio = audio;
    return audio;
  }

  // Lets go of the audio, so nothing of it stays on the phone.
  private release() {
    const audio = this.audio;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
}

// Safari's Audio Session API: "playback" is the category for spoken content, which
// plays with the silent switch on and may keep playing behind the lock screen.
function preferPlayback() {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  try {
    if (session) session.type = "playback";
  } catch {
    // Not settable here.
  }
}

// What the lock screen shows while a brief plays, and its pause button: a stop.
function showOnLockScreen(title: string, stop: () => void) {
  const media = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  if (!media || typeof MediaMetadata === "undefined") return;
  try {
    media.metadata = new MediaMetadata({ title, artist: "Multi-Code" });
    media.setActionHandler("pause", stop);
    media.setActionHandler("stop", stop);
  } catch {
    // An older WebKit without some of it.
  }
}
