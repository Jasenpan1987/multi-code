// The secretary card's rules (epic voice-secretary, PRD Stories 3 and 7), kept out
// of App and SecretaryCard so they are plain functions with tests.
//
// A card belongs to one brief: one contact and one event `seq`. While Secretary Mode
// is on it opens three ways: on its own when a new event arrives for the contact on
// screen (T-526); from a click on a contact that showed a red dot at that moment and
// has a live brief; or from the header's Secretary button, which brings back the
// shown contact's latest brief, live or handled (T-527). The first two play the
// brief once the voice is ready; the button doesn't. So only the shown contact ever
// speaks unasked, and two sessions never talk over each other.
//
// It stays open while that is still the shown contact's brief, handled or not: the
// builder typing in the terminal keeps it. Switching contacts, the mode going off,
// or a newer event replacing the brief close it; for the shown contact the newer
// event opens its own card.

import type {
  BriefLanguage,
  SecretaryBriefState,
  SecretaryExchange,
} from "../../shared/types";

export type BriefMap = Record<string, SecretaryBriefState>;

export interface OpenCard {
  instanceId: string;
  seq: number;
  // Play the brief once its voice is ready.
  play: boolean;
}

export interface SecretaryView {
  modeOn: boolean;
  selectedId: string | null;
  briefs: BriefMap;
}

// The card a click on `instanceId` opens, or null. `unreadIds` must be read before
// the click clears the contact's red dot. A red dot with no brief, or only a handled
// one, opens nothing: the event was already dealt with (a manager dispatch writes to
// the session, which clears it in main but leaves the dot), or the contact gets no
// secretary at all (the manager).
export function cardOnSelect(
  instanceId: string,
  modeOn: boolean,
  unreadIds: ReadonlySet<string>,
  briefs: BriefMap
): OpenCard | null {
  if (!modeOn || !unreadIds.has(instanceId)) return null;
  const brief = briefs[instanceId];
  return brief && !brief.handled ? { instanceId, seq: brief.seq, play: true } : null;
}

// The card a push from main opens on its own, or null: a new event's brief for the
// contact on screen. New means a `seq` this contact hasn't had before
// (`previousSeq`, the last one seen for it), so a later push for the same event (its
// text, its voice, a reply on its card) never reopens a card the builder closed.
// Main pushes briefs only while Secretary Mode is on.
export function cardOnArrival(
  instanceId: string,
  state: SecretaryBriefState | null,
  selectedId: string | null,
  previousSeq: number | undefined
): OpenCard | null {
  if (instanceId !== selectedId || !state || state.seq === previousSeq) return null;
  if (state.status !== "preparing" || state.handled) return null;
  return { instanceId, seq: state.seq, play: true };
}

// What the header's Secretary button opens, or null when it has nothing to show:
// the shown contact's latest brief, when no card is open over it.
export function cardToReopen(card: OpenCard | null, view: SecretaryView): OpenCard | null {
  if (!view.modeOn || !view.selectedId || openCardBrief(card, view)) return null;
  const brief = view.briefs[view.selectedId];
  return brief ? { instanceId: view.selectedId, seq: brief.seq, play: false } : null;
}

// The brief an open card shows, or null when the card should be closed.
export function openCardBrief(
  card: OpenCard | null,
  view: SecretaryView
): SecretaryBriefState | null {
  if (!card || !view.modeOn || view.selectedId !== card.instanceId) return null;
  const brief = view.briefs[card.instanceId];
  return brief && brief.seq === card.seq ? brief : null;
}

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

export type CardNoteTone = "muted" | "warn";

export interface CardNote {
  tone: CardNoteTone;
  text: string;
  // Main's reason, shown small beside the note and in full on hover.
  detail?: string;
}

export interface BriefCardView {
  kindLabel: string;
  // The brief, once it is written.
  text: string | null;
  language: BriefLanguage | null;
  note: CardNote | null;
  // The wav can be fetched for this brief's seq.
  audioReady: boolean;
  // No audio yet, but it may still come: the brief is being written, or written
  // and with the speech server.
  voiceComing: boolean;
}

export function briefCardView(state: SecretaryBriefState): BriefCardView {
  const kindLabel = state.kind === "finished" ? "Finished" : "Needs you";
  const none = { kindLabel, text: null, language: null, audioReady: false };
  switch (state.status) {
    case "preparing":
      return {
        ...none,
        note: { tone: "muted", text: "Preparing the brief…" },
        voiceComing: true,
      };
    case "failed":
      return {
        ...none,
        note: { tone: "warn", text: "No brief could be written", detail: state.reason },
        voiceComing: false,
      };
    case "ready": {
      const written = { kindLabel, text: state.text, language: state.language };
      if (state.audio === "ready") {
        return { ...written, note: null, audioReady: true, voiceComing: false };
      }
      if (state.audio === "pending") {
        return {
          ...written,
          note: { tone: "muted", text: "Voice on its way…" },
          audioReady: false,
          voiceComing: true,
        };
      }
      return {
        ...written,
        note: { tone: "warn", text: "Voice unavailable", detail: state.voiceReason },
        audioReady: false,
        voiceComing: false,
      };
    }
  }
}

// The card's reply box (T-510): on a Needs-you whose dialog the secretary can
// answer in words, until the dialog is dealt with. Gone once it is handled, by the
// secretary's own keys or anyone else's; the exchanges stay.
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
