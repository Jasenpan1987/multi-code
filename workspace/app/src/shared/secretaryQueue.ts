// The secretary bar's queue (epic secretary-bar, PRD Stories 2 and 4), shared by the
// desktop and the phone, so both take the same briefs in the same order. Plain
// functions over the briefs main publishes (`secretary-brief`); each device keeps its
// own "shown" brief and moves through the queue on its own.
//
// A brief waits for the builder while it isn't handled (its event cleared: the dialog
// was answered, someone typed in the session, it exited) and, for a Finished, while
// its session hasn't been read since (`seen`). Waiting briefs go Needs you first, then
// Finished, the oldest first within each.

import type { SecretaryBriefState } from "./types";

export type BriefMap = Record<string, SecretaryBriefState>;

// One brief: its instance and its event. A brief with a new seq is a different brief.
export interface BriefRef {
  instanceId: string;
  seq: number;
}

export function isWaiting(brief: SecretaryBriefState): boolean {
  if (brief.handled) return false;
  return brief.kind === "needs-you" || !brief.seen;
}

const rank = (brief: SecretaryBriefState) => (brief.kind === "needs-you" ? 0 : 1);

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Every waiting brief, in the order the bar takes them. Ties (the same time) go by
// instance id, so desk and phone agree.
export function briefQueue(briefs: BriefMap): BriefRef[] {
  return Object.entries(briefs)
    .filter(([, brief]) => isWaiting(brief))
    .sort(([ia, a], [ib, b]) => rank(a) - rank(b) || a.at - b.at || byId(ia, ib))
    .map(([instanceId, brief]) => ({ instanceId, seq: brief.seq }));
}

// The latest brief by event time, waiting or not: what the bar shows when nothing
// waits, so it can still be read and replayed.
export function latestBrief(briefs: BriefMap): BriefRef | null {
  let best: [string, SecretaryBriefState] | null = null;
  for (const entry of Object.entries(briefs)) {
    const [id, brief] = entry;
    if (!best || brief.at > best[1].at || (brief.at === best[1].at && byId(id, best[0]) < 0)) {
      best = entry;
    }
  }
  return best ? { instanceId: best[0], seq: best[1].seq } : null;
}

const sameBrief = (ref: BriefRef, briefs: BriefMap) => briefs[ref.instanceId]?.seq === ref.seq;

// What the bar shows now, from what it showed before (`current`). `hold`: the
// builder is busy with the shown brief (it is playing, its panel is open, a reply is
// in flight), so it stays while it exists, dealt with or not, and never changes under
// their eyes. Otherwise:
// - the shown brief while it still waits;
// - the same session's newer brief, while that waits: a new event on the session the
//   bar shows keeps the bar there;
// - else the head of the queue, so a brief that was dealt with gives way silently;
// - else the latest brief; else nothing.
export function shownBrief(current: BriefRef | null, briefs: BriefMap, hold = false): BriefRef | null {
  if (current) {
    const brief = briefs[current.instanceId];
    if (brief && brief.seq === current.seq && (hold || isWaiting(brief))) return current;
    if (brief && brief.seq !== current.seq && isWaiting(brief)) {
      return { instanceId: current.instanceId, seq: brief.seq };
    }
  }
  return briefQueue(briefs)[0] ?? latestBrief(briefs);
}

// The shown brief's place in the queue, from 1, and the queue's length. `index` is 0
// when the shown brief isn't waiting (the bar shows the latest, or nothing).
export function queuePlace(shown: BriefRef | null, briefs: BriefMap): { index: number; count: number } {
  const queue = briefQueue(briefs);
  const index = shown ? queue.findIndex((r) => r.instanceId === shown.instanceId && r.seq === shown.seq) : -1;
  return { index: index + 1, count: queue.length };
}

// The brief ‹ (-1) or › (+1) moves to, or null at either end of the queue. From a
// brief that isn't waiting, › goes to the head and ‹ nowhere.
export function stepBrief(shown: BriefRef | null, briefs: BriefMap, delta: 1 | -1): BriefRef | null {
  const queue = briefQueue(briefs);
  const at = shown && sameBrief(shown, briefs)
    ? queue.findIndex((r) => r.instanceId === shown.instanceId && r.seq === shown.seq)
    : -1;
  if (at < 0) return delta === 1 ? (queue[0] ?? null) : null;
  return queue[at + delta] ?? null;
}
