// What the builder has typed in each session's compose box and not sent, kept in
// localStorage so it survives the app being closed (PRD Story 4). Small: the newest
// few drafts, and a draft untouched for a month is dropped. A draft is kept whole,
// never cut: what comes back after the chat was left is what was on screen.

import { useCallback, useState } from "react";

const STORAGE_KEY = "multicode.drafts";
const MAX_DRAFTS = 20;
const KEPT_MS = 30 * 24 * 3600_000;

type Drafts = Record<string, { text: string; at: number }>;

function read(storage: Storage, now: number): Drafts {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as Drafts;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, d]) => typeof d?.text === "string" && now - (d.at ?? 0) < KEPT_MS)
    );
  } catch {
    return {};
  }
}

export function loadDraft(storage: Storage, id: string, now = Date.now()): string {
  return read(storage, now)[id]?.text ?? "";
}

// An empty text forgets the session's draft. A full storage keeps the old one; the
// newest is still in `typed` (below) until the app closes.
export function saveDraft(storage: Storage, id: string, text: string, now = Date.now()) {
  const drafts = read(storage, now);
  delete drafts[id];
  if (text) drafts[id] = { text, at: now };
  const kept = Object.entries(drafts)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_DRAFTS);
  try {
    if (kept.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full.
  }
}

// This run's drafts as typed, so leaving the chat and coming back shows the draft as
// it was even when storage refused it.
const typed = new Map<string, string>();

// The draft of one session, written through on every change.
export function useDraft(id: string, storage: Storage = localStorage): [string, (text: string) => void] {
  const [text, setText] = useState(() => typed.get(id) ?? loadDraft(storage, id));
  const update = useCallback(
    (next: string) => {
      setText(next);
      typed.set(id, next);
      saveDraft(storage, id, next);
    },
    [storage, id]
  );
  return [text, update];
}
