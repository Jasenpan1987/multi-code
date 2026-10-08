// Each Claude instance keeps its latest Finished or Needs-you, with the dialog's
// material, until the builder deals with it (voice secretary, T-503). The hook path
// is the real one: fixture deliveries from the CLI go through `handleAlertDelivery`
// into ClaudeHookAttention and back out as the event.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { parseAlertDelivery } from "./manager-mcp/server";
import type { ActivityCallback } from "./backends/types";
import type { SecretaryEvent } from "./process-manager";

interface Spawn {
  instanceId: string;
  spawnId: string;
  pid: number;
  written: string[];
  exit: (e: { exitCode: number }) => void;
  report: ActivityCallback;
}
const spawns: Spawn[] = [];
let nextPid = 500;

// What the CLI's registry says, as ClaudeHookAttention reads it after a Stop.
let registryStatus: () => string | null = () => "idle";

vi.mock("node-pty", () => ({
  spawn: (_cmd: string, _args: string[], o: { env: Record<string, string> }) => {
    const spawn: Spawn = {
      instanceId: o.env.MULTICODE_INSTANCE_ID,
      spawnId: o.env.MULTICODE_SPAWN_ID,
      pid: nextPid++,
      written: [],
      exit: () => {},
      report: () => {},
    };
    spawns.push(spawn);
    return {
      write: (data: string) => spawn.written.push(data),
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => {
        spawn.exit = cb;
      },
      resize: () => {},
      kill: () => {},
      pid: spawn.pid,
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

vi.mock("./backends", async () => {
  const { ClaudeHookAttention } = await import("./backends/claudeHooks");
  const backend = (name: string, keepsSecretaryEvents: boolean) => ({
    name,
    keepsSecretaryEvents,
    spawn: () => ({ command: name, args: [], env: {} }),
    discoverSessionId: () => ({ cancel: () => {} }),
    createHookAttention: (
      pid: number,
      onActivity: ActivityCallback,
      onHooksHealth: (ok: boolean) => void
    ) => {
      const spawn = spawns.find((s) => s.pid === pid);
      if (spawn) spawn.report = onActivity;
      return new ClaudeHookAttention(
        onActivity,
        () => registryStatus(),
        undefined,
        onHooksHealth
      );
    },
    readTranscript: () => [],
    readContextUsage: () => null,
    keystrokeForChoice: () => null,
    findLatestSessionId: () => null,
    findLiveSessionId: () => null,
    buildResumeCommand: () => "x",
  });
  const claude = backend("claude", true);
  const opencode = backend("opencode", true);
  return { getBackend: (name: string) => (name === "opencode" ? opencode : claude) };
});

const { ProcessManager } = await import("./process-manager");
type Manager = InstanceType<typeof ProcessManager>;

const FIXTURES = path.join(__dirname, "backends/__fixtures__/claude-hooks");

interface Fixture {
  deliveries: { ms: number; payload: Record<string, unknown> }[];
  registry: { ms: number; status: string }[];
}

function fixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

const latestSpawn = (id: string): Spawn => {
  const spawn = spawns.filter((s) => s.instanceId === id).at(-1);
  if (!spawn) throw new Error(`no spawn for ${id}`);
  return spawn;
};

// Play a fixture's deliveries into the instance on its own timeline, the registry
// reading what the CLI's did at each moment, then let any pending finish land.
function replay(manager: Manager, id: string, name: string) {
  const { deliveries, registry } = fixture(name);
  const t0 = Date.now();
  registryStatus = () => {
    let status: string | null = null;
    for (const r of registry) if (r.ms <= Date.now() - t0) status = r.status;
    return status;
  };
  let at = 0;
  for (const d of deliveries) {
    vi.advanceTimersByTime(Math.max(0, d.ms - at));
    at = Math.max(at, d.ms);
    const delivery = parseAlertDelivery(id, JSON.stringify(d.payload), latestSpawn(id).spawnId);
    if (!delivery) throw new Error(`unparseable delivery in ${name}`);
    manager.handleAlertDelivery(delivery);
  }
  vi.advanceTimersByTime(15_000);
}

// Every notification the manager sends, in order.
function listen(manager: Manager) {
  const seen: { id: string; event: SecretaryEvent | null }[] = [];
  manager.onSecretaryEvent((id, event) => seen.push({ id, event }));
  return {
    seen,
    kinds: () => seen.map((s) => s.event?.kind ?? null),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  spawns.length = 0;
  registryStatus = () => "idle";
});

afterEach(() => {
  vi.useRealTimers();
});

const create = (manager: Manager, backend: "claude" | "opencode" = "claude") =>
  manager.createInstance("/Users/x/code/repo", "repo", backend).id;

describe("setting an event from the agent's own report", () => {
  it("a finished turn sets a finished event, with no dialog material", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const { seen, kinds } = listen(manager);
    replay(manager, id, "plain-finish");

    expect(kinds()).toEqual(["finished"]);
    const event = manager.secretaryEventOf(id);
    expect(event).toEqual(seen[0].event);
    expect(event?.prompt).toBeUndefined();
    expect(typeof event?.seq).toBe("number");
    expect(typeof event?.at).toBe("number");
    expect(seen[0].id).toBe(id);
  });

  it("a Bash PermissionRequest sets needs-you with the exact command, cleared when answered, then a finish", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const { seen, kinds } = listen(manager);
    replay(manager, id, "permission-approved");

    expect(kinds()).toEqual(["needs-you", null, "finished"]);
    const needsYou = seen[0].event;
    expect(needsYou?.prompt?.toolName).toBe("Bash");
    expect(needsYou?.prompt?.toolInput).toEqual({
      command: "touch a.txt",
      description: "Create file a.txt",
    });
    // The same decoded options the phone gets: an ask-rule dialog is Yes / No.
    expect(needsYou?.prompt?.detail.tool).toBe("Bash");
    expect(needsYou?.prompt?.detail.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(seen[2].event?.seq).toBeGreaterThan(needsYou?.seq ?? Infinity);
    expect(manager.secretaryEventOf(id)?.kind).toBe("finished");
  });

  it("an AskUserQuestion carries its questions as the agent wrote them", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const { seen } = listen(manager);
    replay(manager, id, "ask-question");

    const prompt = seen[0].event?.prompt;
    expect(prompt?.toolName).toBe("AskUserQuestion");
    expect(prompt?.detail.options.map((o) => o.label)).toEqual(["Tea", "Coffee", "Other"]);
    expect(prompt?.toolInput).toMatchObject({
      questions: [{ question: "Do you prefer tea or coffee?" }],
    });
  });

  it("an MCP elicitation is needs-you with no material to answer from", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const { seen } = listen(manager);
    replay(manager, id, "mcp-elicitation");

    expect(seen[0].event?.kind).toBe("needs-you");
    expect(seen[0].event?.prompt).toBeUndefined();
  });

  it("a newer event replaces the older one with a higher seq", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const { seen } = listen(manager);
    const report = latestSpawn(id).report;
    report("waiting");
    report("waiting");
    report("prompt");

    expect(seen.map((s) => s.event?.kind)).toEqual(["finished", "finished", "needs-you"]);
    const seqs = seen.map((s) => s.event?.seq ?? 0);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
    expect(manager.secretaryEventOf(id)?.seq).toBe(seqs[2]);
  });

  it("prompt-cleared leaves a finished event alone", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const report = latestSpawn(id).report;
    report("waiting");
    report("prompt-cleared");
    expect(manager.secretaryEventOf(id)?.kind).toBe("finished");
  });
});

