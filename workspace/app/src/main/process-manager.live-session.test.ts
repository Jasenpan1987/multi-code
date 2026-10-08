// Following a running instance to a new session.
//
// The reported symptom was small: after `/new`, the context percentage in the
// contact list froze and never moved again. The cause was that an instance's
// session id was fixed once at discovery and never revisited, while `/new` and
// `/clear` move the CLI to a fresh transcript and stop writing to the old one
// (measured 2026-09-17 — the old file did not gain a single byte afterwards).
//
// The frozen number is the least of it. The same id is what a paired phone's
// transcript and the manager's read_session read, so both were showing a file
// nobody would ever write to again.
//
// Mocked down to a fake pty for the same reason as the write-gate file: what is
// being tested is the wiring, and a host interface is the thing that could lie.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let userData = "";

// What the backend currently reports as the live session, and what each call was
// asked about. Held on an object so TypeScript doesn't narrow the fields to the
// value they are initialised with — the writes happen inside the module mock.
const backendState: {
  liveSessionId: string | null;
  liveCalls: { cwd: string; pid: number }[];
  // Every `instance-session-id` the renderer was sent, as [instance, session].
  sessionIdSends: [string, string][];
} = {
  liveSessionId: null,
  liveCalls: [],
  sessionIdSends: [],
};

const cb: { sessionFound: ((sessionId: string) => void) | null } = {
  sessionFound: null,
};

