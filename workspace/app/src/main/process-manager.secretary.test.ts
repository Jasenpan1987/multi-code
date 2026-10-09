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

describe("answering a dialog for the secretary (T-509)", () => {
  const ASK = {
    detail: { tool: "AskUserQuestion", question: "Which color?", options: [{ label: "Red" }] },
    toolCall: { toolName: "AskUserQuestion", toolInput: { questions: [{ question: "Which color?" }] } },
  };
  const timing = { keyGapMs: 150, followUpDelayMs: 600, clearWaitMs: 5000 };

  function raised(manager: Manager) {
    const id = create(manager);
    latestSpawn(id).report("prompt", ASK.detail, ASK.toolCall);
    const seq = manager.secretaryEventOf(id)!.seq;
    return { id, seq, spawn: latestSpawn(id) };
  }

  it("writes the keys one at a time, the gap apart, for the live dialog only", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["2", "1", "\x1b[B", "\r"] }, undefined, timing);

    expect(spawn.written).toEqual(["2"]);
    await vi.advanceTimersByTimeAsync(149);
    expect(spawn.written).toEqual(["2"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn.written).toEqual(["2", "1"]);
    await vi.advanceTimersByTimeAsync(300);
    await expect(done).resolves.toEqual({ ok: true });
    expect(spawn.written).toEqual(["2", "1", "\x1b[B", "\r"]);
    // Its own first key dealt with the event.
    expect(manager.secretaryEventOf(id)).toBeUndefined();
  });

  it("writes nothing when the dialog was answered first, or another one is up", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    await expect(manager.answerDialog(id, seq - 1, { keys: ["1"] }, undefined, timing)).resolves.toEqual({
      ok: false,
      reason: "answered",
    });
    manager.writeToInstance(id, "x");
    await expect(manager.answerDialog(id, seq, { keys: ["1"] }, undefined, timing)).resolves.toEqual({
      ok: false,
      reason: "answered",
    });
    expect(spawn.written).toEqual(["x"]);
  });

  it("stops when a new dialog comes up between keys", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["1", "2", "3"] }, undefined, timing);
    spawn.report("prompt", ASK.detail, ASK.toolCall);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual({ ok: false, reason: "changed" });
    expect(spawn.written).toEqual(["1"]);
  });

  it("stops when the process exits between keys", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["1", "2"] }, undefined, timing);
    spawn.exit({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual({ ok: false, reason: "stopped" });
    expect(spawn.written).toEqual(["1"]);
  });

  it("sends a denial's reason as a pasted prompt once the dialog is gone", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["3"], followUp: "use wget" }, undefined, timing);
    await vi.advanceTimersByTimeAsync(599);
    expect(spawn.written).toEqual(["3"]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ ok: true });
    expect(spawn.written).toEqual(["3", "\x1b[200~use wget\x1b[201~", "\r"]);
  });

  it("hands back what the CLI recorded when a question box clears", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["1"], expect: { "Which color?": "Red" } }, undefined, timing);
    const recorded = {
      toolName: "AskUserQuestion",
      toolInput: { questions: [], answers: { "Which color?": "Red" } },
    };
    await vi.advanceTimersByTimeAsync(40);
    spawn.report("prompt-cleared", undefined, recorded);
    await expect(done).resolves.toEqual({ ok: true, recorded });
  });

  it("stops when the builder types in the terminal between its keys", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["3", "Green", "\r"] }, undefined, timing);
    manager.writeToInstance(id, "\x1b");
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual({ ok: false, reason: "interrupted" });
    expect(spawn.written).toEqual(["3", "\x1b"]);
  });

  it("stops when run_command's delayed returns land between its keys", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    // Not waiting for the gate: the returns are what's under test.
    vi.spyOn(manager, "canAcceptWrite").mockReturnValue({ ok: true });
    manager.tryRunCommand(id, "/compact");
    latestSpawn(id).report("prompt", ASK.detail, ASK.toolCall);
    const live = manager.secretaryEventOf(id)!.seq;
    const done = manager.answerDialog(id, live, { keys: ["3", "Green", "\r"] }, undefined, timing);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual({ ok: false, reason: "interrupted" });
    expect(spawn.written.filter((w) => w === "Green")).toEqual([]);
    expect(seq).toBeLessThan(live);
  });

  it("carries on through mouse motion and focus reports, which aren't input", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["1", "2"] }, undefined, timing);
    manager.writeToInstance(id, "\x1b[<35;10;5M");
    manager.writeToInstance(id, "\x1b[I");
    await vi.advanceTimersByTimeAsync(200);
    await expect(done).resolves.toEqual({ ok: true });
    expect(spawn.written.filter((w) => w === "1" || w === "2")).toEqual(["1", "2"]);
  });

  it("stops when its caller calls it off: the brief replaced, or the mode off", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const abort = new AbortController();
    const done = manager.answerDialog(id, seq, { keys: ["3", "change it", "\r"] }, abort.signal, timing);
    abort.abort();
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual({ ok: false, reason: "stopped" });
    expect(spawn.written).toEqual(["3"]);
  });

  it("doesn't take another tool's finish for the question box's record", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["1"], expect: { "Which color?": "Red" } }, undefined, timing);
    spawn.report("prompt-cleared", undefined, { toolName: "Bash", toolInput: { command: "ls" } });
    const recorded = { toolName: "AskUserQuestion", toolInput: { answers: { "Which color?": "Red" } } };
    spawn.report("prompt-cleared", undefined, recorded);
    await expect(done).resolves.toEqual({ ok: true, recorded });
  });

  it("counts the wait for the record from the last key, however many keys there are", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const keys = Array.from({ length: 41 }, (_, i) => String((i % 4) + 1));
    const done = manager.answerDialog(id, seq, { keys, expect: { q: "a" } }, undefined, timing);
    await vi.advanceTimersByTimeAsync(40 * 150 + 1000);
    const recorded = { toolName: "AskUserQuestion", toolInput: { answers: { q: "a" } } };
    spawn.report("prompt-cleared", undefined, recorded);
    await expect(done).resolves.toEqual({ ok: true, recorded });
  });

  it("ends the wait for the record at once when the process exits, and says it stopped", async () => {
    const manager = new ProcessManager();
    const { id, seq, spawn } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["1"], expect: { q: "a" } }, undefined, timing);
    await vi.advanceTimersByTimeAsync(10);
    spawn.exit({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toEqual({ ok: false, reason: "stopped" });
  });

  it("gives up waiting for the record after a while, having pressed the keys", async () => {
    const manager = new ProcessManager();
    const { id, seq } = raised(manager);
    const done = manager.answerDialog(id, seq, { keys: ["1"], expect: { q: "a" } }, undefined, timing);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toEqual({ ok: true, recorded: undefined });
  });
});