describe("clearing once the builder has dealt with it", () => {
  it.each([
    ["a key at the desk or from the phone", (m: Manager, id: string) => m.writeToInstance(id, "h")],
    ["the compose box or the phone's answer box", (m: Manager, id: string) => m.sendPrompt(id, "more")],
    ["an empty answer, which still submits", (m: Manager, id: string) => m.sendPrompt(id, "")],
    ["the manager's send_task", (m: Manager, id: string) => m.trySendTask(id, "next")],
    ["the manager's run_command", (m: Manager, id: string) => m.tryRunCommand(id, "/compact")],
  ])("a write clears a finished event: %s", (_name, write) => {
    const manager = new ProcessManager();
    const id = create(manager);
    replay(manager, id, "plain-finish");
    const { kinds } = listen(manager);

    write(manager, id);
    expect(kinds()).toEqual([null]);
    expect(manager.secretaryEventOf(id)).toBeUndefined();
  });

  it("run_command's delayed returns clear a dialog raised while they were pending", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    replay(manager, id, "plain-finish");
    manager.tryRunCommand(id, "/compact");
    expect(manager.secretaryEventOf(id)).toBeUndefined();

    // A subagent's permission dialog lands in the gap before the first return.
    const request = fixture("permission-denied-no").deliveries.find(
      (d) => d.payload.hook_event_name === "PermissionRequest"
    );
    if (!request) throw new Error("fixture has no PermissionRequest");
    const delivery = parseAlertDelivery(id, JSON.stringify(request.payload), latestSpawn(id).spawnId);
    if (!delivery) throw new Error("unparseable PermissionRequest");
    manager.handleAlertDelivery(delivery);
    expect(manager.secretaryEventOf(id)?.kind).toBe("needs-you");

    // The return that follows answers it, so its brief must not outlive it.
    vi.advanceTimersByTime(1_000);
    expect(manager.secretaryEventOf(id)).toBeUndefined();
    expect(latestSpawn(id).written).toEqual(["/compact", "\r", "\r"]);
  });

  it("the keystroke that denies a dialog clears its needs-you, since the CLI reports nothing", () => {
    // permission-denied-no ends at the PermissionRequest: the builder pressed 2 and
    // no delivery followed.
    const manager = new ProcessManager();
    const id = create(manager);
    replay(manager, id, "permission-denied-no");
    expect(manager.secretaryEventOf(id)?.kind).toBe("needs-you");

    const { kinds } = listen(manager);
    manager.writeToInstance(id, "2");
    expect(kinds()).toEqual([null]);
  });

  it("terminal focus reports alone clear nothing, and still reach the pty", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    replay(manager, id, "plain-finish");
    const { kinds } = listen(manager);

    manager.writeToInstance(id, "\x1b[I");
    manager.writeToInstance(id, "\x1b[O");
    manager.writeToInstance(id, "\x1b[O\x1b[I");
    manager.writeToInstance(id, "");
    expect(kinds()).toEqual([]);
    expect(manager.secretaryEventOf(id)?.kind).toBe("finished");
    expect(latestSpawn(id).written).toEqual(["\x1b[I", "\x1b[O", "\x1b[O\x1b[I", ""]);

    // A real key alongside one does count.
    manager.writeToInstance(id, "\x1b[Iy");
    expect(kinds()).toEqual([null]);
  });

  it("mouse motion and wheel reports clear nothing; a click does", () => {
    // CLI 2.1.292 turns on any-motion tracking in SGR form (?1003h, ?1006h), so the
    // pointer crossing the terminal on its way to the secretary card sends these.
    const manager = new ProcessManager();
    const id = create(manager);
    replay(manager, id, "plain-finish");
    const { kinds } = listen(manager);

    manager.writeToInstance(id, "\x1b[<35;40;12M"); // motion, no button
    manager.writeToInstance(id, "\x1b[<35;41;12M\x1b[<35;42;13M");
    manager.writeToInstance(id, "\x1b[<32;42;13M"); // drag with the left button
    manager.writeToInstance(id, "\x1b[<64;42;13M\x1b[<65;42;13M"); // wheel up, down
    manager.writeToInstance(id, "\x1b[I\x1b[<35;10;3M"); // focus, then a move
    expect(kinds()).toEqual([]);
    expect(manager.secretaryEventOf(id)?.kind).toBe("finished");
    // Still delivered: the CLI asked for them.
    expect(latestSpawn(id).written).toContain("\x1b[<35;40;12M");

    // A press is the builder clicking in the TUI.
    manager.writeToInstance(id, "\x1b[<0;42;13M");
    expect(kinds()).toEqual([null]);
  });

  it("a key alongside a mouse move counts", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    replay(manager, id, "plain-finish");
    const { kinds } = listen(manager);
    manager.writeToInstance(id, "\x1b[<35;40;12My");
    expect(kinds()).toEqual([null]);
  });

  it("a resize is not a write", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    replay(manager, id, "plain-finish");
    manager.resizeInstance(id, 100, 40);
    expect(manager.secretaryEventOf(id)?.kind).toBe("finished");
  });

  it("a write with nothing live notifies nobody", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const { seen } = listen(manager);
    manager.writeToInstance(id, "hello");
    manager.writeToInstance(id, "\r");
    expect(seen).toEqual([]);
  });
});

