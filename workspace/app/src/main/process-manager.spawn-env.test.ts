// Which spawn gets which launch options, and which instance id. The id is what a
// hook delivery is attributed by, so it has to be this instance's and nobody
// else's, including when two instances share a cwd.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Spawned {
  env: Record<string, string>;
  opts: unknown;
}
const spawned: Spawned[] = [];
let lastOpts: unknown = undefined;

vi.mock("node-pty", () => ({
  spawn: (_cmd: string, _args: string[], o: { env: Record<string, string> }) => {
    spawned.push({ env: o.env, opts: lastOpts });
    return {
      write: () => {},
      onData: () => {},
      onExit: () => {},
      resize: () => {},
      kill: () => {},
      pid: 4242,
    };
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
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

vi.mock("./store", () => ({ loadContacts: () => [], saveContacts: () => {} }));

vi.mock("./backends", () => ({
  getBackend: (name: string) => ({
    name,
    spawn: (_cwd: string, opts?: unknown) => {
      lastOpts = opts;
      return { command: name, args: [], env: { PATH: "/bin" } };
    },
    discoverSessionId: () => ({ cancel: () => {} }),
    createHookAttention: () => ({ handle: () => {}, stop: () => {} }),
    readTranscript: () => [],
    readContextUsage: () => null,
    keystrokeForChoice: () => null,
    findLatestSessionId: () => null,
    findLiveSessionId: () => null,
    buildResumeCommand: () => "x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

beforeEach(() => {
  spawned.length = 0;
  lastOpts = undefined;
});

describe("spawn env", () => {
  it("names each instance to its own process only, even on a shared cwd", () => {
    const manager = new ProcessManager();
    const a = manager.createInstance("/Users/x/code/repo", "a");
    const b = manager.createInstance("/Users/x/code/repo", "b");
    expect(spawned[0].env.MULTICODE_INSTANCE_ID).toBe(a.id);
    expect(spawned[1].env.MULTICODE_INSTANCE_ID).toBe(b.id);
    // A fresh spawn id each time, so a restarted process's leftovers can be told apart.
    expect(spawned[0].env.MULTICODE_SPAWN_ID).toBeTruthy();
    expect(spawned[1].env.MULTICODE_SPAWN_ID).not.toBe(spawned[0].env.MULTICODE_SPAWN_ID);
    expect(a.id).not.toBe(b.id);
    // The backend's own env survives alongside.
    expect(spawned[0].env.PATH).toBe("/bin");
  });

  it("gives sessions the alert settings and the manager its own options", () => {
    const manager = new ProcessManager();
    manager.setSessionSpawnOptions({ settingsPath: "/ud/alert-settings.json" });
    manager.setManagerSpawnOptions({
      mcpConfigPath: "/ud/manager-mcp.json",
      settingsPath: "/ud/manager-settings.json",
      allowedTools: ["mcp__multi-code__list_sessions"],
    });
    manager.createInstance("/Users/x/code/repo", "repo");
    manager.createInstance("/Users/x/code/mgr", "mgr", "claude", true);
    expect(spawned[0].opts).toEqual({ settingsPath: "/ud/alert-settings.json" });
    expect(spawned[1].opts).toMatchObject({ settingsPath: "/ud/manager-settings.json" });
  });

  it("spawns without options when the alert endpoint isn't up", () => {
    const manager = new ProcessManager();
    manager.setSessionSpawnOptions(null);
    manager.createInstance("/Users/x/code/repo", "repo");
    expect(spawned[0].opts).toBeUndefined();
    expect(spawned[0].env.MULTICODE_INSTANCE_ID).toBeTruthy();
  });
});
