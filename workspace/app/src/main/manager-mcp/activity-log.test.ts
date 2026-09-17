// The feed is a safety requirement, not a convenience, so the load-bearing tests
// here are the ones about refusals and about a call being visible *before* it
// finishes. A log that only recorded successes, or only recorded on completion,
// would look fine in the UI and still hide the thing the user is watching for.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagerActivityLog, managerActivityLog } from "./activity-log";
import { ManagerMcpServer, type ToolDefinition } from "./server";
import type { ManagerActivityEntry } from "../../shared/types";

describe("ManagerActivityLog", () => {
  it("records a call as running before it has an outcome", () => {
    const log = new ManagerActivityLog();
    log.start("send_task", { name: "portals", text: "run the tests" });

    const [entry] = log.list();
    expect(entry.tool).toBe("send_task");
    expect(entry.status).toBe("running");
    expect(entry.result).toBeUndefined();
    expect(entry.durationMs).toBeUndefined();
  });

  it("pulls the target session out of the arguments", () => {
    const log = new ManagerActivityLog();
    log.start("read_session", { name: "multi-code", limit: 30 });
    expect(log.list()[0].target).toBe("multi-code");
  });

  it("leaves target unset for a tool that takes no session", () => {
    const log = new ManagerActivityLog();
    log.start("list_sessions", {});
    expect(log.list()[0].target).toBeUndefined();
  });

  it("ignores a blank name rather than showing an empty target", () => {
    const log = new ManagerActivityLog();
    log.start("read_session", { name: "   " });
    expect(log.list()[0].target).toBeUndefined();
  });

  it("keeps the arguments verbatim as the payload", () => {
    const log = new ManagerActivityLog();
    log.start("send_task", { name: "api", text: "bump the version" });
    expect(log.list()[0].payload).toBe(
      '{"name":"api","text":"bump the version"}'
    );
  });

  it("shows no payload for a no-argument tool", () => {
    const log = new ManagerActivityLog();
    log.start("list_sessions", {});
    expect(log.list()[0].payload).toBe("");
  });

  it("marks a successful call ok and keeps what it returned", () => {
    const log = new ManagerActivityLog();
    const id = log.start("list_sessions", {});
    log.finish(id, { ok: true, text: "3 sessions" });

    const [entry] = log.list();
    expect(entry.status).toBe("ok");
    expect(entry.result).toBe("3 sessions");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  // The reason is the whole point of recording a refusal: "send_task failed" tells
  // the user nothing they can act on, "waiting on a decision from you" does.
  it("marks a refused call error and keeps the reason", () => {
    const log = new ManagerActivityLog();
    const id = log.start("send_task", { name: "api", text: "go" });
    log.finish(id, {
      ok: false,
      text: "api is waiting on a decision from you",
    });

    const [entry] = log.list();
    expect(entry.status).toBe("error");
    expect(entry.result).toBe("api is waiting on a decision from you");
  });

  it("lists newest first", () => {
    const log = new ManagerActivityLog();
    log.start("first", {});
    log.start("second", {});
    expect(log.list().map((e) => e.tool)).toEqual(["second", "first"]);
  });

  it("drops the oldest entries past the cap", () => {
    const log = new ManagerActivityLog();
    for (let i = 0; i < 260; i++) log.start(`t${i}`, {});

    const entries = log.list();
    expect(entries).toHaveLength(200);
    expect(entries[0].tool).toBe("t259");
    expect(entries[199].tool).toBe("t60");
  });

  it("ignores a finish for an entry that has already fallen off", () => {
    const log = new ManagerActivityLog();
    const id = log.start("old", {});
    for (let i = 0; i < 200; i++) log.start(`t${i}`, {});
    expect(() => log.finish(id, { ok: true, text: "late" })).not.toThrow();
  });

  it("truncates a payload too large to keep whole", () => {
    const log = new ManagerActivityLog();
    log.start("send_task", { text: "x".repeat(10_000) });

    const { payload } = log.list()[0];
    expect(payload.length).toBeLessThan(4100);
    expect(payload.endsWith("…")).toBe(true);
  });

  it("truncates an oversized result too", () => {
    const log = new ManagerActivityLog();
    const id = log.start("read_session", { name: "big" });
    log.finish(id, { ok: true, text: "y".repeat(10_000) });

    const { result } = log.list()[0];
    expect(result?.length).toBeLessThan(4100);
    expect(result?.endsWith("…")).toBe(true);
  });

  // list() hands entries to the renderer over IPC while finish() keeps mutating
  // the originals. Returning the stored objects would let a caller's copy change
  // under it, or let the caller corrupt the log.
  it("hands out copies, not the stored entries", () => {
    const log = new ManagerActivityLog();
    const id = log.start("list_sessions", {});
    const snapshot = log.list()[0];
    log.finish(id, { ok: true, text: "done" });

    expect(snapshot.status).toBe("running");
    snapshot.tool = "tampered";
    expect(log.list()[0].tool).toBe("list_sessions");
  });

  it("notifies the listener when a call starts and again when it ends", () => {
    const log = new ManagerActivityLog();
    const seen: ManagerActivityEntry[] = [];
    log.setListener((entry) => seen.push(entry));

    const id = log.start("send_task", { name: "api", text: "go" });
    log.finish(id, { ok: true, text: "Sent to api." });

    expect(seen.map((e) => e.status)).toEqual(["running", "ok"]);
    // Same id both times, so the renderer updates the row rather than adding one.
    expect(seen[0].id).toBe(seen[1].id);
  });

  it("stops notifying once the listener is cleared", () => {
    const log = new ManagerActivityLog();
    let count = 0;
    log.setListener(() => count++);
    log.start("a", {});
    log.setListener(null);
    log.start("b", {});
    expect(count).toBe(1);
  });
});

// The choke point matters more than the log itself: the feed is only trustworthy
// if a tool cannot be called without passing through it. These drive the real
// server over its socket, the same path the CLI takes.
describe("recording through the server", () => {
  let server: ManagerMcpServer | null = null;

  beforeEach(() => {
    managerActivityLog.reset();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    managerActivityLog.setListener(null);
  });

  async function callTool(tool: ToolDefinition, args: Record<string, unknown>) {
    const s = new ManagerMcpServer();
    s.registerTool(tool);
    await s.start();
    server = s;
    const res = await fetch(s.getEndpoint() as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${s.getToken()}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool.name, arguments: args },
      }),
    });
    return res.json();
  }

  it("records a successful tool call", async () => {
    await callTool(
      {
        name: "list_sessions",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        handler: () => "2 sessions",
      },
      {}
    );

    const [entry] = managerActivityLog.list();
    expect(entry.tool).toBe("list_sessions");
    expect(entry.status).toBe("ok");
    expect(entry.result).toBe("2 sessions");
  });

  // A refusal reaches the model as a thrown handler, so this is the path every
  // blocked write travels. If it were invisible in the feed, the manager could be
  // refused all day and the user would never see it.
  it("records a refused tool call with its reason", async () => {
    await callTool(
      {
        name: "send_task",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        handler: () => {
          throw new Error("api is waiting on a decision from you");
        },
      },
      { name: "api", text: "go" }
    );

    const [entry] = managerActivityLog.list();
    expect(entry.tool).toBe("send_task");
    expect(entry.target).toBe("api");
    expect(entry.status).toBe("error");
    expect(entry.result).toBe("api is waiting on a decision from you");
    expect(entry.payload).toContain("go");
  });

  it("records a call for a tool that does not exist", async () => {
    const s = new ManagerMcpServer();
    await s.start();
    server = s;
    await fetch(s.getEndpoint() as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${s.getToken()}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "nope", arguments: {} },
      }),
    });

    const [entry] = managerActivityLog.list();
    expect(entry.tool).toBe("nope");
    expect(entry.status).toBe("error");
    expect(entry.result).toContain("Unknown tool");
  });

  // A tool that waits on another session can run for minutes. The row has to
  // exist while it is still working, or the feed is blank during exactly the
  // stretch the user is watching.
  it("shows a slow call as running before it returns", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = callTool(
      {
        name: "wait_for_idle",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          await gate;
          return "idle";
        },
      },
      { name: "api" }
    );

    // Poll rather than sleep a fixed amount: the entry appears as soon as the
    // request reaches the handler, and the socket round-trip has no fixed cost.
    let entry: ManagerActivityEntry | undefined;
    for (let i = 0; i < 100 && !entry; i++) {
      entry = managerActivityLog.list()[0];
      if (!entry) await new Promise((r) => setTimeout(r, 10));
    }

    expect(entry?.status).toBe("running");
    release();
    await pending;
    expect(managerActivityLog.list()[0].status).toBe("ok");
  });
});

