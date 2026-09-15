// How process-manager decides which session id a *read* should use.
//
// A stopped instance has no live session id — contacts.json doesn't store one — so
// reads fall back to whatever the directory last worked on, found on disk. The
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
  transcriptReads: string[];
} = {
  latestByCwd: new Map(),
  lookups: 0,
  discoverCalls: [],
  transcriptReads: [],
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
    broadcastActivity: () => {},
    broadcastExit: () => {},
    broadcastInstances: () => {},
    broadcastOutput: () => {},
    clearActivity: () => {},
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
    createCompletionDetector: () => ({ stop: () => {} }),
    readTranscript: (sessionId: string) => {
      disk.transcriptReads.push(sessionId);
      return [{ kind: "assistant", text: `transcript of ${sessionId}` }];
    },
    readContextUsage: (sessionId: string) => ({
      inputTokens: sessionId === "ses-disk" ? 4242 : 100,
      updatedAt: 1000,
    }),
    findLatestSessionId: (cwd: string) => {
      disk.lookups++;
      return disk.latestByCwd.get(cwd) ?? null;
    },
    keystrokeForChoice: () => null,
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
  disk.transcriptReads = [];
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
  return info.id;
}

describe("reading a stopped instance", () => {
  it("reads the transcript the directory last worked on", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    const id = stoppedInstance();

    expect(manager.readTranscript(id, 10)).toEqual([
      { kind: "assistant", text: "transcript of ses-disk" },
    ]);
    expect(disk.transcriptReads).toEqual(["ses-disk"]);
  });

  it("reports having a readable transcript", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    expect(manager.hasReadableTranscript(stoppedInstance())).toBe(true);
  });

  it("reports none for a directory with no history", () => {
    const id = stoppedInstance("/Users/x/code/fresh");
    expect(manager.hasReadableTranscript(id)).toBe(false);
    expect(manager.readTranscript(id, 10)).toEqual([]);
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
    expect(manager.readTranscript(stopped, 5)).toHaveLength(1);

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
    manager.readTranscript(id, 5);
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
    manager.readTranscript(id, 5);
    manager.readTranscript(id, 5);
    manager.readTranscript(id, 5);
    expect(disk.lookups).toBe(1);
  });

  // Including the negative result: a fresh directory would otherwise be rescanned
  // on every list call, and listInstances runs on every phone broadcast.
  it("caches a directory with no history too", () => {
    const id = stoppedInstance("/Users/x/code/fresh");
    manager.hasReadableTranscript(id);
    manager.hasReadableTranscript(id);
    expect(disk.lookups).toBe(1);
  });

  it("prefers a live session id over the disk, without looking", () => {
    disk.latestByCwd.set(CWD, "ses-disk");
    manager.createInstance(CWD, "live");
    disk.discoverCalls.at(-1)!.onFound("ses-live");
    const id = manager.listInstances().find((i) => i.name === "live")!.id;

    disk.lookups = 0;
    manager.readTranscript(id, 5);
    expect(disk.transcriptReads.at(-1)).toBe("ses-live");
    expect(disk.lookups).toBe(0);
  });
});
