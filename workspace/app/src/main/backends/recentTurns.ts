// How `Backend.readRecentTurns` cuts a session's end into the phone's turns, the same
// way for every backend. Each backend reads only as far back as it needs and hands its
// entries here, oldest first.

import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { RecentTurns } from "./types";

// The most entries one read returns. A phone renders every entry it is sent, and one
// turn of a long agent run reaches hundreds of tool calls; past this the oldest turns
// go first, and a newest turn longer than the cap keeps only its end.
export const RECENT_TURNS_ENTRY_CAP = 600;

// What a session that can't be read has. A fresh object each time: the caller owns it.
export function noTurns(): RecentTurns {
  return { entries: [], hasEarlier: false };
}

/**
 * The last `turns` turns of `entries`. A turn starts at each "user" entry; whatever
 * comes before the first one (a session that began with something the builder didn't
 * type) counts as a turn of its own. `earlier`: the reader stopped before the session's
 * start, so there is more before `entries` whatever they hold.
 */
export function lastTurns(entries: TranscriptEntry[], turns: number, earlier: boolean): RecentTurns {
  let start = 0;
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user" && ++seen === turns) {
      start = i;
      break;
    }
  }
  // Whole turns from the oldest, then the newest turn's own start.
  while (entries.length - start > RECENT_TURNS_ENTRY_CAP) {
    let next = start + 1;
    while (next < entries.length && entries[next].kind !== "user") next++;
    start = next < entries.length ? next : entries.length - RECENT_TURNS_ENTRY_CAP;
  }
  return {
    entries: start > 0 ? entries.slice(start) : entries,
    hasEarlier: earlier || start > 0,
  };
}

// The lines of a file's whole text, for a write that created it: "a\nb\n" is two.
export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
