// The secretary bar on the phone (epic secretary-bar, Stories 1 to 4): which brief it
// shows, and what it says about it. Pure, over the app state (state.ts runs
// `settleBar` after every change), so every rule is tested on its own (bar.test.ts).
//
// The order is the desk's: shared/secretaryQueue.ts, over the briefs the Mac sends.
// This phone moves through it on its own. The brief on the bar stays while the
// builder is busy with it (`shownBrief`'s hold): it plays, its panel is open, a reply
// to it is on its way or being read, or its session is the one on screen. The last
// is the phone's own: a session opened from its push has its brief on the bar (Story
// 6), and opening it reads it, which would otherwise move the bar on under the
// builder's eyes. A session that opens, or gets a new brief while open, brings its
// brief to the bar while it waits, unless the builder is busy with another.

import type { RemoteBrief } from "../shared/remote-protocol";
import { briefSentence } from "../shared/briefSentence";
import { isWaiting, shownBrief, type BriefRef } from "../shared/secretaryQueue";
import type { AppState, Bar, Player } from "./state";

export const sameRef = (a: BriefRef | null | undefined, b: BriefRef | null | undefined): boolean =>
  a === b || (!!a && !!b && a.instanceId === b.instanceId && a.seq === b.seq);

export const refKey = (ref: BriefRef) => `${ref.instanceId}:${ref.seq}`;

// The brief the ref names, while it is still its session's.
export function briefOf(state: Pick<AppState, "secretary">, ref: BriefRef | null): RemoteBrief | null {
  if (!ref || !state.secretary?.on) return null;
  const brief = state.secretary.briefs[ref.instanceId];
  return brief?.seq === ref.seq ? brief : null;
}

export const isPlaying = (player: Player, ref: BriefRef | null): boolean =>
  (player.status === "loading" || player.status === "playing") && sameRef(player.ref, ref);

// A reply to the brief is on its way to the Mac, or the secretary is reading one.
export function isReplying(state: Pick<AppState, "secretary" | "outbox">, ref: BriefRef | null): boolean {
  if (!ref) return false;
  if (briefOf(state, ref)?.exchanges?.some((e) => !e.outcome)) return true;
  return state.outbox.some(
    (i) =>
      i.frame.type === "secretary-reply" &&
      i.status === "sent" &&
      i.frame.instanceId === ref.instanceId &&
      i.frame.seq === ref.seq
  );
}

const FOLDED: Bar = Object.freeze({ shown: null, open: false }) as Bar;

export function settleBar(prev: AppState, next: AppState): AppState {
  if (
    next.secretary === prev.secretary &&
    next.bar === prev.bar &&
    next.player === prev.player &&
    next.outbox === prev.outbox &&
    next.openId === prev.openId
  ) {
    return next;
  }
  const bar = barOf(prev, next);
  return sameRef(bar.shown, next.bar.shown) && bar.open === next.bar.open ? next : { ...next, bar };
}

function barOf(prev: AppState, next: AppState): Bar {
  const secretary = next.secretary;
  if (!secretary?.on) return FOLDED;
  const { briefs } = secretary;
  const current = next.bar.shown;
  const busy = next.bar.open || isPlaying(next.player, current) || isReplying(next, current);
  const onScreen = current !== null && current.instanceId === next.openId;
  let shown = shownBrief(current, briefs, busy || onScreen);
  const id = next.openId;
  if (id && !busy) {
    const brief = briefs[id];
    const arrived = id !== prev.openId || brief?.seq !== prev.secretary?.briefs[id]?.seq;
    if (brief && arrived && isWaiting(brief)) shown = { instanceId: id, seq: brief.seq };
  }
  if (sameRef(shown, current)) shown = current;
  return { shown, open: next.bar.open && shown !== null };
}

// ---------------------------------------------------------------------------
// What the bar says
// ---------------------------------------------------------------------------

// The folded bar's one line after the title.
export function foldedLine(brief: RemoteBrief | null): string {
  if (!brief) return "Nothing new";
  switch (brief.status) {
    case "preparing":
      return "Writing the brief…";
    case "failed":
      return "No brief could be written";
    case "ready":
      return briefSentence(brief.text);
  }
}

// The secretary's state, as the panel's line says it (Story 1).
export function stateLine(brief: RemoteBrief | null, player: Player, ref: BriefRef | null): string {
  if (!brief) return "Nothing new";
  if (sameRef(player.ref, ref)) {
    if (player.status === "playing") return "Playing";
    if (player.status === "loading") return "Starting the voice…";
    if (player.status === "error") return player.error ?? "The voice couldn't play";
  }
  switch (brief.status) {
    case "preparing":
      return "Writing the brief…";
    case "failed":
      return `No brief could be written: ${brief.reason}`;
    case "ready":
      if (brief.audio === "pending") return "The voice is on its way…";
      if (brief.audio === "unavailable") return `Text only, no voice: ${brief.voiceReason ?? "unavailable"}`;
      return "Ready to play";
  }
}

// What Play does for the brief now: play it, nothing yet (the voice is coming, or
// the Mac can't be reached), or nothing at all (no voice for this brief).
export type PlayOffer = "play" | "replay" | "stop" | "wait" | "offline" | "none";

export function playOffer(
  brief: RemoteBrief | null,
  state: Pick<AppState, "player" | "played" | "connection" | "secretaryLive">,
  ref: BriefRef | null
): PlayOffer {
  if (!brief || !ref) return "none";
  if (isPlaying(state.player, ref)) return "stop";
  if (brief.status === "preparing") return "wait";
  if (brief.status !== "ready" || brief.audio === "unavailable") return "none";
  if (brief.audio === "pending") return "wait";
  if (state.connection.state !== "connected" || !state.secretaryLive || !brief.audioUrl) return "offline";
  return state.played.includes(refKey(ref)) ? "replay" : "play";
}
