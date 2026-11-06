// The secretary bar's view rules (epic secretary-bar, PRD Stories 1-4 and 7), kept
// out of App and SecretaryBar so they are plain functions with tests. Which brief the
// bar shows, and the queue, are shared/secretaryQueue.ts's, so desk and phone agree.

import { isWaiting } from "../../shared/secretaryQueue";
import type { BriefMap } from "../../shared/secretaryQueue";
import type {
  BriefLanguage,
  SecretaryBriefState,
  SecretaryExchange,
} from "../../shared/types";

export type { BriefMap } from "../../shared/secretaryQueue";

// One push from main: a new or changed brief, or null when it was dropped.
export function applyBriefUpdate(
  briefs: BriefMap,
  instanceId: string,
  state: SecretaryBriefState | null
): BriefMap {
  if (state === null) {
    if (!(instanceId in briefs)) return briefs;
    const next = { ...briefs };
    delete next[instanceId];
    return next;
  }
  return { ...briefs, [instanceId]: state };
}

// The briefs fetched at mount, merged under whatever arrived by push since the
// subscription started: for an instance a push has touched (including a drop), the
// push is newer than or the same as the snapshot, so it wins.
export function mergeBriefSnapshot(
  current: BriefMap,
  snapshot: BriefMap,
  touched: ReadonlySet<string>
): BriefMap {
  const merged: BriefMap = {};
  for (const [instanceId, state] of Object.entries(snapshot)) {
    if (!touched.has(instanceId)) merged[instanceId] = state;
  }
  for (const instanceId of touched) {
    const state = current[instanceId];
    if (state) merged[instanceId] = state;
  }
  return merged;
}

// The shown brief's audio, as the bar knows it.
export interface Playback {
  playing: boolean;
  // Fetching the wav after a click on Play.
  loading: boolean;
  // The audio element couldn't play it.
  failed: boolean;
  // Main had no audio for this seq any more: the brief was replaced or dropped, and
  // its update is on the way.
  stale: boolean;
}

export const IDLE: Playback = { playing: false, loading: false, failed: false, stale: false };

// muted: on its way, or nothing to say; ready: can be played; playing; warn: something
// failed, with main's reason.
export type BarTone = "muted" | "ready" | "playing" | "warn";

export interface BarState {
  tone: BarTone;
  text: string;
  // Main's reason, shown small beside the state and in full on hover.
  detail?: string;
}

// The secretary's state for the brief on the bar (Story 1), or for no brief at all.
export function barState(brief: SecretaryBriefState | null, playback: Playback): BarState {
  if (!brief) return { tone: "muted", text: "Nothing new" };
  switch (brief.status) {
    case "preparing":
      return { tone: "muted", text: "Writing the brief…" };
    case "failed":
      return { tone: "warn", text: "No brief could be written", detail: brief.reason };
    case "ready":
      if (playback.failed) return { tone: "warn", text: "Couldn't play the voice" };
      if (playback.stale) return { tone: "muted", text: "This brief is out of date" };
      if (playback.playing) return { tone: "playing", text: "Playing" };
      if (playback.loading) return { tone: "muted", text: "Loading the voice…" };
      if (brief.audio === "pending") return { tone: "muted", text: "Voice on its way…" };
      if (brief.audio === "unavailable") {
        return { tone: "warn", text: "Voice unavailable", detail: brief.voiceReason };
      }
      return { tone: "ready", text: "Ready" };
  }
}

export interface BarControls {
  // Play is on the bar: not once the voice is known to be unavailable, or when there
  // is no brief to speak (Story 3).
  playShown: boolean;
  // The wav can be fetched for this brief's seq.
  canPlay: boolean;
  canStop: boolean;
  // "Got it": a Finished brief still waiting for the builder (Story 4). A Needs you
  // leaves the queue only when its dialog is answered.
  canDismiss: boolean;
}

export function barControls(brief: SecretaryBriefState | null, playback: Playback): BarControls {
  const canStop = playback.playing || playback.loading;
  if (!brief) return { playShown: false, canPlay: false, canStop, canDismiss: false };
  const canDismiss = brief.kind === "finished" && isWaiting(brief);
  if (brief.status === "failed") return { playShown: false, canPlay: false, canStop, canDismiss };
  if (brief.status === "preparing") return { playShown: true, canPlay: false, canStop, canDismiss };
  return {
    playShown: brief.audio !== "unavailable",
    canPlay: brief.audio === "ready" && !playback.stale,
    canStop,
    canDismiss,
  };
}

// The bar's place in the queue: "2 / 3", "– / 3" while it shows a brief that no
// longer waits (held, or the latest when nothing waits), or null with an empty
// queue, where ‹ › have nowhere to go.
export function queueLabel(place: { index: number; count: number }): string | null {
  if (place.count === 0) return null;
  return `${place.index > 0 ? place.index : "–"} / ${place.count}`;
}

// Playing to the end, like "Got it", reads a Finished brief's session (Story 4). A
// Needs you is dealt with only by answering its dialog.
export function readsOnEnd(brief: SecretaryBriefState | null): boolean {
  return brief?.kind === "finished";
}

// A read from the bar names its brief by seq, and counts only while that is still
// the instance's brief here, and a Finished: a newer event may have replaced it
// since, and the newer brief wasn't read. Main checks the same against its own.
export function isReadableBrief(briefs: BriefMap, instanceId: string, seq: number): boolean {
  const brief = briefs[instanceId];
  return brief?.seq === seq && brief.kind === "finished";
}

// One brief: its instance and its event's seq.
export const briefKey = (instanceId: string, seq: number) => `${instanceId}#${seq}`;

// The bar's unsent replies, one per brief (by briefKey), so stepping to another brief
// and back keeps what was typed or dictated on each.
export type Drafts = Readonly<Record<string, string>>;

export function editDraft(drafts: Drafts, key: string, text: string): Drafts {
  if (text) return { ...drafts, [key]: text };
  if (!(key in drafts)) return drafts;
  const next = { ...drafts };
  delete next[key];
  return next;
}

// Only the drafts whose brief is still there: a replaced or dropped brief's reply has
// nothing left to answer. The same object when nothing goes.
export function keepDrafts(drafts: Drafts, briefs: BriefMap): Drafts {
  const gone = Object.keys(drafts).filter(
    (key) => !Object.entries(briefs).some(([id, brief]) => briefKey(id, brief.seq) === key)
  );
  if (!gone.length) return drafts;
  const next = { ...drafts };
  for (const key of gone) delete next[key];
  return next;
}

// The open bar's reply box (voice-secretary T-510): on a Needs-you whose dialog the
// secretary can answer in words, until the dialog is dealt with. Gone once it is
// handled, by the secretary's own keys or anyone else's; the exchanges stay.
export interface ReplyView {
  exchanges: SecretaryExchange[];
  boxShown: boolean;
  // A reply is still being read or acted on: one at a time.
  pending: boolean;
}

export function replyView(state: SecretaryBriefState): ReplyView {
  const exchanges = state.exchanges ?? [];
  return {
    exchanges,
    boxShown: state.kind === "needs-you" && state.replyable === true && !state.handled,
    pending: exchanges.some((e) => !e.outcome),
  };
}

// The `lang` the brief text is marked with, so the font fallback picks CJK glyphs
// for a Chinese brief.
export function briefLang(language: BriefLanguage | null): string | undefined {
  if (language === "Chinese") return "zh";
  if (language === "English") return "en";
  return undefined;
}
