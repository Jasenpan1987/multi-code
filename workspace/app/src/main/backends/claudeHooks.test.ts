// Replays the hook deliveries and registry series the real CLI produced (T-401, CLI
// 2.1.291) through ClaudeHookAttention on a virtual clock, and checks the exact
// events each scenario raises. The fixtures are the evidence; a rule changed here
// without a fixture to back it is a guess.

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { ClaudeHookAttention, type HookTimers } from "./claudeHooks";
import { parseAlertDelivery } from "../manager-mcp/server";
import type { AlertDelivery } from "./types";
import type { PromptDetail } from "../remote/promptExtract";

const FIXTURES = path.join(__dirname, "__fixtures__/claude-hooks");

interface Fixture {
  cli: string;
  scenario: string;
  deliveries: { ms: number; payload: Record<string, unknown> }[];
  registry: { ms: number; status: string; waitingFor?: string }[];
}

class VirtualTimers implements HookTimers {
  now = 0;
  private queue: { at: number; id: number; fn: () => void }[] = [];
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ at: this.now + ms, id, fn });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }

  advanceTo(t: number) {
    for (;;) {
      const due = this.queue
        .filter((q) => q.at <= t)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((q) => q !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = t;
  }
}

interface Raised {
  ms: number;
  type: string;
  detail?: PromptDetail;
}

function harness(registryAt: (ms: number) => string | null) {
  const timers = new VirtualTimers();
  const raised: Raised[] = [];
  const attention = new ClaudeHookAttention(
    (type, detail) => raised.push({ ms: timers.now, type, detail }),
    () => registryAt(timers.now),
    timers
  );
  return { timers, raised, attention };
}

function delivery(payload: Record<string, unknown>): AlertDelivery {
  const parsed = parseAlertDelivery("inst-1", JSON.stringify(payload));
  if (!parsed) throw new Error(`unparseable delivery: ${JSON.stringify(payload)}`);
  return parsed;
}

function replay(name: string) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")
  ) as Fixture;
  const statusAt = (ms: number): string | null => {
    let current: string | null = null;
    for (const r of fixture.registry) if (r.ms <= ms) current = r.status;
    return current;
  };
  const { timers, raised, attention } = harness(statusAt);
  const start = Math.min(0, ...fixture.registry.map((r) => r.ms));
  timers.advanceTo(start);
  for (const d of fixture.deliveries) {
    timers.advanceTo(d.ms);
    attention.handle(delivery(d.payload));
  }
  const last = fixture.deliveries.at(-1)?.ms ?? 0;
  timers.advanceTo(last + 15_000);
  attention.stop();
  const stopsAt = fixture.deliveries
    .filter((d) => d.payload.hook_event_name === "Stop" && !("agent_id" in d.payload))
    .map((d) => d.ms);
  return { fixture, raised, types: raised.map((r) => r.type), stopsAt };
}

