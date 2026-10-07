// A hook delivery from `/alert` reaches the instance it names, and the activity it
// produces reaches everything that used to hear from the transcript detector: run
// state (the write-safety gate) and the manager's waiters.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertDelivery } from "./backends";

interface FakeAttention {
  pid: number;
  handled: AlertDelivery[];
  stopped: boolean;
  onActivity: (type: string) => void;
  onHooksHealth: (ok: boolean) => void;
}
const attentions: FakeAttention[] = [];
const exits: ((e: { exitCode: number }) => void)[] = [];
// The MULTICODE_SPAWN_ID each spawn was given, in order.
const spawnIds: string[] = [];
let nextPid = 100;

vi.mock("node-pty", () => ({
  spawn: (_cmd: string, _args: string[], o: { env: Record<string, string> }) => {
    spawnIds.push(o.env.MULTICODE_SPAWN_ID);
    const pid = nextPid++;
    return {
      write: () => {},
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => exits.push(cb),
      resize: () => {},
      kill: () => {},
      pid,
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
  getBackend: () => ({
    name: "claude",
    spawn: () => ({ command: "claude", args: [], env: {} }),
    discoverSessionId: () => ({ cancel: () => {} }),
    createHookAttention: (
      pid: number,
      onActivity: (type: string) => void,
      onHooksHealth: (ok: boolean) => void
    ) => {
      const a: FakeAttention = { pid, handled: [], stopped: false, onActivity, onHooksHealth };
      attentions.push(a);
      return {
        handle: (d: AlertDelivery) => a.handled.push(d),
        stop: () => {
          a.stopped = true;
        },
      };
    },
    readTranscript: () => [],
    readContextUsage: () => null,
    keystrokeForChoice: () => null,
    findLatestSessionId: () => null,
    findLiveSessionId: () => null,
    buildResumeCommand: () => "x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

// From the latest spawn unless told otherwise, as a live process's hooks would be.
const deliveryFor = (
  instanceId: string,
  event = "Stop",
  spawnId = spawnIds.at(-1)
): AlertDelivery => ({
  instanceId,
  spawnId,
  event,
  payload: { hook_event_name: event },
});

beforeEach(() => {
  attentions.length = 0;
  exits.length = 0;
  spawnIds.length = 0;
});

describe("alert delivery routing", () => {
  it("creates the hook attention at spawn, on the pty's own pid", () => {
    const manager = new ProcessManager();
    manager.createInstance("/Users/x/code/repo", "repo");
    expect(attentions).toHaveLength(1);
    expect(attentions[0].pid).toBe(nextPid - 1);
  });

  it("routes a delivery to the instance it names, and only that one", () => {
    const manager = new ProcessManager();
    const a = manager.createInstance("/Users/x/code/repo", "a");
    const b = manager.createInstance("/Users/x/code/repo", "b");
    manager.handleAlertDelivery(deliveryFor(b.id, "Stop", spawnIds[1]));
    expect(attentions[0].handled).toHaveLength(0);
    expect(attentions[1].handled.map((d) => d.instanceId)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it("drops a delivery for an id no instance has", () => {
    const manager = new ProcessManager();
    manager.createInstance("/Users/x/code/repo", "repo");
    expect(() => manager.handleAlertDelivery(deliveryFor("nobody"))).not.toThrow();
    expect(attentions[0].handled).toHaveLength(0);
  });

  it("feeds run state and the manager's waiters from hook activity", () => {
    const manager = new ProcessManager();
    const { id } = manager.createInstance("/Users/x/code/repo", "repo");
    const heard: string[] = [];
    manager.onActivity((instanceId, type) => {
      if (instanceId === id) heard.push(type);
    });

    attentions[0].onActivity("prompt");
    expect(manager.runStateOf(id)).toBe("blocked");
    // The write-safety gate refuses to type into a dialog.
    expect(manager.canAcceptWrite(id).ok).toBe(false);

    attentions[0].onActivity("prompt-cleared");
    attentions[0].onActivity("waiting");
    expect(manager.runStateOf(id)).toBe("idle");
    expect(heard).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("stops the attention when the process exits, and drops later deliveries", () => {
    const manager = new ProcessManager();
    const { id } = manager.createInstance("/Users/x/code/repo", "repo");
    exits[0]({ exitCode: 0 });
    expect(attentions[0].stopped).toBe(true);
    manager.handleAlertDelivery(deliveryFor(id));
    expect(attentions[0].handled).toHaveLength(0);
  });

  it("a restart gets a fresh attention and stops the old one", () => {
    const manager = new ProcessManager();
    const { id } = manager.createInstance("/Users/x/code/repo", "repo");
    manager.restartInstance(id);
    expect(attentions).toHaveLength(2);
    expect(attentions[0].stopped).toBe(true);
    manager.handleAlertDelivery(deliveryFor(id));
    expect(attentions[1].handled).toHaveLength(1);
  });

  it("drops a late delivery from the process a restart replaced", () => {
    // Same contact id, earlier spawn: its async Stop must not finish the new session.
    const manager = new ProcessManager();
    const { id } = manager.createInstance("/Users/x/code/repo", "repo");
    const oldSpawn = spawnIds[0];
    manager.restartInstance(id);
    expect(spawnIds[1]).not.toBe(oldSpawn);
    manager.handleAlertDelivery(deliveryFor(id, "Stop", oldSpawn));
    // No spawn header at all is no match either.
    manager.handleAlertDelivery({ instanceId: id, event: "Stop", payload: {} });
    expect(attentions[1].handled).toHaveLength(0);
  });

  it("marks an instance degraded when its hooks don't run, and clears it when one arrives", () => {
    const manager = new ProcessManager();
    manager.setSessionSpawnOptions({ settingsPath: "/ud/alert-settings.json" });
    const { id } = manager.createInstance("/Users/x/code/repo", "repo");
    const info = () => manager.listInstances().find((i) => i.id === id);
    expect(info()?.alertsDegraded).toBeUndefined();
    attentions[0].onHooksHealth(false);
    expect(info()?.alertsDegraded).toBe(true);
    attentions[0].onHooksHealth(true);
    expect(info()?.alertsDegraded).toBeUndefined();
  });

  it("marks a Claude instance degraded from the start when it spawned without alert hooks", () => {
    const manager = new ProcessManager();
    manager.setSessionSpawnOptions(null);
    const created = manager.createInstance("/Users/x/code/repo", "repo");
    expect(created.alertsDegraded).toBe(true);
  });

  it("judges each backend by its own wiring: OpenCode by the plugin, Claude by the settings", () => {
    const manager = new ProcessManager();
    manager.setSessionSpawnOptions({ settingsPath: "/ud/alert-settings.json" });
    expect(manager.createInstance("/Users/x/code/a", "a", "opencode").alertsDegraded).toBe(true);
    expect(manager.createInstance("/Users/x/code/b", "b", "claude").alertsDegraded).toBeUndefined();

    manager.setSessionSpawnOptions({
      opencodePlugin: { pluginPath: "/ud/opencode/multicode-plugin.js", targetPath: "/ud/opencode/alert.json" },
    });
    expect(manager.createInstance("/Users/x/code/c", "c", "opencode").alertsDegraded).toBeUndefined();
    expect(manager.createInstance("/Users/x/code/d", "d", "claude").alertsDegraded).toBe(true);
  });
});
