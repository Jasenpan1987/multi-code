// The offline cache: what it keeps of a session, how much, and what it gives up
// when localStorage is full.

import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../shared/remote-protocol";
import { loadCache, saveCache } from "./cache";
import { EMPTY_SESSION, initialState, type AppState, type Session } from "./state";
import { MemoryStorage } from "./test-storage";

const entries = (n: number): TranscriptEntry[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "assistant", text: `entry ${i}` }));

function stateWith(sessions: Record<string, Partial<Session>>): AppState {
  return {
    ...initialState(null),
    instances: [],
    instancesAt: 5,
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, s]) => [id, { ...EMPTY_SESSION, ...s }])),
  };
}

describe("offline cache", () => {
  it("keeps the end of a long transcript and says there is more", () => {
    const storage = new MemoryStorage();
    saveCache(storage, stateWith({ a: { transcript: entries(400), refreshedAt: 1 } }), 9);
    const loaded = loadCache(storage)!;
    expect(loaded.lastSeenAt).toBe(9);
    expect(loaded.instancesAt).toBe(5);
    const a = loaded.sessions.a;
    expect(a.transcript).toHaveLength(300);
    expect(a.transcript![0].text).toBe("entry 100");
    expect(a.hasEarlier).toBe(true);
    // What isn't cached comes back as the empty session's.
    expect(a.turns).toBe(EMPTY_SESSION.turns);
    expect(a.terminal).toBeNull();
  });

  it("keeps the eight sessions refreshed last, and none with nothing to show", () => {
    const storage = new MemoryStorage();
    const sessions: Record<string, Partial<Session>> = { blank: { refreshedAt: 100 } };
    for (let i = 0; i < 10; i++) sessions[`s${i}`] = { transcript: entries(1), refreshedAt: i };
    saveCache(storage, stateWith(sessions), null);
    expect(Object.keys(loadCache(storage)!.sessions).sort()).toEqual(["s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
  });

  it("gives up sessions, oldest first, until it fits, and the list last", () => {
    const storage = new MemoryStorage();
    const state = stateWith({
      old: { transcript: entries(300), refreshedAt: 1 },
      recent: { transcript: entries(300), refreshedAt: 2 },
    });
    saveCache(storage, state, null);
    storage.quota = storage.used() - 10;
    saveCache(storage, state, null);
    expect(Object.keys(loadCache(storage)!.sessions)).toEqual(["recent"]);
    storage.quota = 200;
    saveCache(storage, state, null);
    expect(loadCache(storage)!.sessions).toEqual({});
    expect(loadCache(storage)!.instances).toEqual([]);
  });

  it("stays under its size cap, leaving room for the outbox", () => {
    const storage = new MemoryStorage();
    const long = (n: number): TranscriptEntry[] =>
      Array.from({ length: n }, (_, i) => ({ kind: "assistant", text: `${i} ${"x".repeat(2000)}` }));
    const state = stateWith({
      a: { transcript: long(300), refreshedAt: 3 },
      b: { transcript: long(300), refreshedAt: 2 },
      c: { transcript: long(300), refreshedAt: 1 },
    });
    saveCache(storage, state, null);
    expect(storage.used()).toBeLessThan(1_000_000);
    expect(Object.keys(loadCache(storage)!.sessions)).toEqual(["a"]);
  });

  it("ignores a cache it can't read", () => {
    const storage = new MemoryStorage();
    storage.setItem("multicode.cache", "{");
    expect(loadCache(storage)).toBeNull();
    storage.setItem("multicode.cache", JSON.stringify({ v: 99 }));
    expect(loadCache(storage)).toBeNull();
  });
});
