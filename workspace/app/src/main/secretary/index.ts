// The voice secretary's orchestrator (T-505). Each Claude instance's live event
// (T-503, process-manager's `onSecretaryEvent`) becomes a brief (T-504) and, when
// a speech server is set, that brief's audio (T-502), prepared the moment the
// alert fires so it is ready before the click (PRD Story 2).
//
// One entry per instance with a live event, in memory only: the text, the wav and
// the state go when the event clears, when a newer event replaces it, or when
// Secretary Mode goes off. Nothing here writes to disk (PRD, Privacy).
//
// Per event, text first, then audio:
//
//   preparing ─▶ ready, audio pending ─▶ ready, audio ready | unavailable
//       │                 (text shown)     (no server set, or synthesis failed)
//       └──────▶ failed (no brief could be written)
//
// With no server set, "ready" goes straight to audio unavailable. One brief and at
// most one speech request per event, never retried (Story 7). A newer event for
// the same instance, a clear, or the mode going off aborts the work in flight (the
// brief writer kills its CLI, the speech request is cancelled), and anything that
// still comes back for it is discarded. While the mode is off nothing is spawned or
// called; turning it on prepares every event still live (Story 1).
//
// The renderer hears every change on `secretary-brief` (instanceId, state | null)
// and the mode on `secretary-mode`; it fetches a ready wav by instance and seq, so
// the audio never rides an update.

import { BrowserWindow } from "electron";
import { processManager } from "../process-manager";
import type { SecretaryEvent, SecretaryEventListener } from "../process-manager";
import { loadSpeechServer } from "../settings-store";
import { synthesize } from "./speech";
import type { SpeechOptions, SpeechServer, SynthesizeResult } from "./speech";
import { writeBriefFor } from "./briefWriter";
import type { Brief } from "./briefWriter";
import type { BriefLanguage, SecretaryBriefState } from "../../shared/types";

export interface SecretaryDeps {
  onSecretaryEvent(listener: SecretaryEventListener): () => void;
  liveSecretaryEvents(): { instanceId: string; event: SecretaryEvent }[];
  writeBriefFor(
    instanceId: string,
    event: SecretaryEvent,
    signal: AbortSignal
  ): Promise<Brief>;
  // Read once per brief, so a server that comes back, or a new address or key,
  // applies to the next brief without a restart.
  loadSpeechServer(): SpeechServer;
  synthesize(
    server: SpeechServer,
    text: string,
    language: BriefLanguage,
    options: SpeechOptions
  ): Promise<SynthesizeResult>;
  // To the renderer.
  send(channel: string, ...args: unknown[]): void;
}

export interface Secretary {
  // Subscribe to events and apply the saved mode. Once, at app start.
  start(enabled: boolean): void;
  setMode(enabled: boolean): void;
  isOn(): boolean;
  // Every live brief, by instance id.
  briefs(): Record<string, SecretaryBriefState>;
  // The wav of the instance's brief for event `seq`, or null when that is no
  // longer its brief or its audio isn't ready.
  audioFor(instanceId: string, seq: number): Buffer | null;
  // Unsubscribe and abort everything in flight. At quit.
  stop(): void;
}

export const BRIEF_CHANNEL = "secretary-brief";
export const MODE_CHANNEL = "secretary-mode";

export const NO_SERVER_REASON = "no speech server set";

interface Job {
  event: SecretaryEvent;
  state: SecretaryBriefState;
  abort: AbortController;
  wav?: Buffer;
}

