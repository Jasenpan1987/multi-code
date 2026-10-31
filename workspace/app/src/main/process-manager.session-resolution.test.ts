// How process-manager decides which session id a *read* should use.
//
// A stopped instance has no live session id, and a contact saved before
// contacts.json kept its own has none on record either, so reads fall back to
// whatever the directory last worked on, found on disk. The
// hazard that shapes the design: `spawnProcess`'s `isSessionClaimed` treats any
// instance holding a session id as that session's owner, so if the disk-resolved id
// were merged into `sessionId`, a stopped contact would veto discovery for a
// *running* instance in the same directory. This user has exactly that shape — two
// contacts on one repo — so the separation is load-bearing, not tidiness.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let userData = "";

// What the fake backend reports for a directory, plus a call counter so caching is
// observable.
const disk: {
  latestByCwd: Map<string, string>;
  lookups: number;
  discoverCalls: Array<{ cwd: string; onFound: (id: string) => void; isClaimed?: (id: string) => boolean }>;
  turnReads: Array<{ sessionId: string; turns: number }>;
} = {
  latestByCwd: new Map(),
  lookups: 0,
  discoverCalls: [],
  turnReads: [],
};

vi.mock("node-pty", () => ({
  spawn: () => ({
    write: () => {},
    onData: () => {},
    onExit: () => {},
    resize: () => {},
    kill: () => {},
    pid: 1234,
  }),
}));

vi.mock("electron", () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("./remote/ws-server", () => ({
  remoteServer: {
    broadcastExit: () => {},
    broadcastInstances: () => {},
    broadcastOutput: () => {},
  },
}));

vi.mock("./shell-manager", () => ({ shellManager: { kill: () => {} } }));

// store.ts resolves its path at import time, when the mocked userData is still "" —
// the real one would write contacts.json into the repo.
vi.mock("./store", () => ({
  loadContacts: () => [],
  saveContacts: () => {},
}));

vi.mock("./backends", () => ({
  getBackend: () => ({
    name: "claude",
    spawn: () => ({ command: "claude", args: [], env: {} }),
    discoverSessionId: (
      cwd: string,
      onFound: (id: string) => void,
      isClaimed?: (id: string) => boolean
    ) => {
      disk.discoverCalls.push({ cwd, onFound, isClaimed });
      return { cancel: () => {} };
    },
    createHookAttention: () => ({ handle: () => {}, stop: () => {} }),
    readRecentTurns: (sessionId: string, turns: number) => {
      if (sessionId === "ses-broken") throw new Error("unreadable");
      disk.turnReads.push({ sessionId, turns });
      return { entries: [{ kind: "user", text: `turns of ${sessionId}` }], hasEarlier: true };
    },
    readContextUsage: (sessionId: string) => ({
      inputTokens: sessionId === "ses-disk" ? 4242 : 100,
      updatedAt: 1000,
    }),
    findLatestSessionId: (cwd: string) => {
      disk.lookups++;
      return disk.latestByCwd.get(cwd) ?? null;
    },
    buildResumeCommand: () => "claude --resume x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

let manager: InstanceType<typeof ProcessManager>;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-resolve-"));
  disk.latestByCwd = new Map();
  disk.lookups = 0;
  disk.discoverCalls = [];
  disk.turnReads = [];
  manager = new ProcessManager();
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const CWD = "/Users/x/code/msk";

/** An instance in the state a stopped contact has after an app restart. */
function stoppedInstance(cwd = CWD) {
  const info = manager.createInstance(cwd, undefined);
  manager.killInstance(info.id);
  // The spawn looked once to pick the session it opens. Not a read.
  disk.lookups = 0;
  return info.id;
}

describe("reading a stopped instance", () => {
  it("reads the last turns of the session the directory last worked on, and says which", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    const id = stoppedInstance();
    expect(manager.readRecentTurns(id, 10)).toEqual({
      entries: [{ kind: "user", text: "turns of ses-disk" }],
      hasEarlier: true,
      session: "ses-disk",
    });
    expect(disk.turnReads).toEqual([{ sessionId: "ses-disk", turns: 10 }]);
  });

  it("reads at least one turn, whatever number the phone sent", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    const id = stoppedInstance();
    for (const turns of [0, -3, Number.NaN, 2.7]) manager.readRecentTurns(id, turns);
    expect(disk.turnReads.map((read) => read.turns)).toEqual([1, 1, 1, 2]);
  });

  it("has no turns for an unknown instance, a directory with no history or a failed read", () => {
    expect(manager.readRecentTurns("nope", 10)).toEqual({ entries: [], hasEarlier: false });
    expect(manager.readRecentTurns(stoppedInstance("/Users/x/code/fresh"), 10)).toEqual({
      entries: [],
      hasEarlier: false,
    });
    disk.latestByCwd.set("/Users/x/code/broken", "ses-broken");
    expect(manager.readRecentTurns(stoppedInstance("/Users/x/code/broken"), 10)).toEqual({
      entries: [],
      hasEarlier: false,
      session: "ses-broken",
    });
  });

  // The other half of what a stopped contact was missing: the contact list showed
  // `context=unknown` for everything until the user started it.
  it("has context usage without being started", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    const id = stoppedInstance();
    const info = manager.listInstances().find((i) => i.id === id);
    expect(info?.contextUsage?.inputTokens).toBe(4242);
  });
});

describe("the disk-resolved id stays out of discovery", () => {
  // The regression this whole design exists for.
  it("does not veto a running instance in the same directory", () => {
    disk.latestByCwd.set(CWD, "shared-session");
    const stopped = stoppedInstance();
    // Force the resolution to happen, the way a list call or a read would.
    expect(manager.readRecentTurns(stopped, 5).session).toBe("shared-session");

    // Now a second contact in the same directory starts up and discovers that very
    // session. Its claim check must not see the stopped contact's resolved id.
    const running = manager.createInstance(CWD, "second");
    const discovery = disk.discoverCalls.at(-1)!;
    expect(discovery.isClaimed?.("shared-session")).toBe(false);

    discovery.onFound("shared-session");
    const info = manager.listInstances().find((i) => i.id === running.id);
    expect(info?.sessionId).toBe("shared-session");
  });

  it("never surfaces the resolved id as the instance's sessionId", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    const id = stoppedInstance();
    manager.readRecentTurns(id, 5);
    expect(manager.listInstances().find((i) => i.id === id)?.sessionId).toBe(
      undefined
    );
  });

  it("still lets a genuinely claimed session be vetoed", () => {
    // Sanity check on the other direction: a live id held by another instance is
    // claimed, which is what stops two instances latching onto one session.
    manager.createInstance(CWD, "first");
    disk.discoverCalls.at(-1)!.onFound("live-session");
    manager.createInstance(CWD, "second");
    expect(disk.discoverCalls.at(-1)!.isClaimed?.("live-session")).toBe(true);
  });
});

describe("the lookup is cached", () => {
  it("does not hit the disk on every read", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    const id = stoppedInstance();
    manager.readRecentTurns(id, 5);
    manager.readRecentTurns(id, 5);
    manager.readRecentTurns(id, 5);
    expect(disk.lookups).toBe(1);
  });

  // Including the negative result: a fresh directory would otherwise be rescanned
  // on every list call, and listInstances runs on every phone broadcast.
  it("caches a directory with no history too", () => {
    const id = stoppedInstance("/Users/x/code/fresh");
    manager.readRecentTurns(id, 5);
    manager.readRecentTurns(id, 5);
    expect(disk.lookups).toBe(1);
  });

  it("prefers a live session id over the disk, without looking", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    manager.createInstance(CWD, "live");
    disk.discoverCalls.at(-1)!.onFound("ses-live");
    const id = manager.listInstances().find((i) => i.name === "live")!.id;

    disk.lookups = 0;
    manager.readRecentTurns(id, 5);
    expect(disk.turnReads.at(-1)?.sessionId).toBe("ses-live");
    expect(disk.lookups).toBe(0);
  });
});

