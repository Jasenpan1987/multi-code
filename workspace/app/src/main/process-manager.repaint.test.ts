// OpenCode repaints its whole screen once its terminal got shorter and the size
// holds (repaintAfterShrink): a shorter size and the old one back at once left the
// rows under its input blank for good, and every long paste folded.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every resize each spawn was given, in order.
const resizes: [number, number][][] = [];

vi.mock("node-pty", () => ({
  spawn: () => {
    const mine: [number, number][] = [];
    resizes.push(mine);
    return {
      write: () => {},
      onData: () => {},
      onExit: () => {},
      resize: (cols: number, rows: number) => mine.push([cols, rows]),
      kill: () => {},
      pid: 4242,
    };
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

const phoneResizes: [number, number][] = [];
vi.mock("./remote/ws-server", () => ({
  remoteServer: {
    broadcastExit: () => {},
    broadcastInstances: () => {},
    broadcastOutput: () => {},
    broadcastResize: (_id: string, cols: number, rows: number) => phoneResizes.push([cols, rows]),
  },
}));

vi.mock("./shell-manager", () => ({ shellManager: { kill: () => {} } }));

vi.mock("./store", () => ({ loadContacts: () => [], saveContacts: () => {} }));

vi.mock("./backends", () => ({
  getBackend: (name: string) => ({
    name,
    spawn: () => ({ command: name, args: [], env: {}, sessionId: "ses_1" }),
    discoverSessionId: () => ({ cancel: () => {} }),
    createHookAttention: () => ({ handle: () => {}, stop: () => {} }),
    readTranscript: () => [],
    readContextUsage: () => null,
    findLatestSessionId: () => null,
    findLiveSessionId: () => null,
    buildResumeCommand: () => "x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

beforeEach(() => {
  vi.useFakeTimers();
  resizes.length = 0;
  phoneResizes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function started(backend: "opencode" | "claude") {
  const manager = new ProcessManager();
  const { id } = manager.createInstance("/Users/x/code/repo", "repo", backend);
  manager.resizeInstance(id, 100, 40);
  vi.runAllTimers();
  resizes[0].length = 0;
  phoneResizes.length = 0;
  return { manager, id, pty: resizes[0] };
}

describe("OpenCode's repaint after its terminal got shorter", () => {
  it("goes a row shorter and back once a shorter size and the old one came at once", () => {
    const { manager, id, pty } = started("opencode");
    manager.resizeInstance(id, 100, 37);
    manager.resizeInstance(id, 100, 40);
    expect(pty).toEqual([[100, 37], [100, 40]]);
    vi.advanceTimersByTime(199);
    expect(pty).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(pty.at(-1)).toEqual([100, 39]);
    vi.advanceTimersByTime(250);
    expect(pty.slice(2)).toEqual([[100, 39], [100, 40]]);
    // The phone draws at the PTY's width and hears only the real sizes.
    expect(phoneResizes).toEqual([[100, 37], [100, 40]]);
    vi.runAllTimers();
    expect(pty).toHaveLength(4);
  });

  it("waits for the size to hold, and repaints once for many", () => {
    const { manager, id, pty } = started("opencode");
    for (const rows of [39, 38, 37, 36]) {
      manager.resizeInstance(id, 100, rows);
      vi.advanceTimersByTime(100);
    }
    expect(pty).toEqual([[100, 39], [100, 38], [100, 37], [100, 36]]);
    vi.runAllTimers();
    expect(pty.slice(4)).toEqual([[100, 35], [100, 36]]);
  });

  it("leaves a terminal that only grew alone", () => {
    const { manager, id, pty } = started("opencode");
    manager.resizeInstance(id, 100, 44);
    manager.resizeInstance(id, 120, 44);
    vi.runAllTimers();
    expect(pty).toEqual([[100, 44], [120, 44]]);
  });

  it("goes back to a size set while it was a row shorter", () => {
    const { manager, id, pty } = started("opencode");
    manager.resizeInstance(id, 100, 37);
    vi.advanceTimersByTime(200);
    expect(pty.at(-1)).toEqual([100, 36]);
    manager.resizeInstance(id, 100, 42);
    vi.runAllTimers();
    expect(pty).toEqual([[100, 37], [100, 36], [100, 42]]);
  });

  it("does nothing for Claude", () => {
    const { manager, id, pty } = started("claude");
    manager.resizeInstance(id, 100, 37);
    manager.resizeInstance(id, 100, 40);
    vi.runAllTimers();
    expect(pty).toEqual([[100, 37], [100, 40]]);
  });
});
