import { describe, expect, it } from "vitest";
import { briefQueue, isWaiting, latestBrief, queuePlace, shownBrief, stepBrief } from "./secretaryQueue";
import type { BriefMap } from "./secretaryQueue";
import type { SecretaryBriefState } from "./types";

const ready = (
  seq: number,
  kind: SecretaryBriefState["kind"],
  at: number,
  marks: { handled?: true; seen?: true } = {}
): SecretaryBriefState => ({
  seq,
  kind,
  at,
  status: "ready",
  text: "Shop 做完了。",
  language: "Chinese",
  audio: "ready",
  ...marks,
});

describe("isWaiting", () => {
  it("waits until handled, and a Finished until seen too", () => {
    expect(isWaiting(ready(1, "finished", 1))).toBe(true);
    expect(isWaiting(ready(1, "finished", 1, { seen: true }))).toBe(false);
    expect(isWaiting(ready(1, "finished", 1, { handled: true }))).toBe(false);
    expect(isWaiting(ready(1, "needs-you", 1))).toBe(true);
    expect(isWaiting(ready(1, "needs-you", 1, { seen: true }))).toBe(true);
    expect(isWaiting(ready(1, "needs-you", 1, { handled: true }))).toBe(false);
  });

  it("counts a brief still being written", () => {
    expect(isWaiting({ seq: 1, kind: "finished", at: 1, status: "preparing" })).toBe(true);
  });
});

describe("briefQueue", () => {
  it("takes Needs you first, then Finished, the oldest first within each", () => {
    const briefs: BriefMap = {
      shop: ready(10, "finished", 100),
      billing: ready(11, "needs-you", 300),
      docs: ready(12, "needs-you", 200),
      site: ready(13, "finished", 50),
      done: ready(14, "needs-you", 10, { handled: true }),
      read: ready(15, "finished", 10, { seen: true }),
    };
    expect(briefQueue(briefs).map((r) => r.instanceId)).toEqual(["docs", "billing", "site", "shop"]);
  });

  it("breaks a tie in time by instance id", () => {
    const briefs: BriefMap = { b: ready(2, "finished", 5), a: ready(1, "finished", 5) };
    expect(briefQueue(briefs)).toEqual([
      { instanceId: "a", seq: 1 },
      { instanceId: "b", seq: 2 },
    ]);
  });
});

describe("latestBrief", () => {
  it("is the newest by event time, dealt with or not", () => {
    expect(latestBrief({})).toBeNull();
    const briefs: BriefMap = {
      shop: ready(1, "finished", 100, { seen: true }),
      billing: ready(2, "needs-you", 50, { handled: true }),
    };
    expect(latestBrief(briefs)).toEqual({ instanceId: "shop", seq: 1 });
  });
});

describe("shownBrief", () => {
  const briefs: BriefMap = {
    shop: ready(1, "finished", 100),
    billing: ready(2, "needs-you", 200),
  };

  it("starts at the head of the queue", () => {
    expect(shownBrief(null, briefs)).toEqual({ instanceId: "billing", seq: 2 });
  });

  it("keeps the shown brief while it waits, even when a more urgent one arrives", () => {
    const current = { instanceId: "shop", seq: 1 };
    const later: BriefMap = { ...briefs, docs: ready(3, "needs-you", 300) };
    expect(shownBrief(current, later)).toEqual(current);
  });

  it("moves on to the head when the shown brief is dealt with", () => {
    const current = { instanceId: "billing", seq: 2 };
    const answered: BriefMap = { ...briefs, billing: ready(2, "needs-you", 200, { handled: true }) };
    expect(shownBrief(current, answered)).toEqual({ instanceId: "shop", seq: 1 });
  });

  it("holds a dealt-with brief while the builder is busy with it", () => {
    const current = { instanceId: "billing", seq: 2 };
    const answered: BriefMap = { ...briefs, billing: ready(2, "needs-you", 200, { handled: true }) };
    expect(shownBrief(current, answered, true)).toEqual(current);
  });

  it("stays on the session when its brief is replaced by a newer waiting one", () => {
    const current = { instanceId: "shop", seq: 1 };
    const replaced: BriefMap = { ...briefs, shop: ready(5, "finished", 500) };
    expect(shownBrief(current, replaced)).toEqual({ instanceId: "shop", seq: 5 });
    expect(shownBrief(current, replaced, true)).toEqual({ instanceId: "shop", seq: 5 });
  });

  it("falls back to the latest brief when nothing waits, and to nothing with no briefs", () => {
    const quiet: BriefMap = {
      shop: ready(1, "finished", 100, { seen: true }),
      billing: ready(2, "needs-you", 200, { handled: true }),
    };
    expect(shownBrief(null, quiet)).toEqual({ instanceId: "billing", seq: 2 });
    expect(shownBrief({ instanceId: "gone", seq: 9 }, {})).toBeNull();
  });

  it("takes a new waiting brief over the latest one shown while nothing waited", () => {
    const quiet: BriefMap = { shop: ready(1, "finished", 100, { seen: true }) };
    const current = shownBrief(null, quiet);
    const fresh: BriefMap = { ...quiet, billing: ready(2, "needs-you", 200) };
    expect(shownBrief(current, fresh)).toEqual({ instanceId: "billing", seq: 2 });
  });
});

describe("queuePlace and stepBrief", () => {
  const briefs: BriefMap = {
    a: ready(1, "needs-you", 1),
    b: ready(2, "finished", 2),
    c: ready(3, "finished", 3),
    z: ready(4, "finished", 0, { seen: true }),
  };

  it("counts the shown brief's place from 1, and 0 when it isn't waiting", () => {
    expect(queuePlace({ instanceId: "b", seq: 2 }, briefs)).toEqual({ index: 2, count: 3 });
    expect(queuePlace({ instanceId: "z", seq: 4 }, briefs)).toEqual({ index: 0, count: 3 });
    expect(queuePlace(null, {})).toEqual({ index: 0, count: 0 });
  });

  it("steps through the queue and stops at either end", () => {
    expect(stepBrief({ instanceId: "a", seq: 1 }, briefs, 1)).toEqual({ instanceId: "b", seq: 2 });
    expect(stepBrief({ instanceId: "b", seq: 2 }, briefs, -1)).toEqual({ instanceId: "a", seq: 1 });
    expect(stepBrief({ instanceId: "c", seq: 3 }, briefs, 1)).toBeNull();
    expect(stepBrief({ instanceId: "a", seq: 1 }, briefs, -1)).toBeNull();
  });

  it("goes to the head with › from a brief that isn't waiting", () => {
    expect(stepBrief({ instanceId: "z", seq: 4 }, briefs, 1)).toEqual({ instanceId: "a", seq: 1 });
    expect(stepBrief({ instanceId: "z", seq: 4 }, briefs, -1)).toBeNull();
    expect(stepBrief(null, briefs, 1)).toEqual({ instanceId: "a", seq: 1 });
  });
});