// Drag-to-reorder. The design point under test: the main process applies a *move* to
// the order it has stored, so a renderer whose list is stale can misplace one row but
// can never rewrite the whole order.
describe("moveInstance", () => {
  function four() {
    disk.latestByCwd.set(CWD, "ses-disk");
    return ["a", "b", "c", "d"].map(
      (name) => manager.createInstance(`/Users/x/code/${name}`, name).id
    );
  }
  const order = () => manager.listInstances().map((i) => i.name);

  it("moves a row before another", () => {
    const [a] = four();
    manager.moveInstance(a, manager.listInstances()[2].id, true);
    expect(order()).toEqual(["b", "a", "c", "d"]);
  });

  it("moves a row after another", () => {
    const [a] = four();
    manager.moveInstance(a, manager.listInstances()[2].id, false);
    expect(order()).toEqual(["b", "c", "a", "d"]);
  });

  it("moves upward", () => {
    const ids = four();
    manager.moveInstance(ids[3], ids[0], true);
    expect(order()).toEqual(["d", "a", "b", "c"]);
  });

  it("keeps every instance and its state", () => {
    const ids = four();
    manager.moveInstance(ids[0], ids[3], false);
    expect(manager.listInstances()).toHaveLength(4);
    // The same live objects, not rebuilt copies — a reorder must not restart anything
    // or drop a session id.
    expect(manager.listInstances().every((i) => i.status === "running")).toBe(true);
  });

  it("is a no-op when the move changes nothing", () => {
    const ids = four();
    const before = order();
    manager.moveInstance(ids[1], ids[0], false);
    expect(order()).toEqual(before);
  });

  it("ignores an unknown id rather than dropping rows", () => {
    four();
    const before = order();
    manager.moveInstance("nope", manager.listInstances()[0].id, true);
    expect(order()).toEqual(before);
    expect(manager.listInstances()).toHaveLength(4);
  });

  // The reason this takes a move and not a list. A renderer that hasn't seen a
  // just-created instance would, if it sent its own full order, silently drop that
  // instance from contacts.json.
  it("keeps an instance the caller never mentioned", () => {
    const ids = four();
    const extra = manager.createInstance("/Users/x/code/late", "late").id;
    manager.moveInstance(ids[0], ids[2], false);
    expect(order()).toContain("late");
    expect(manager.listInstances().map((i) => i.id)).toContain(extra);
  });
});
