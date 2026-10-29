// The offline cache: the last list and each opened session's last transcript and
// dialog, in localStorage, so the app opens to what the Mac last said (with its
// age) when the Mac can't be reached (PRD Story 1). The service worker (sw.ts)
// keeps the page itself; this keeps the content.

import type { RemoteInstance } from "../shared/remote-protocol";
import { EMPTY_SESSION, type AppState, type Session } from "./state";

const STORAGE_KEY = "multicode.cache";
const VERSION = 1;
// localStorage holds about 5 MB per origin on iOS; a transcript of 600 entries
// with long conclusions can be a few hundred KB. So the cache keeps the sessions
// opened most recently, and the end of each.
const MAX_SESSIONS = 8;
const MAX_ENTRIES = 300;
// And never more than this in all (UTF-16, so about 2 MB), leaving the rest of
// the origin's storage to the outbox and the pairing.
const MAX_CHARS = 1_000_000;

type CachedSession = Pick<Session, "transcript" | "hasEarlier" | "dialog" | "refreshedAt">;

interface Cached {
  v: typeof VERSION;
  instances: RemoteInstance[] | null;
  instancesAt: number | null;
  lastSeenAt: number | null;
  sessions: Record<string, CachedSession>;
}

export type CachedState = Pick<AppState, "instances" | "instancesAt" | "sessions"> & { lastSeenAt: number | null };

export function saveCache(storage: Storage, state: AppState, lastSeenAt: number | null) {
  const kept = Object.entries(state.sessions)
    .filter(([, s]) => s.transcript || s.dialog)
    .sort(([, a], [, b]) => (b.refreshedAt ?? 0) - (a.refreshedAt ?? 0))
    .slice(0, MAX_SESSIONS);
  // Storage full: drop the oldest sessions until it fits, and the list alone last.
  for (let count = kept.length; count >= 0; count = count === 0 ? -1 : Math.floor(count / 2)) {
    const cached: Cached = {
      v: VERSION,
      instances: state.instances,
      instancesAt: state.instancesAt,
      lastSeenAt,
      sessions: Object.fromEntries(kept.slice(0, count).map(([id, s]) => [id, trimSession(s)])),
    };
    const json = JSON.stringify(cached);
    if (json.length > MAX_CHARS && count > 0) continue;
    try {
      storage.setItem(STORAGE_KEY, json);
      return;
    } catch {
      // Try again with fewer sessions.
    }
  }
}

function trimSession(s: Session): CachedSession {
  const transcript = s.transcript && s.transcript.length > MAX_ENTRIES ? s.transcript.slice(-MAX_ENTRIES) : s.transcript;
  return {
    transcript,
    hasEarlier: s.hasEarlier || transcript !== s.transcript,
    dialog: s.dialog,
    refreshedAt: s.refreshedAt,
  };
}

export function loadCache(storage: Storage): CachedState | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as Cached;
    if (cached?.v !== VERSION) return null;
    const sessions: Record<string, Session> = {};
    for (const [id, s] of Object.entries(cached.sessions ?? {})) {
      sessions[id] = { ...EMPTY_SESSION, ...s };
    }
    return {
      instances: Array.isArray(cached.instances) ? cached.instances : null,
      instancesAt: cached.instancesAt ?? null,
      lastSeenAt: cached.lastSeenAt ?? null,
      sessions,
    };
  } catch {
    return null;
  }
}

export function clearCache(storage: Storage) {
  storage.removeItem(STORAGE_KEY);
}
