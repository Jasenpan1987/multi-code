// The safety regression for the measured escalation.
//
// On 2026-09-02 a PTY write to a session parked on a plan-approval dialog selected
// that dialog's highlighted default — "Yes, and use auto mode" — and the session
// went on to edit a real file. The payload was ordinary prose with no digits in it,
// so no amount of filtering the text could have prevented it. The only defence is
// refusing to write at all while the target is blocked.
//
// **Assertions here are at the pty boundary — bytes written — not at the tool's
// return value.** A refactor that bypassed the gate and then returned a polite error
// would pass a return-value test and still approve the user's dialogs. run-state.ts
// already has 18 tests on the decision; this file tests that the decision is
// actually wired to the write.
//
// Which is why process-manager gets mocked down to a fake pty rather than tested
// through the tools: everything else in the manager stack can be tested against a
// host interface, and a host interface is exactly the thing that could lie.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let userData = "";

// Every write any instance has received, in order, across all instances.
interface FakePty {
  writes: string[];
  onDataCb: ((data: string) => void) | null;
  onExitCb: ((e: { exitCode: number }) => void) | null;
}
let ptys: FakePty[] = [];

// Captured from the fake backend so a test can drive the detector the way a real
// backend would — this is how an instance is put into `blocked`. Held on an object
// rather than in two `let`s so TypeScript doesn't narrow them to `never`: it can't
// see the assignments, which happen inside the module mock.
const cb: {
  activity: ((type: string) => void) | null;
  sessionFound: ((sessionId: string) => void) | null;
} = { activity: null, sessionFound: null };

vi.mock("node-pty", () => ({
  spawn: () => {
    const p: FakePty = { writes: [], onDataCb: null, onExitCb: null };
    ptys.push(p);
    return {
      write: (data: string) => p.writes.push(data),
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb;
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb;
      },
      resize: () => {},
      kill: () => p.onExitCb?.({ exitCode: 0 }),
      pid: 4242,
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

// Mocked because store.ts computes its path at *import* time, from an
// `app.getPath("userData")` that is still "" when this file's mock is first
// consulted — so the real one writes `contacts.json` into the repo. Persistence is
// not what this file tests.
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
    createCompletionDetector: (
      _sessionId: string,
      onActivity: (type: string) => void
    ) => {
      cb.activity = onActivity;
      return { stop: () => {} };
    },
    readTranscript: () => [],
    readContextUsage: () => null,
    keystrokeForChoice: () => null,
    buildResumeCommand: () => "claude --resume x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

let manager: InstanceType<typeof ProcessManager>;
let instanceId = "";

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-gate-"));
  ptys = [];
  cb.activity = null;
  cb.sessionFound = null;
  manager = new ProcessManager();
  instanceId = manager.createInstance("/Users/x/code/msk", "msk").id;
  // Discovery has to land before a detector exists, which is what feeds run state.
  discover("ses-1");
});

// Through a function, not inline: assigning `cb.sessionFound = null` above narrows
// the property to `null` for the rest of that block, and the assignment that
// actually populates it happens inside the module mock where TypeScript can't see
// it.
function discover(sessionId: string) {
  cb.sessionFound?.(sessionId);
}

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

function pty(): FakePty {
  return ptys[0];
}

/** Put the instance on a dialog, the way the backend detector would. */
function block() {
  cb.activity?.("prompt");
}

/** Report a finished turn, the way the backend detector would. */
function goIdle() {
  cb.activity?.("waiting");
}

describe("the write gate reaches the pty", () => {
  it("is wired up at all: an idle instance receives bytes", () => {
    // The control case. Without it, every refusal assertion below would also pass
    // on a build where writing is broken entirely.
    goIdle();
    expect(manager.trySendTask(instanceId, "do the thing").ok).toBe(true);
    expect(pty().writes.join("")).toContain("do the thing");
  });

  it("send_task to a blocked instance writes ZERO bytes", () => {
    goIdle();
    block();
    const verdict = manager.trySendTask(instanceId, "do the thing");
    expect(verdict.ok).toBe(false);
    expect(pty().writes).toEqual([]);
  });

  it("run_command on a blocked instance writes ZERO bytes", () => {
    goIdle();
    block();
    const verdict = manager.tryRunCommand(instanceId, "/clear");
    expect(verdict.ok).toBe(false);
    expect(pty().writes).toEqual([]);
  });

  // The measured hazard verbatim: prose with no digits in it, aimed at a session on
  // a plan-approval dialog, which previously selected "Yes, and use auto mode".
  it("does not deliver the exact payload that caused the escalation", () => {
    goIdle();
    block();
    manager.trySendTask(
      instanceId,
      "have a look at the failing test and see what you think"
    );
    expect(pty().writes).toEqual([]);
  });

  it("names the state in the refusal so it can be relayed to the user", () => {
    goIdle();
    block();
    const verdict = manager.trySendTask(instanceId, "x");
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toMatch(/waiting on a decision from you/);
  });

  it("stays refused until the dialog is actually answered", () => {
    goIdle();
    block();
    manager.trySendTask(instanceId, "first");
    manager.trySendTask(instanceId, "second");
    manager.tryRunCommand(instanceId, "/context");
    expect(pty().writes).toEqual([]);
  });

  it("allows writes again once the dialog is cleared and the turn ends", () => {
    goIdle();
    block();
    expect(manager.trySendTask(instanceId, "no").ok).toBe(false);
    cb.activity?.("prompt-cleared");
    goIdle();
    expect(manager.trySendTask(instanceId, "yes").ok).toBe(true);
    expect(pty().writes.join("")).toContain("yes");
  });
});

describe("the write gate on a stopped instance", () => {
  it("refuses and writes nothing after the pty exits", () => {
    goIdle();
    pty().onExitCb?.({ exitCode: 0 });
    const before = pty().writes.length;
    expect(manager.trySendTask(instanceId, "x").ok).toBe(false);
    expect(manager.tryRunCommand(instanceId, "/clear").ok).toBe(false);
    expect(pty().writes.length).toBe(before);
  });

  it("refuses an unknown instance rather than throwing", () => {
    expect(manager.trySendTask("no-such-id", "x").ok).toBe(false);
    expect(manager.tryRunCommand("no-such-id", "/clear").ok).toBe(false);
  });
});

describe("the user's own keystrokes are deliberately not gated", () => {
  // Answering a dialog is exactly what a user is allowed to do, from the desk or
  // from their phone. The gate is for writes nobody is watching. If this ever starts
  // failing, someone has "fixed" the gate by making the app unable to answer
  // prompts.
  it("writeToInstance reaches a blocked instance", () => {
    goIdle();
    block();
    manager.writeToInstance(instanceId, "\r");
    expect(pty().writes).toEqual(["\r"]);
  });

  it("sendPrompt reaches a blocked instance", () => {
    goIdle();
    block();
    manager.sendPrompt(instanceId, "yes do it");
    expect(pty().writes.join("")).toContain("yes do it");
  });
});

describe("run_command's double carriage return", () => {
  it("sends the command, then two returns, none of them at once", async () => {
    goIdle();
    manager.tryRunCommand(instanceId, "/context");
    // The command goes immediately; the returns are delayed so the autocomplete
    // menu has drawn. Both fired together are both swallowed.
    expect(pty().writes).toEqual(["/context"]);
    await vi.waitFor(() => expect(pty().writes).toEqual(["/context", "\r", "\r"]));
  });

  it("does not keep writing returns after the instance exits", async () => {
    goIdle();
    manager.tryRunCommand(instanceId, "/context");
    pty().onExitCb?.({ exitCode: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(pty().writes).toEqual(["/context"]);
  });
});
