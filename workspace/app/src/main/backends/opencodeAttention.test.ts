// Replays the events OpenCode 1.18.35 sent through the plugin (T-409 fixtures)
// through OpencodePluginAttention and checks the exact activity each scenario
// raises. Each fixture event goes through what production does to it: kept only if
// the plugin forwards that type, shaped into the plugin's body, parsed by the real
// `/alert` parser. The fixtures are the evidence; a rule changed here without one to
// back it is a guess.

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { OpencodePluginAttention } from "./opencodeAttention";
import { OPENCODE_INIT_EVENT, OPENCODE_PLUGIN_EVENTS } from "./opencodePlugin";
import { MULTI_QUESTION_TOOL_LABEL, PERMISSION_TOOL, QUESTION_TOOL_LABEL } from "./opencodePrompt";
import { parseAlertDelivery } from "../manager-mcp/server";
import type { HookTimers } from "./claudeHooks";
import type { AlertDelivery } from "./types";
import type { PromptDetail } from "../remote/promptExtract";

const FIXTURES = path.join(__dirname, "__fixtures__/opencode-plugin");

interface Fixture {
  opencode: string;
  scenario: string;
  events: { ms: number; type: string; properties: Record<string, unknown> }[];
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

function harness() {
  const timers = new VirtualTimers();
  const raised: Raised[] = [];
  const health: boolean[] = [];
  const attention = new OpencodePluginAttention(
    (type, detail) => raised.push({ ms: timers.now, type, detail }),
    timers,
    (ok) => health.push(ok)
  );
  const types = () => raised.map((r) => r.type);
  return { timers, raised, health, attention, types };
}

// The body the plugin posts for an event, through the real parser.
function delivery(type: string, properties: Record<string, unknown> = {}): AlertDelivery {
  const info = properties.info as { id?: string } | undefined;
  const body = {
    hook_event_name: type,
    session_id: (properties.sessionID as string | undefined) ?? info?.id,
    pid: 1,
    properties,
  };
  const parsed = parseAlertDelivery("inst-1", JSON.stringify(body), "spawn-1");
  if (!parsed) throw new Error(`unparseable delivery: ${type}`);
  return parsed;
}

const FORWARDED = new Set<string>(OPENCODE_PLUGIN_EVENTS);

function replay(name: string) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
  const { timers, raised, attention, types } = harness();
  const events = fixture.events.filter((e) => FORWARDED.has(e.type));
  for (const e of events) {
    timers.advanceTo(e.ms);
    attention.handle(delivery(e.type, e.properties));
  }
  attention.stop();
  return { fixture, events, raised, types: types() };
}

// Each status change of one session, for the synthetic cases below.
const status = (sessionID: string, type: string) =>
  delivery("session.status", { sessionID, status: { type } });
const child = (id: string, parentID = "root") =>
  delivery("session.created", { sessionID: id, info: { id, parentID } });
const permission = (id: string, sessionID = "root") =>
  delivery("permission.asked", { id, sessionID, permission: "bash", patterns: ["touch a.txt"] });
const replied = (requestID: string, reply = "once", sessionID = "root") =>
  delivery("permission.replied", { sessionID, requestID, reply });