export function createSecretary(deps: SecretaryDeps): Secretary {
  let on = false;
  let unsubscribe: (() => void) | null = null;
  const jobs = new Map<string, Job>();

  const isCurrent = (instanceId: string, job: Job) => jobs.get(instanceId) === job;

  const publish = (instanceId: string, job: Job, state: SecretaryBriefState) => {
    job.state = state;
    deps.send(BRIEF_CHANNEL, instanceId, state);
  };

  const drop = (instanceId: string) => {
    const job = jobs.get(instanceId);
    if (!job) return;
    jobs.delete(instanceId);
    job.abort.abort();
    deps.send(BRIEF_CHANNEL, instanceId, null);
  };

  const prepare = (instanceId: string, event: SecretaryEvent) => {
    const current = jobs.get(instanceId);
    // Already on this event (or, impossibly, a newer one).
    if (current && current.event.seq >= event.seq) return;
    // Replaced in place: the renderer goes straight from the old brief to the new
    // one's "preparing", with no null in between.
    current?.abort.abort();
    const job: Job = {
      event,
      abort: new AbortController(),
      state: { seq: event.seq, kind: event.kind, status: "preparing" },
    };
    jobs.set(instanceId, job);
    deps.send(BRIEF_CHANNEL, instanceId, job.state);
    void run(instanceId, job).catch((err) => {
      // Last resort: run() catches the writer and the speech client itself, and
      // reading the speech settings doesn't throw. A brief stuck on "preparing"
      // would leave the card waiting forever, so say why instead.
      if (isCurrent(instanceId, job) && job.state.status === "preparing") {
        publish(instanceId, job, { ...job.state, status: "failed", reason: reasonOf(err) });
      }
    });
  };

  async function run(instanceId: string, job: Job) {
    const { seq, kind } = job.event;
    const { signal } = job.abort;

    let brief: Brief;
    try {
      brief = await deps.writeBriefFor(instanceId, job.event, signal);
    } catch (err) {
      brief = { ok: false, reason: reasonOf(err) };
    }
    if (!isCurrent(instanceId, job)) return;
    if (!brief.ok) {
      publish(instanceId, job, { seq, kind, status: "failed", reason: brief.reason });
      return;
    }

    const { text, language } = brief;
    const ready = { seq, kind, status: "ready", text, language } as const;
    const server = deps.loadSpeechServer();
    if (!server.url.trim()) {
      publish(instanceId, job, { ...ready, audio: "unavailable", voiceReason: NO_SERVER_REASON });
      return;
    }
    publish(instanceId, job, { ...ready, audio: "pending" });

    let spoken: SynthesizeResult;
    try {
      spoken = await deps.synthesize(server, text, language, { signal });
    } catch (err) {
      spoken = { ok: false, reason: reasonOf(err) };
    }
    if (!isCurrent(instanceId, job)) return;
    if (spoken.ok) {
      job.wav = spoken.wav;
      publish(instanceId, job, { ...ready, audio: "ready" });
    } else {
      publish(instanceId, job, { ...ready, audio: "unavailable", voiceReason: spoken.reason });
    }
  }

  const onEvent: SecretaryEventListener = (instanceId, event) => {
    if (!on) return;
    if (event) prepare(instanceId, event);
    else drop(instanceId);
  };

  const setMode = (enabled: boolean) => {
    if (enabled === on) return;
    on = enabled;
    deps.send(MODE_CHANNEL, on);
    if (on) {
      for (const { instanceId, event } of deps.liveSecretaryEvents()) {
        prepare(instanceId, event);
      }
    } else {
      for (const instanceId of jobs.keys()) drop(instanceId);
    }
  };

  return {
    start(enabled) {
      if (unsubscribe) return;
      unsubscribe = deps.onSecretaryEvent(onEvent);
      setMode(enabled);
    },
    setMode,
    isOn: () => on,
    briefs() {
      const all: Record<string, SecretaryBriefState> = {};
      for (const [instanceId, job] of jobs) all[instanceId] = job.state;
      return all;
    },
    audioFor(instanceId, seq) {
      const job = jobs.get(instanceId);
      if (!job || job.event.seq !== seq) return null;
      return job.wav ?? null;
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      on = false;
      for (const instanceId of jobs.keys()) drop(instanceId);
    },
  };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendToRenderer(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

// The app's secretary, on the real modules. main/index.ts starts it with the
// saved mode; the secretary:* IPC handlers drive it.
export const secretary = createSecretary({
  onSecretaryEvent: (listener) => processManager.onSecretaryEvent(listener),
  liveSecretaryEvents: () => processManager.liveSecretaryEvents(),
  writeBriefFor,
  loadSpeechServer,
  synthesize,
  send: sendToRenderer,
});