describe("exit, restart and removal", () => {
  it("exit clears the event and says so", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    latestSpawn(id).report("waiting");
    const { kinds } = listen(manager);

    latestSpawn(id).exit({ exitCode: 0 });
    expect(kinds()).toEqual([null]);
    expect(manager.secretaryEventOf(id)).toBeUndefined();
  });

  it("a restart clears the event, and seq keeps growing for the new spawn", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    latestSpawn(id).report("waiting");
    const before = manager.secretaryEventOf(id)?.seq ?? Infinity;
    const old = latestSpawn(id);
    const { kinds } = listen(manager);

    manager.restartInstance(id);
    expect(kinds()).toEqual([null]);

    latestSpawn(id).report("waiting");
    expect(manager.secretaryEventOf(id)?.seq).toBeGreaterThan(before);

    // The replaced process exits after the new one is up. It must not wipe the
    // new spawn's event.
    old.exit({ exitCode: 0 });
    expect(kinds()).toEqual([null, "finished"]);
    expect(manager.secretaryEventOf(id)?.kind).toBe("finished");
  });

  it("a late delivery from the process a restart replaced sets nothing", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const oldSpawnId = latestSpawn(id).spawnId;
    manager.restartInstance(id);
    const { seen } = listen(manager);

    const request = fixture("permission-approved").deliveries.find(
      (d) => d.payload.hook_event_name === "PermissionRequest"
    );
    const delivery = parseAlertDelivery(id, JSON.stringify(request?.payload), oldSpawnId);
    if (delivery) manager.handleAlertDelivery(delivery);
    expect(seen).toEqual([]);
    expect(manager.secretaryEventOf(id)).toBeUndefined();
  });

  it("removing the instance clears its event and says so", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    latestSpawn(id).report("prompt");
    const { seen } = listen(manager);

    manager.removeInstance(id);
    expect(seen).toEqual([{ id, event: null }]);
    expect(manager.liveSecretaryEvents()).toEqual([]);
  });
});