describe("replaying OpenCode's own events", () => {
  it.each([["plain-finish"], ["long-bash"], ["unknown-model-fallback"]])(
    "%s: one finish, at the root's idle",
    (name) => {
      const { types, raised, events } = replay(name);
      expect(types).toEqual(["waiting"]);
      const idle = events.find(
        (e) => e.type === "session.status" && (e.properties.status as { type: string }).type === "idle"
      );
      expect(raised[0].ms).toBe(idle?.ms);
    }
  );

  it("subagent: nothing when the subagent goes idle, one finish when the root does", () => {
    const { types, raised, events } = replay("subagent");
    const idles = events.filter(
      (e) => e.type === "session.status" && (e.properties.status as { type: string }).type === "idle"
    );
    expect(idles).toHaveLength(2);
    expect(types).toEqual(["waiting"]);
    expect(raised[0].ms).toBe(idles[1].ms);
  });

  it("permission-always: needs you, then a finish for each of its two turns", () => {
    // The second turn's touch runs without asking: the first answer allowed `touch *`.
    expect(replay("permission-always").types).toEqual([
      "prompt",
      "prompt-cleared",
      "waiting",
      "waiting",
    ]);
  });

  it.each([
    ["permission-once"],
    ["subagent-permission"],
    ["question"],
    ["question-multi"],
  ])("%s: needs you, cleared when answered, then one finish", (name) => {
    expect(replay(name).types).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it.each([["permission-reject"], ["permission-esc"], ["question-esc"]])(
    "%s: needs you, and the builder ending the turn raises nothing more",
    (name) => {
      expect(replay(name).types).toEqual(["prompt", "prompt-cleared"]);
    }
  );

  it("esc-interrupt: an abort raises nothing, though OpenCode reports idle twice", () => {
    expect(replay("esc-interrupt").types).toEqual([]);
  });

  it.each([["api-error-400"], ["api-error-429"]])(
    "%s: a turn that dies on an API error finishes once (G-002), retries included",
    (name) => {
      expect(replay(name).types).toEqual(["waiting"]);
    }
  );

  it("raises needs-you at the dialog's own event, not later", () => {
    const { events, raised } = replay("permission-once");
    expect(raised[0].ms).toBe(events.find((e) => e.type === "permission.asked")?.ms);
  });
});

describe("prompt detail for a paired phone", () => {
  it("a permission names what is asked", () => {
    const detail = replay("permission-once").raised[0].detail;
    expect(detail?.tool).toBe(PERMISSION_TOOL);
    expect(detail?.question).toBe("Permission required: bash: touch a.txt");
  });

  it("a subagent's permission is offered the same way", () => {
    expect(replay("subagent-permission").raised[0].detail?.tool).toBe(PERMISSION_TOOL);
  });

  it("a question carries its options", () => {
    const detail = replay("question").raised[0].detail;
    expect(detail?.tool).toBe(QUESTION_TOOL_LABEL);
    expect(detail?.options.map((o) => o.label)).toEqual(["tea", "coffee", "Type your own answer"]);
  });

  it("a box with two questions is shown read-only", () => {
    expect(replay("question-multi").raised[0].detail?.tool).toBe(MULTI_QUESTION_TOOL_LABEL);
  });
});

describe("rules the fixtures don't reach", () => {
  it("a resumed root session, with no session.created, still finishes", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(status("root", "idle"));
    expect(types()).toEqual(["waiting"]);
  });

  it("an idle without a busy before it raises nothing", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "idle"));
    expect(types()).toEqual([]);
  });

  it("a subagent going idle never finishes, whatever the root does meanwhile", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(child("kid"));
    attention.handle(status("kid", "busy"));
    attention.handle(status("kid", "idle"));
    attention.handle(status("kid", "idle"));
    expect(types()).toEqual([]);
  });

  it("a child marked only by session.updated still counts as a child", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(delivery("session.updated", { sessionID: "kid", info: { id: "kid", parentID: "root" } }));
    attention.handle(status("kid", "busy"));
    attention.handle(status("kid", "idle"));
    expect(types()).toEqual([]);
  });

  it("a retry status is not a finish", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(status("root", "retry"));
    attention.handle(status("root", "busy"));
    expect(types()).toEqual([]);
  });

  it("the turn after one the builder ended finishes normally", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(permission("p1"));
    attention.handle(replied("p1", "reject"));
    attention.handle(status("root", "idle"));
    attention.handle(status("root", "busy"));
    attention.handle(status("root", "idle"));
    expect(types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("a turn that goes on after a subagent's dialog was rejected still finishes", () => {
    // Unmeasured whether OpenCode carries on here; if it does, the root goes busy
    // again, and that busy is what keeps the finish.
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(child("kid"));
    attention.handle(permission("p1", "kid"));
    attention.handle(replied("p1", "reject", "kid"));
    attention.handle(status("kid", "idle"));
    attention.handle(status("root", "busy"));
    attention.handle(status("root", "idle"));
    expect(types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("an abort while a dialog is open clears it, and raises no finish", () => {
    // OpenCode sends no reply for the dialog then.
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(permission("p1"));
    attention.handle(delivery("session.error", { sessionID: "root", error: { name: "MessageAbortedError" } }));
    attention.handle(status("root", "idle"));
    attention.handle(status("root", "idle"));
    expect(types()).toEqual(["prompt", "prompt-cleared"]);
  });

  it("an error clears its session's open dialog even with no idle after it", () => {
    // A compaction overflow publishes session.error without going idle (source
    // research, 1.18.34).
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(child("kid"));
    attention.handle(permission("p1", "kid"));
    attention.handle(delivery("session.error", { sessionID: "kid", error: { name: "ContextOverflowError" } }));
    expect(types()).toEqual(["prompt", "prompt-cleared"]);
  });

  it("a subagent's open dialog is cleared when the subagent goes idle", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(child("kid"));
    attention.handle(permission("p1", "kid"));
    attention.handle(status("kid", "idle"));
    expect(types()).toEqual(["prompt", "prompt-cleared"]);
  });

  it("two dialogs open at once stay needs-you until both are answered", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(child("a"));
    attention.handle(child("b"));
    attention.handle(permission("p1", "a"));
    attention.handle(permission("p2", "b"));
    attention.handle(replied("p1", "once", "a"));
    expect(types()).toEqual(["prompt", "prompt"]);
    attention.handle(replied("p2", "once", "b"));
    expect(types()).toEqual(["prompt", "prompt", "prompt-cleared"]);
  });

  it("the root going idle clears every dialog still open", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.handle(child("kid"));
    attention.handle(permission("p1", "kid"));
    attention.handle(status("root", "idle"));
    expect(types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("listens for the v2 event names too", () => {
    const { attention, types } = harness();
    attention.handle(delivery("permission.v2.asked", { id: "p1", sessionID: "root" }));
    attention.handle(delivery("permission.v2.replied", { requestID: "p1", sessionID: "root", reply: "once" }));
    attention.handle(delivery("question.v2.asked", { id: "q1", sessionID: "root" }));
    attention.handle(delivery("question.v2.rejected", { requestID: "q1", sessionID: "root" }));
    expect(types()).toEqual(["prompt", "prompt-cleared", "prompt", "prompt-cleared"]);
  });

  it("raises nothing after stop()", () => {
    const { attention, types } = harness();
    attention.handle(status("root", "busy"));
    attention.stop();
    attention.handle(status("root", "idle"));
    attention.handle(permission("p1"));
    expect(types()).toEqual([]);
  });
});

describe("found in cross-model review", () => {
  // One OpenCode can run several root sessions at once: switch session in the TUI
  // and send another message while the first still works.
  it("an abort in one root doesn't silence another root's finish", () => {
    const { attention, types } = harness();
    attention.handle(status("a", "busy"));
    attention.handle(status("b", "busy"));
    attention.handle(delivery("session.error", { sessionID: "a", error: { name: "MessageAbortedError" } }));
    attention.handle(status("b", "idle"));
    expect(types()).toEqual(["waiting"]);
    attention.handle(status("a", "idle"));
    expect(types()).toEqual(["waiting"]);
  });

  it("a subagent's rejected dialog silences only its own root", () => {
    const { attention, types } = harness();
    attention.handle(status("a", "busy"));
    attention.handle(status("b", "busy"));
    attention.handle(child("kid", "a"));
    attention.handle(permission("p1", "kid"));
    attention.handle(replied("p1", "reject", "kid"));
    attention.handle(status("b", "idle"));
    attention.handle(status("a", "idle"));
    expect(types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("a root's idle leaves another root's open dialog alone, and says it is still open", () => {
    // The finish alone would set run state idle and open the write gate onto B's
    // dialog; the prompt raised again right after puts it back to blocked.
    const { attention, types, raised } = harness();
    attention.handle(status("a", "busy"));
    attention.handle(status("b", "busy"));
    attention.handle(permission("p1", "b"));
    attention.handle(status("a", "idle"));
    expect(types()).toEqual(["prompt", "waiting", "prompt"]);
    expect(raised[2].detail).toEqual(raised[0].detail);
    attention.handle(replied("p1", "once", "b"));
    expect(types()).toEqual(["prompt", "waiting", "prompt", "prompt-cleared"]);
  });

  it("a finish with no other dialog open raises nothing after it", () => {
    const { attention, types } = harness();
    attention.handle(status("a", "busy"));
    attention.handle(permission("p1", "a"));
    attention.handle(replied("p1"));
    attention.handle(status("a", "idle"));
    expect(types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });
});

describe("plugin health", () => {
  it("says the plugin isn't running when nothing arrives within 10s of spawn", () => {
    const { timers, health } = harness();
    timers.advanceTo(9_000);
    expect(health).toEqual([]);
    timers.advanceTo(10_000);
    expect(health).toEqual([false]);
    timers.advanceTo(60_000);
    expect(health).toEqual([false]);
  });

  it("never fires once the plugin's init has arrived", () => {
    const { timers, health, attention } = harness();
    timers.advanceTo(2_000);
    attention.handle(delivery(OPENCODE_INIT_EVENT));
    timers.advanceTo(60_000);
    expect(health).toEqual([]);
  });

  it("reports the plugin running again when a late delivery arrives", () => {
    const { timers, health, attention } = harness();
    timers.advanceTo(15_000);
    attention.handle(delivery(OPENCODE_INIT_EVENT));
    expect(health).toEqual([false, true]);
  });

  it("stops watching on stop()", () => {
    const { timers, health, attention } = harness();
    attention.stop();
    timers.advanceTo(60_000);
    expect(health).toEqual([]);
  });
});