// The manager's own tool calls, which arrive as two separate hook deliveries
// sharing a tool_use_id rather than as one call we control from start to finish.
describe("ManagerActivityLog — the manager's own calls", () => {
  it("marks a dispatch and a hands-on call differently", () => {
    const log = new ManagerActivityLog();
    log.start("send_task", { name: "portals", text: "run the tests" });
    log.startSelf("toolu_1", "Bash", { payload: "git log" });

    const byTool = new Map(log.list().map((e) => [e.tool, e.origin]));
    // A dispatch also shows up in the target session's own terminal. A hands-on
    // call happened nowhere else the user can see, which is the distinction.
    expect(byTool.get("send_task")).toBe("mcp");
    expect(byTool.get("Bash")).toBe("self");
  });

  it("closes the entry belonging to the key", () => {
    const log = new ManagerActivityLog();
    log.startSelf("toolu_a", "Bash", { payload: "pnpm test" });
    log.startSelf("toolu_b", "Bash", { payload: "git status" });

    expect(log.finishSelf("toolu_a", { ok: true, text: "528 passed" })).toBe(true);
    const byPayload = new Map(log.list().map((e) => [e.payload, e]));
    expect(byPayload.get("pnpm test")?.status).toBe("ok");
    expect(byPayload.get("git status")?.status).toBe("running");
  });

  it("reports a key it never opened rather than closing something else", () => {
    const log = new ManagerActivityLog();
    log.startSelf("toolu_a", "Bash", { payload: "pnpm test" });
    expect(log.finishSelf("toolu_unknown", { ok: true, text: "" })).toBe(false);
    expect(log.list()[0].status).toBe("running");
  });

  it("keeps both entries when a key arrives twice", () => {
    // Ids come from the CLI and are unique per call, so a duplicate means
    // something is replaying deliveries — and losing the first entry would hide a
    // call that really happened.
    const log = new ManagerActivityLog();
    log.startSelf("toolu_dup", "Bash", { payload: "first" });
    log.startSelf("toolu_dup", "Bash", { payload: "second" });
    expect(log.list()).toHaveLength(2);
  });

  it("does not accumulate keys for calls that never report finishing", () => {
    // A PostToolUse that never arrives — the call was interrupted, or the app
    // stopped listening mid-call — must not leave its key behind forever.
    const log = new ManagerActivityLog();
    for (let i = 0; i < 400; i++) {
      log.startSelf(`toolu_${i}`, "Bash", { payload: `command ${i}` });
    }
    // The oldest keys have been dropped, the recent ones still pair.
    expect(log.finishSelf("toolu_0", { ok: true, text: "" })).toBe(false);
    expect(log.finishSelf("toolu_399", { ok: true, text: "" })).toBe(true);
  });

  it("pushes a hands-on call to the listener like any other", () => {
    // The feed is live because of this; an entry the renderer only sees on the
    // next mount is an entry the user misses while watching.
    const log = new ManagerActivityLog();
    const seen: ManagerActivityEntry[] = [];
    log.setListener((entry) => seen.push(entry));

    log.startSelf("toolu_live", "Edit", { payload: "src/main/index.ts" });
    log.finishSelf("toolu_live", { ok: true, text: "applied" });

    expect(seen.map((e) => e.status)).toEqual(["running", "ok"]);
    expect(seen[0].origin).toBe("self");
  });
});
