// Drafts survive a relaunch: each one written to storage and read back by a new load.

import { describe, expect, it } from "vitest";
import { loadDraft, saveDraft } from "./drafts";
import { MemoryStorage } from "./test-storage";

const now = 1_800_000_000_000;

describe("drafts", () => {
  it("keeps each session's draft across launches", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, "multi-code", "先别 apply，", now);
    saveDraft(storage, "data-pipeline", "保留 30 天", now);
    // A later launch reads the same storage.
    expect(loadDraft(storage, "multi-code", now + 3600_000)).toBe("先别 apply，");
    expect(loadDraft(storage, "data-pipeline", now + 3600_000)).toBe("保留 30 天");
    expect(loadDraft(storage, "apra-portal", now)).toBe("");
  });

  it("forgets a draft once it is empty (sent), and the key with the last one", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, "multi-code", "hello", now);
    saveDraft(storage, "multi-code", "", now);
    expect(loadDraft(storage, "multi-code", now)).toBe("");
    expect(storage.length).toBe(0);
  });

  it("stays small: the newest drafts, none older than a month, each kept whole", () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 25; i++) saveDraft(storage, `s${i}`, `draft ${i}`, now + i);
    expect(loadDraft(storage, "s0", now + 100)).toBe("");
    expect(loadDraft(storage, "s5", now + 100)).toBe("draft 5");
    expect(loadDraft(storage, "s24", now + 100)).toBe("draft 24");

    saveDraft(storage, "long", "x".repeat(50_000), now + 100);
    expect(loadDraft(storage, "long", now + 100)).toHaveLength(50_000);

    expect(loadDraft(storage, "s24", now + 31 * 24 * 3600_000)).toBe("");
  });

  it("survives a full storage and a broken entry", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, "multi-code", "kept", now);
    storage.quota = storage.used();
    saveDraft(storage, "multi-code", "kept, and much more than fits", now);
    expect(loadDraft(storage, "multi-code", now)).toBe("kept");

    storage.quota = Infinity;
    storage.setItem("multicode.drafts", "{not json");
    expect(loadDraft(storage, "multi-code", now)).toBe("");
    saveDraft(storage, "multi-code", "again", now);
    expect(loadDraft(storage, "multi-code", now)).toBe("again");
  });
});
