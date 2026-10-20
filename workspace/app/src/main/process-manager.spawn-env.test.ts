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
// Set to make the next spawns refused, as OpenCode 1.x's are.
let refusal: string | undefined;
// Which conversation each spawn was asked to open.
const sessions: unknown[] = [];

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
    spawn: (_cwd: string, opts?: unknown, session?: { kind: string; sessionId?: string }) => {
      lastOpts = opts;
      sessions.push(session);
      if (refusal) return { command: name, args: [], env: {}, refusal };
      // As OpenCode 2's does: every spawn names its session.
      return {
        command: name,
        args: [],
        env: { PATH: "/bin" },
        sessionId: session?.kind === "own" ? session.sessionId : "ses_minted",
      };
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
  refusal = undefined;
  sessions.length = 0;
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

describe("a refused spawn (OpenCode 1.x)", () => {
  const REASON = "Multi-Code needs OpenCode 2 (found 1.18.35). Upgrade with: …";

  it("starts nothing and leaves the contact stopped with the reason", () => {
    const manager = new ProcessManager();
    refusal = REASON;
    const info = manager.createInstance("/Users/x/code/oc", "oc", "opencode");
    expect(spawned).toHaveLength(0);
    expect(info).toMatchObject({ status: "stopped", startError: REASON });
    expect(manager.runStateOf(info.id)).toBeUndefined();
  });

  it("keeps the contact's own session through a refused start, and clears the reason once one runs", () => {
    const manager = new ProcessManager();
    const created = manager.createInstance("/Users/x/code/oc", "oc", "opencode");
    refusal = REASON;
    const refused = manager.restartInstance(created.id);
    expect(refused).toMatchObject({ status: "stopped", startError: REASON });
    expect(sessions.at(-1)).toEqual({ kind: "own", sessionId: "ses_minted" });
    // Upgraded: the next start goes back to the same conversation.
    refusal = undefined;
    const started = manager.startInstance(created.id);
    expect(sessions.at(-1)).toEqual({ kind: "own", sessionId: "ses_minted" });
    expect(started).toMatchObject({ status: "running" });
    expect(started?.startError).toBeUndefined();
  });
});