describe("instances that never get one", () => {
  it("the manager", () => {
    const manager = new ProcessManager();
    const { id } = manager.createInstance("/Users/x/ud/manager", "Manager", "claude", true);
    const { seen } = listen(manager);
    replay(manager, id, "permission-approved");
    latestSpawn(id).report("waiting");

    expect(seen).toEqual([]);
    expect(manager.secretaryEventOf(id)).toBeUndefined();
  });

  it("the manager doesn't disturb the activity everything else hears", () => {
    const manager = new ProcessManager();
    const { id } = manager.createInstance("/Users/x/ud/manager", "Manager", "claude", true);
    const heard: string[] = [];
    manager.onActivity((_id, type) => heard.push(type));
    latestSpawn(id).report("waiting");
    expect(heard).toEqual(["waiting"]);
    expect(manager.runStateOf(id)).toBe("idle");
  });
});

describe("an OpenCode instance (PRD v1.6)", () => {
  it("keeps its dialog's request and its finish, like a Claude one", () => {
    const manager = new ProcessManager();
    const id = create(manager, "opencode");
    const { kinds } = listen(manager);
    const report = latestSpawn(id).report;
    const detail = {
      tool: "Permission",
      question: "Permission required: bash: rm -rf build",
      options: [{ label: "Allow once" }, { label: "Allow always" }, { label: "Reject" }],
    };
    const call = {
      toolName: "bash",
      toolInput: { patterns: ["rm -rf build"], metadata: { command: "rm -rf build" } },
    };
    report("prompt", detail, call);
    expect(manager.secretaryEventOf(id)).toMatchObject({
      kind: "needs-you",
      prompt: { detail, toolName: "bash", toolInput: call.toolInput },
    });
    report("prompt-cleared");
    expect(manager.secretaryEventOf(id)).toBeUndefined();
    report("waiting");
    expect(manager.secretaryEventOf(id)).toMatchObject({ kind: "finished" });
    expect(kinds()).toEqual(["needs-you", null, "finished"]);
  });
});

describe("the subscription", () => {
  it("unsubscribing stops notifications", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    const seen: (SecretaryEvent | null)[] = [];
    const off = manager.onSecretaryEvent((_id, event) => seen.push(event));
    latestSpawn(id).report("waiting");
    off();
    latestSpawn(id).report("waiting");
    expect(seen).toHaveLength(1);
  });

  it("a throwing listener doesn't stop the others, or the activity", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    manager.onSecretaryEvent(() => {
      throw new Error("broken consumer");
    });
    const { kinds } = listen(manager);
    const heard: string[] = [];
    manager.onActivity((_id, type) => heard.push(type));

    expect(() => latestSpawn(id).report("waiting")).not.toThrow();
    expect(kinds()).toEqual(["finished"]);
    expect(heard).toEqual(["waiting"]);
  });

  it("a write made in reaction to the activity clears the event that activity raised", () => {
    const manager = new ProcessManager();
    const id = create(manager);
    manager.onActivity((instanceId, type) => {
      if (type === "waiting") manager.writeToInstance(instanceId, "next task\r");
    });
    latestSpawn(id).report("waiting");
    expect(manager.secretaryEventOf(id)).toBeUndefined();
  });

  it("lists every live event, for a consumer starting with red dots already showing", () => {
    const manager = new ProcessManager();
    const a = create(manager);
    const b = create(manager);
    const c = create(manager);
    latestSpawn(a).report("waiting");
    latestSpawn(b).report("prompt");
    latestSpawn(c).report("waiting");
    manager.writeToInstance(c, "x");

    const live = manager.liveSecretaryEvents();
    expect(live.map((l) => [l.instanceId, l.event.kind])).toEqual([
      [a, "finished"],
      [b, "needs-you"],
    ]);
  });
});