vi.mock("node-pty", () => ({
  spawn: () => {
    // The exit callback has to be held and fired on kill, or the manager never
    // learns the process is gone and `stopped` can't be tested at all.
    let onExitCb: ((e: { exitCode: number }) => void) | null = null;
    return {
      write: () => {},
      onData: () => {},
      onExit: (fn: (e: { exitCode: number }) => void) => {
        onExitCb = fn;
      },
      resize: () => {},
      kill: () => onExitCb?.({ exitCode: 0 }),
      pid: 60891,
    };
  },
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

vi.mock("./shell-manager", () => ({
  shellManager: { kill: () => {} },
}));

vi.mock("./store", () => ({
  loadContacts: () => [],
  saveContacts: () => {},
}));

vi.mock("./backends", () => ({
  getBackend: () => ({
    name: "claude",
    spawn: () => ({ command: "claude", args: [], env: {} }),
    discoverSessionId: (_cwd: string, onFound: (id: string) => void) => {
      cb.sessionFound = onFound;
      return { cancel: () => {} };
    },
    createHookAttention: () => ({ handle: () => {}, stop: () => {} }),
    findLiveSessionId: (cwd: string, pid: number) => {
      backendState.liveCalls.push({ cwd, pid });
      return backendState.liveSessionId;
    },
    findLatestSessionId: () => null,
    readTranscript: () => [],
    readContextUsage: (sessionId: string) => ({
      inputTokens: sessionId === "ses-1" ? 300_000 : 12_000,
      updatedAt: Date.now(),
    }),
    keystrokeForChoice: () => null,
    buildResumeCommand: () => "claude --resume x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

let manager: InstanceType<typeof ProcessManager>;
let instanceId = "";

// The window is what starts the polling, so it has to be set for any of this to
// run. Only the two members process-manager touches are provided.
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, id: string, sessionId: string) => {
      if (channel === "instance-session-id") backendState.sessionIdSends.push([id, sessionId]);
    },
  },
} as unknown as Parameters<InstanceType<typeof ProcessManager>["setMainWindow"]>[0];

beforeEach(() => {
  vi.useFakeTimers();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-live-"));
  backendState.liveSessionId = null;
  backendState.liveCalls = [];
  backendState.sessionIdSends = [];
  cb.sessionFound = null;
  manager = new ProcessManager();
  manager.setMainWindow(fakeWindow);
  instanceId = manager.createInstance("/Users/x/code/msk", "msk").id;
  discover("ses-1");
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(userData, { recursive: true, force: true });
});

function discover(sessionId: string) {
  cb.sessionFound?.(sessionId);
}

function poll(times = 1) {
  // One tick of the live-session poll. 4000ms is the shipped interval.
  vi.advanceTimersByTime(4000 * times);
}

function sendsFor(id: string): string[] {
  return backendState.sessionIdSends.filter(([i]) => i === id).map(([, s]) => s);
}

function sessionIdOf(): string | undefined {
  return manager.listInstances().find((i) => i.id === instanceId)?.sessionId;
}

describe("following a session change", () => {
  it("adopts the session the process moved to", () => {
    expect(sessionIdOf()).toBe("ses-1");
    backendState.liveSessionId = "ses-2";
    poll();
    expect(sessionIdOf()).toBe("ses-2");
  });

  it("tells the renderer about the new session", () => {
    backendState.liveSessionId = "ses-2";
    poll();
    expect(sendsFor(instanceId)).toEqual(["ses-1", "ses-2"]);
  });

  it("does not re-announce a session that is unchanged", () => {
    backendState.liveSessionId = "ses-1";
    poll(5);
    expect(sendsFor(instanceId)).toEqual(["ses-1"]);
  });

  it("does nothing when the backend cannot tell", () => {
    backendState.liveSessionId = null;
    poll(3);
    expect(sessionIdOf()).toBe("ses-1");
    expect(sendsFor(instanceId)).toEqual(["ses-1"]);
  });

  it("asks about the pty's own pid and cwd", () => {
    // The registry is keyed on the pid, and the cwd is what stops a recycled pid
    // from pointing at an unrelated session.
    poll();
    expect(backendState.liveCalls[0]).toEqual({
      cwd: "/Users/x/code/msk",
      pid: 60891,
    });
  });

  it("drops the previous session's context figure rather than showing it", () => {
    // What the user actually saw: the old session's number, still on screen after
    // /new had reset usage to zero.
    manager.listInstances();
    const before = manager
      .listInstances()
      .find((i) => i.id === instanceId)?.contextUsage;
    expect(before?.inputTokens).toBe(300_000);

    backendState.liveSessionId = "ses-2";
    poll();

    const after = manager
      .listInstances()
      .find((i) => i.id === instanceId)?.contextUsage;
    expect(after?.inputTokens).toBe(12_000);
  });
});

describe("not stealing another instance's session", () => {
  it("leaves a session alone when another instance already holds it", () => {
    // Two contacts on one repo is a shape this user has. Both reading one
    // transcript would have them both report its turns.
    const second = manager.createInstance("/Users/x/code/msk", "msk-twin");
    discover("ses-2");
    expect(
      manager.listInstances().find((i) => i.id === second.id)?.sessionId
    ).toBe("ses-2");

    backendState.liveSessionId = "ses-2";
    poll();

    expect(sessionIdOf()).toBe("ses-1");
    expect(sendsFor(instanceId)).toEqual(["ses-1"]);
  });
});

describe("a stopped instance", () => {
  it("is not followed, having no live process to follow", () => {
    manager.killInstance(instanceId);
    backendState.liveCalls = [];
    backendState.liveSessionId = "ses-2";
    poll(2);
    expect(backendState.liveCalls).toEqual([]);
    expect(sessionIdOf()).toBe("ses-1");
  });
});

describe("what the secretary's brief writer reads", () => {
  it("gets the session the process is on now, without waiting for the poll", () => {
    // A turn can end within one poll of a /clear; the brief must be read from the
    // new transcript, not the one the CLI stopped writing to.
    backendState.liveSessionId = "ses-2";
    expect(manager.secretarySource(instanceId)).toEqual({
      name: "msk",
      backend: "claude",
      sessionId: "ses-2",
    });
    expect(sessionIdOf()).toBe("ses-2");
  });

  it("names an instance without an alias after its directory", () => {
    const bare = manager.createInstance("/Users/x/code/eat-what");
    expect(manager.secretarySource(bare.id)?.name).toBe("eat-what");
  });

  it("is null for an id that isn't an instance", () => {
    expect(manager.secretarySource("nope")).toBeNull();
  });
});
