// How a session's end is cut into the phone's turns, for every backend: by "user"
// entries, newest first, capped by dropping the oldest turns.

import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import { RECENT_TURNS_ENTRY_CAP, lastTurns, lineCount } from "./recentTurns";

const user = (text: string): TranscriptEntry => ({ kind: "user", text });
const said = (text: string): TranscriptEntry => ({ kind: "assistant", text });
const tools = (prefix: string, count: number): TranscriptEntry[] =>
  Array.from({ length: count }, (_, i) => ({ kind: "tool", tool: "Read", text: `${prefix}${i}` }));
const texts = (entries: TranscriptEntry[]) => entries.map((entry) => entry.text);

describe("lastTurns", () => {
  const session = [said("hello"), user("a"), said("1"), user("b"), said("2"), user("c"), said("3")];

  it("takes the last turns, each from its user entry", () => {
    expect(lastTurns(session, 1, false)).toEqual({ entries: [user("c"), said("3")], hasEarlier: true });
    expect(texts(lastTurns(session, 2, false).entries)).toEqual(["b", "2", "c", "3"]);
  });

  it("counts what comes before the first user entry as a turn of its own", () => {
    expect(lastTurns(session, 3, false)).toEqual({ entries: session.slice(1), hasEarlier: true });
    expect(lastTurns(session, 4, false)).toEqual({ entries: session, hasEarlier: false });
  });

  it("says there is more when the reader stopped before the session's start", () => {
    expect(lastTurns(session, 10, true)).toEqual({ entries: session, hasEarlier: true });
  });

  it("drops whole turns from the oldest to keep under the cap", () => {
    const entries = [user("a"), ...tools("a", 300), user("b"), ...tools("b", 300), user("c"), ...tools("c", 200)];
    const capped = lastTurns(entries, 10, false);
    expect(capped.hasEarlier).toBe(true);
    expect(capped.entries).toHaveLength(502);
    expect(capped.entries[0]).toEqual(user("b"));
  });

  it("keeps the end of a newest turn longer than the cap", () => {
    const entries = [user("a"), ...tools("a", RECENT_TURNS_ENTRY_CAP + 10)];
    const capped = lastTurns(entries, 10, false);
    expect(capped.hasEarlier).toBe(true);
    expect(capped.entries).toHaveLength(RECENT_TURNS_ENTRY_CAP);
    expect(capped.entries.at(-1)?.text).toBe(`a${RECENT_TURNS_ENTRY_CAP + 9}`);
  });

  it("keeps a session of exactly the cap whole", () => {
    const entries = [user("a"), ...tools("a", RECENT_TURNS_ENTRY_CAP - 1)];
    expect(lastTurns(entries, 10, false)).toEqual({ entries, hasEarlier: false });
  });

  it("is empty for an empty session", () => {
    expect(lastTurns([], 10, false)).toEqual({ entries: [], hasEarlier: false });
  });

  // A command the CLI ran itself, and its output (TranscriptEntry.local).
  const ran = (text: string): TranscriptEntry => ({ kind: "user", text, local: true });
  const output = (text: string): TranscriptEntry => ({ kind: "assistant", text, local: true });

  it("starts no turn at a local command: it stays in the turn it came after", () => {
    const entries = [user("a"), said("1"), ran("/model"), output("Kept"), user("b"), said("2"), ran("/token"), output("Unknown")];
    expect(texts(lastTurns(entries, 1, false).entries)).toEqual(["b", "2", "/token", "Unknown"]);
    expect(texts(lastTurns(entries, 2, false).entries)).toEqual(texts(entries));
    expect(lastTurns(entries, 2, false).hasEarlier).toBe(false);
  });

  it("shows local commands before the first turn with it, not as an earlier turn", () => {
    const entries = [ran("/clear"), user("a"), said("1")];
    expect(lastTurns(entries, 1, false)).toEqual({ entries, hasEarlier: false });
    // Anything else before it is still a turn of its own.
    const told = [said("hello"), ran("/clear"), user("a"), said("1")];
    expect(lastTurns(told, 1, false)).toEqual({ entries: told.slice(2), hasEarlier: true });
  });

  it("shows a session of nothing but local commands whole", () => {
    const entries = [ran("/clear"), ran("/token"), output("Unknown command: /token")];
    expect(lastTurns(entries, 1, false)).toEqual({ entries, hasEarlier: false });
  });

  it("drops whole turns under the cap without stopping at a local command", () => {
    const entries = [user("a"), ...tools("a", 300), ran("/model"), ...tools("m", 250), user("b"), ...tools("b", 300)];
    const capped = lastTurns(entries, 10, false);
    expect(capped.entries[0]).toEqual(user("b"));
    expect(capped.entries).toHaveLength(301);
  });
});

describe("lineCount", () => {
  it("counts lines with or without a final newline", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("\n")).toBe(1);
  });
});