describe("replaying the CLI's own deliveries", () => {
  it.each([
    ["plain-finish"],
    ["long-bash"],
    ["two-settings"],
    ["slash-clear"],
  ])("%s: one finish, after the turn's Stop", (name) => {
    const { types, raised, stopsAt } = replay(name);
    expect(types).toEqual(["waiting"]);
    expect(raised[0].ms).toBeGreaterThanOrEqual(stopsAt.at(-1) ?? 0);
  });

  it.each([["subagent"], ["subagent-foreground-requested"], ["bg-subagent"]])(
    "%s: nothing at the early Stop while the subagent runs, one finish at the real end",
    (name) => {
      const { types, raised, stopsAt } = replay(name);
      expect(stopsAt).toHaveLength(2);
      expect(types).toEqual(["waiting"]);
      expect(raised[0].ms).toBeGreaterThan(stopsAt[1]);
    }
  );

  it("bg-shell: a running background Bash doesn't hold the finish, and its wake-up turn finishes again (G-003)", () => {
    const { types, raised, stopsAt } = replay("bg-shell");
    expect(types).toEqual(["waiting", "waiting"]);
    expect(raised[0].ms).toBeLessThan(stopsAt[1]);
    expect(raised[1].ms).toBeGreaterThan(stopsAt[1]);
  });

  it("stop-hook-block: a user Stop hook that continues the turn gives one finish, at the second Stop", () => {
    const { types, raised, stopsAt } = replay("stop-hook-block");
    expect(stopsAt).toHaveLength(2);
    expect(types).toEqual(["waiting"]);
    expect(raised[0].ms).toBeGreaterThan(stopsAt[1]);
  });

  it("api-error: StopFailure finishes at once, with no Stop", () => {
    const { types, stopsAt } = replay("api-error");
    expect(stopsAt).toHaveLength(0);
    expect(types).toEqual(["waiting"]);
  });

  it("slash-compact: a manual /compact finishes at PostCompact", () => {
    expect(replay("slash-compact").types).toEqual(["waiting"]);
  });

  it.each([["slash-cost"], ["slash-status"], ["slash-model"], ["esc-interrupt"]])(
    "%s: raises nothing",
    (name) => {
      expect(replay(name).types).toEqual([]);
    }
  );

  it.each([
    ["permission-approved"],
    ["mcp-permission-approved-always"],
    ["ask-question"],
    ["plan-approval"],
    ["mcp-elicitation"],
    ["auto-ask-question"],
    ["auto-plan-approval"],
    ["auto-permission"],
    ["bypass-ask-question"],
    ["bypass-plan-approval"],
    ["subagent-permission"],
  ])("%s: needs you, cleared when answered, then one finish", (name) => {
    expect(replay(name).types).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it.each([
    ["permission-denied-esc"],
    ["permission-denied-no"],
    ["mcp-permission-denied-no"],
    ["plan-rejected"],
  ])("%s: needs you, and a denial ends the turn with nothing more", (name) => {
    expect(replay(name).types).toEqual(["prompt"]);
  });

  it("two-dialogs: two dialogs in a row raise two prompts", () => {
    expect(replay("two-dialogs").types).toEqual([
      "prompt",
      "prompt-cleared",
      "prompt",
      "prompt-cleared",
      "waiting",
    ]);
  });

  it("raises the prompt within a few ms of the PermissionRequest", () => {
    const { fixture, raised } = replay("permission-approved");
    const request = fixture.deliveries.find(
      (d) => d.payload.hook_event_name === "PermissionRequest"
    );
    expect(raised[0].ms).toBe(request?.ms);
  });
});

describe("prompt detail for a paired phone", () => {
  it("an ask-rule dialog offers only Yes / No", () => {
    const detail = replay("permission-approved").raised[0].detail;
    expect(detail?.tool).toBe("Bash");
    expect(detail?.question).toBe("Bash: touch a.txt");
    expect(detail?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  });

  it("a dialog with permission suggestions keeps its don't-ask-again option", () => {
    const detail = replay("mcp-permission-approved-always").raised[0].detail;
    expect(detail?.options).toHaveLength(3);
  });

  it("AskUserQuestion carries the question and its options", () => {
    const detail = replay("ask-question").raised[0].detail;
    expect(detail?.tool).toBe("AskUserQuestion");
    expect(detail?.options.map((o) => o.label)).toContain("Other");
    expect(detail?.options.length).toBeGreaterThanOrEqual(3);
  });

  it("plan approval is an ExitPlanMode prompt", () => {
    expect(replay("plan-approval").raised[0].detail?.tool).toBe("ExitPlanMode");
  });

  it("an MCP elicitation has no detail, so the phone shows the terminal", () => {
    expect(replay("mcp-elicitation").raised[0].detail).toBeUndefined();
  });
});

describe("rules the fixtures don't reach", () => {
  const stop = (extra: Record<string, unknown> = {}) =>
    delivery({ hook_event_name: "Stop", background_tasks: [], ...extra });
  const runningSubagent = [{ id: "a1", type: "subagent", status: "running" }];

  it("a new prompt during the settle window cancels the finish", () => {
    const { timers, raised, attention } = harness(() => "busy");
    attention.handle(stop());
    timers.advanceTo(100);
    attention.handle(delivery({ hook_event_name: "UserPromptSubmit", prompt: "more" }));
    timers.advanceTo(5000);
    expect(raised).toEqual([]);
  });

  it("a slow user Stop hook that doesn't block still finishes, once the registry settles", () => {
    // T-401 item 8: a sync Stop hook keeps the registry busy for its whole runtime,
    // and no second Stop follows when it doesn't block.
    const { timers, raised, attention } = harness((ms) => (ms < 2000 ? "busy" : "idle"));
    attention.handle(stop());
    timers.advanceTo(10_000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
    expect(raised[0].ms).toBeGreaterThanOrEqual(2000);
    expect(raised[0].ms).toBeLessThan(2500);
  });

  it("an unreadable registry trusts the Stop", () => {
    const { timers, raised, attention } = harness(() => null);
    attention.handle(stop());
    timers.advanceTo(1000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("gives up on a turn that never leaves busy", () => {
    const { timers, raised, attention } = harness(() => "busy");
    attention.handle(stop());
    timers.advanceTo(11 * 60_000);
    expect(raised).toEqual([]);
  });

  it("while a subagent runs, nothing reads the registry into a finish, however long it runs", () => {
    // Even a registry that said idle mid-run (a CLI change) must not chime: the
    // hold ends on the CLI's own events.
    const { timers, raised, attention } = harness(() => "idle");
    attention.handle(stop({ background_tasks: runningSubagent }));
    timers.advanceTo(30 * 60_000);
    expect(raised).toEqual([]);
  });

  it("the wake-up after the last subagent stops cancels the grace period; its own Stop finishes", () => {
    const { timers, raised, attention } = harness(() => "idle");
    attention.handle(stop({ background_tasks: runningSubagent }));
    timers.advanceTo(20_000);
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a1" }));
    timers.advanceTo(20_050);
    attention.handle(delivery({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>" }));
    timers.advanceTo(30_000);
    expect(raised).toEqual([]);
    attention.handle(stop());
    timers.advanceTo(31_000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("a subagent that stops without waking the agent still finishes, after the grace period", () => {
    const { timers, raised, attention } = harness(() => "idle");
    attention.handle(stop({ background_tasks: runningSubagent }));
    timers.advanceTo(10_000);
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a1" }));
    timers.advanceTo(12_000);
    expect(raised).toEqual([]);
    timers.advanceTo(14_000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("holds until every running subagent has stopped", () => {
    const { timers, raised, attention } = harness(() => "idle");
    attention.handle(
      stop({
        background_tasks: [
          { id: "a1", type: "subagent", status: "running" },
          { id: "a2", type: "subagent", status: "running" },
        ],
      })
    );
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a1" }));
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a1" }));
    timers.advanceTo(60_000);
    expect(raised).toEqual([]);
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a2" }));
    timers.advanceTo(65_000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("a running subagent with no id falls back to the registry, which reads busy while it works", () => {
    let status = "busy";
    const { timers, raised, attention } = harness(() => status);
    attention.handle(stop({ background_tasks: [{ type: "subagent", status: "running" }] }));
    timers.advanceTo(20_000);
    expect(raised).toEqual([]);
    status = "idle";
    timers.advanceTo(21_000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("a background shell alone doesn't hold the finish", () => {
    const { timers, raised, attention } = harness(() => "shell");
    attention.handle(
      stop({ background_tasks: [{ id: "b1", type: "shell", status: "running" }] })
    );
    timers.advanceTo(1000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("a subagent's dialog during a hold raises needs-you and keeps the hold", () => {
    let status = "busy";
    const { timers, raised, attention } = harness(() => status);
    attention.handle(stop({ background_tasks: runningSubagent }));
    timers.advanceTo(500);
    status = "waiting";
    attention.handle(
      delivery({ hook_event_name: "PermissionRequest", tool_name: "Bash", agent_id: "a1" })
    );
    timers.advanceTo(3000);
    status = "busy";
    attention.handle(delivery({ hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "a1" }));
    timers.advanceTo(4000);
    expect(raised.map((r) => r.type)).toEqual(["prompt", "prompt-cleared"]);
  });

  it("a Stop or StopFailure from a subagent raises nothing", () => {
    const { timers, raised, attention } = harness(() => "idle");
    attention.handle(stop({ agent_id: "a1" }));
    attention.handle(delivery({ hook_event_name: "StopFailure", agent_id: "a1" }));
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a1" }));
    timers.advanceTo(5000);
    expect(raised).toEqual([]);
  });

  it("an automatic compaction raises nothing of its own", () => {
    const { timers, raised, attention } = harness(() => "busy");
    attention.handle(delivery({ hook_event_name: "PostCompact", trigger: "auto" }));
    timers.advanceTo(5000);
    expect(raised).toEqual([]);
  });

  it("clears an outstanding prompt once, not on every later event", () => {
    const { timers, raised, attention } = harness(() => "idle");
    attention.handle(delivery({ hook_event_name: "PermissionRequest", tool_name: "Bash" }));
    attention.handle(delivery({ hook_event_name: "PostToolUse", tool_name: "Bash" }));
    attention.handle(delivery({ hook_event_name: "PostToolUse", tool_name: "Read" }));
    attention.handle(stop());
    timers.advanceTo(1000);
    expect(raised.map((r) => r.type)).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("raises nothing after stop()", () => {
    const { timers, raised, attention } = harness(() => "idle");
    attention.handle(stop());
    attention.stop();
    timers.advanceTo(5000);
    attention.handle(stop());
    attention.handle(delivery({ hook_event_name: "PermissionRequest", tool_name: "Bash" }));
    timers.advanceTo(10_000);
    expect(raised).toEqual([]);
  });
});

describe("hook health", () => {
  function healthHarness(registryAt: (ms: number) => string | null) {
    const timers = new VirtualTimers();
    const health: { ms: number; ok: boolean }[] = [];
    const attention = new ClaudeHookAttention(
      () => {},
      () => registryAt(timers.now),
      timers,
      (ok) => health.push({ ms: timers.now, ok })
    );
    return { timers, health, attention };
  }

  it("says the hooks aren't running when the CLI is up and nothing arrives for 10s", () => {
    const { timers, health } = healthHarness(() => "idle");
    timers.advanceTo(9_000);
    expect(health).toEqual([]);
    timers.advanceTo(12_000);
    expect(health.map((h) => h.ok)).toEqual([false]);
    timers.advanceTo(60_000);
    expect(health).toHaveLength(1);
  });

  it("counts only from when the registry lists the CLI, so an unanswered trust dialog isn't a failure", () => {
    const { timers, health } = healthHarness((ms) => (ms < 30_000 ? null : "idle"));
    timers.advanceTo(35_000);
    expect(health).toEqual([]);
    timers.advanceTo(42_000);
    expect(health.map((h) => h.ok)).toEqual([false]);
  });

  it("never fires once a delivery has arrived", () => {
    const { timers, health, attention } = healthHarness(() => "idle");
    timers.advanceTo(500);
    attention.handle(delivery({ hook_event_name: "SessionStart", source: "startup" }));
    timers.advanceTo(60_000);
    expect(health).toEqual([]);
  });

  it("reports the hooks running again when a late delivery arrives", () => {
    const { timers, health, attention } = healthHarness(() => "idle");
    timers.advanceTo(15_000);
    attention.handle(delivery({ hook_event_name: "UserPromptSubmit", prompt: "hi" }));
    expect(health.map((h) => h.ok)).toEqual([false, true]);
  });

  it("stops watching on stop()", () => {
    const { timers, health, attention } = healthHarness(() => "idle");
    attention.stop();
    timers.advanceTo(60_000);
    expect(health).toEqual([]);
  });
});

describe("found in cross-model review", () => {
  const stop = (extra: Record<string, unknown> = {}) =>
    delivery({ hook_event_name: "Stop", background_tasks: [], ...extra });

  it("a StopFailure while a subagent from an earlier Stop still runs waits for it", () => {
    let status = "busy";
    const { timers, raised, attention } = harness(() => status);
    attention.handle(
      stop({
        background_tasks: [
          { id: "a1", type: "subagent", status: "running" },
          { id: "a2", type: "subagent", status: "running" },
        ],
      })
    );
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a1" }));
    attention.handle(delivery({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>" }));
    attention.handle(delivery({ hook_event_name: "StopFailure", error: "server_error" }));
    timers.advanceTo(60_000);
    expect(raised).toEqual([]);

    // The last subagent ends; no wake-up comes (the API is still failing), the
    // registry settles, and the grace period confirms the one real finish.
    attention.handle(delivery({ hook_event_name: "SubagentStop", agent_id: "a2" }));
    status = "idle";
    timers.advanceTo(62_000);
    expect(raised).toEqual([]);
    timers.advanceTo(64_000);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("a StopFailure with nothing running still finishes at once", () => {
    const { raised, attention } = harness(() => "idle");
    attention.handle(stop());
    attention.handle(delivery({ hook_event_name: "UserPromptSubmit", prompt: "again" }));
    attention.handle(delivery({ hook_event_name: "StopFailure", error: "rate_limit" }));
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });

  it("a slash-command panel opened during the settle window delays the finish, never loses it", () => {
    // /cost and friends read `waiting` ("dialog open") with no hook at all.
    let status = "busy";
    const { timers, raised, attention } = harness(() => status);
    attention.handle(stop());
    timers.advanceTo(50);
    status = "idle";
    timers.advanceTo(100);
    status = "waiting";
    timers.advanceTo(5_000);
    expect(raised).toEqual([]);
    status = "idle";
    timers.advanceTo(5_500);
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
  });
});
