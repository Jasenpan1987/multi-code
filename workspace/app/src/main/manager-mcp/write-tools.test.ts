// The assertion that matters here is negative: when the gate refuses, nothing
// reaches the terminal. A tool that returns an error message while still having
// written the bytes would be worse than no gate at all, because it would look safe.

import { describe, expect, it } from "vitest";
import { buildWriteTools, type ManagerWriteHost } from "./write-tools";
import type { InstanceInfo } from "../process-manager";
import type { WriteVerdict } from "../run-state";

function instance(over: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: "id-1",
    cwd: "/Users/x/code/msk",
    name: "msk",
    status: "running",
    startedAt: 1000,
    backend: "claude",
    sessionId: "ses-1",
    runState: "idle",
    ...over,
  };
}

interface Harness {
  tool: ToolLike;
  toolNamed: (name: string) => ToolLike;
  sent: Array<{ id: string; text: string }>;
  commands: Array<{ id: string; command: string }>;
  started: string[];
}
type ToolLike = ReturnType<typeof buildWriteTools>[number];

function harness(
  instances: InstanceInfo[] = [instance()],
  verdict: WriteVerdict = { ok: true }
): Harness {
  const sent: Array<{ id: string; text: string }> = [];
  const commands: Array<{ id: string; command: string }> = [];
  const started: string[] = [];
  const host: ManagerWriteHost = {
    listInstances: () => instances,
    sendTask: (id, text) => {
      // A real host refuses before writing; this records only what got through.
      if (!verdict.ok) return verdict;
      sent.push({ id, text });
      return { ok: true };
    },
    runCommand: (id, command) => {
      if (!verdict.ok) return verdict;
      commands.push({ id, command });
      return { ok: true };
    },
    startSession: (id) => {
      started.push(id);
      const found = instances.find((i) => i.id === id);
      return found ? { ...found, status: "running" } : null;
    },
  };
  const tools = buildWriteTools(host);
  return {
    tool: tools.find((t) => t.name === "send_task")!,
    toolNamed: (name) => tools.find((t) => t.name === name)!,
    sent,
    commands,
    started,
  };
}

describe("send_task — the gate", () => {
  it("writes nothing when the target is blocked, and says why", () => {
    const h = harness([instance({ runState: "blocked" })], {
      ok: false,
      reason: "waiting on a decision from you (a permission prompt). Answer it first.",
    });
    expect(() => h.tool.handler({ name: "msk", text: "do the thing" })).toThrow(
      /waiting on a decision from you/
    );
    expect(h.sent).toHaveLength(0);
  });

  it("puts the session name in front of the reason so it reads as a sentence", () => {
    const h = harness([instance()], {
      ok: false,
      reason: "not running — start it in Multi-Code first",
    });
    expect(() => h.tool.handler({ name: "msk", text: "x" })).toThrow(
      /msk is not running/
    );
  });

  it("delivers to an idle target", () => {
    const h = harness();
    const out = h.tool.handler({ name: "msk", text: "run the tests" });
    expect(h.sent).toEqual([{ id: "id-1", text: "run the tests" }]);
    expect(out).toContain("Sent to msk");
  });

  it("delivers to a busy target — the CLI queues it", () => {
    // Measured 2026-09-02: the screen showed `queued` and the task ran after the
    // current turn. Refusing here would make the manager wait for no reason.
    const h = harness([instance({ runState: "busy" })]);
    h.tool.handler({ name: "msk", text: "next up" });
    expect(h.sent).toHaveLength(1);
  });

  it("tells the manager nothing will notify it", () => {
    // Otherwise it reports the task as done the moment it was sent.
    const out = harness().tool.handler({ name: "msk", text: "x" });
    expect(out).toMatch(/has not answered yet/);
    expect(out).toMatch(/read_session/);
  });
});

describe("send_task — addressing and arguments", () => {
  it("refuses an unknown name and lists what exists", () => {
    const h = harness();
    expect(() => h.tool.handler({ name: "ghost", text: "x" })).toThrow(/msk/);
    expect(h.sent).toHaveLength(0);
  });

  it("refuses to send to the manager itself", () => {
    const h = harness([instance({ name: "Manager", isManager: true })]);
    expect(() => h.tool.handler({ name: "Manager", text: "x" })).toThrow(
      /That is you/
    );
    expect(h.sent).toHaveLength(0);
  });

  it("refuses empty or whitespace-only text", () => {
    const h = harness();
    expect(() => h.tool.handler({ name: "msk", text: "" })).toThrow(/required/);
    expect(() => h.tool.handler({ name: "msk", text: "   " })).toThrow(/required/);
    expect(() => h.tool.handler({ name: "msk" })).toThrow(/required/);
    expect(h.sent).toHaveLength(0);
  });

  it("trims the text before sending", () => {
    const h = harness();
    h.tool.handler({ name: "msk", text: "  padded  " });
    expect(h.sent[0].text).toBe("padded");
  });

  it("resolves by name but sends by internal id", () => {
    const h = harness([instance({ id: "internal-9", name: "msk" })]);
    h.tool.handler({ name: "MSK", text: "x" });
    expect(h.sent[0].id).toBe("internal-9");
  });
});

describe("send_task — the description steers the model", () => {
  it("says not to use it for status questions", () => {
    // The whole cost argument of this feature: asking burns the target's turn,
    // reading is free. Without this the manager sends "how's it going?" messages.
    const { tool } = harness();
    expect(tool.description).toMatch(/do NOT use it to ask how something is going/);
    expect(tool.description).toMatch(/read_session answers that for free/);
  });

  it("says a queued message needs no retry", () => {
    const { tool } = harness();
    expect(tool.description).toMatch(/queues the message/);
    expect(tool.description).toMatch(/do not need to wait or retry/);
  });

  it("says the target cannot see this conversation", () => {
    const { tool } = harness();
    const text = JSON.stringify(tool.inputSchema);
    expect(text).toMatch(/cannot see this conversation/);
  });

  it("points at wait_for_idle rather than at re-reading", () => {
    // Polling read_session in a loop is what made the manager take minutes to
    // confirm a one-second command, because each poll costs it a whole turn.
    const out = harness().tool.handler({ name: "msk", text: "x" });
    expect(out).toMatch(/wait_for_idle/);
  });
});

describe("run_command — the allowlist", () => {
  it("runs an allowed command", () => {
    const h = harness();
    const out = h.toolNamed("run_command").handler({
      name: "msk",
      command: "/clear",
    });
    expect(h.commands).toEqual([{ id: "id-1", command: "/clear" }]);
    expect(out).toContain("Ran /clear in msk");
  });

  it("allows the commands the user asked for by name", () => {
    // /clear and /new were the two the user tried and could not get through, so a
    // regression here reintroduces the exact complaint.
    const h = harness();
    for (const command of ["/clear", "/new", "/compact", "/context", "/handoff"]) {
      h.toolNamed("run_command").handler({ name: "msk", command });
    }
    expect(h.commands.map((c) => c.command)).toEqual([
      "/clear",
      "/new",
      "/compact",
      "/context",
      "/handoff",
    ]);
  });

  it("refuses a command that is not on the list, naming the list", () => {
    const h = harness();
    expect(() =>
      h.toolNamed("run_command").handler({ name: "msk", command: "/exit" })
    ).toThrow(/not an allowed command/);
    expect(h.commands).toHaveLength(0);
  });

  // Exact match, so nothing can ride along behind an allowed command.
  it("refuses an allowed command carrying arguments", () => {
    const h = harness();
    expect(() =>
      h
        .toolNamed("run_command")
        .handler({ name: "msk", command: "/compact && rm -rf ." })
    ).toThrow(/not an allowed command/);
    expect(h.commands).toHaveLength(0);
  });

  it("refuses plain text with no leading slash", () => {
    const h = harness();
    expect(() =>
      h.toolNamed("run_command").handler({ name: "msk", command: "clear" })
    ).toThrow(/not an allowed command/);
    expect(h.commands).toHaveLength(0);
  });

  it("writes nothing when the gate refuses", () => {
    const h = harness([instance({ runState: "blocked" })], {
      ok: false,
      reason: "waiting on a decision from you",
    });
    expect(() =>
      h.toolNamed("run_command").handler({ name: "msk", command: "/clear" })
    ).toThrow(/msk is waiting on a decision/);
    expect(h.commands).toHaveLength(0);
  });

  it("refuses to run a command in the manager itself", () => {
    const h = harness([instance({ name: "Manager", isManager: true })]);
    expect(() =>
      h.toolNamed("run_command").handler({ name: "Manager", command: "/clear" })
    ).toThrow(/That is you/);
    expect(h.commands).toHaveLength(0);
  });

  it("warns that /clear leaves nothing to read afterwards", () => {
    // Otherwise the manager reads the now-empty transcript and reports failure.
    const out = harness()
      .toolNamed("run_command")
      .handler({ name: "msk", command: "/clear" });
    expect(out).toMatch(/leave nothing in the/);
  });

  it("steers toward /handoff over /clear in its description", () => {
    const { toolNamed } = harness();
    expect(toolNamed("run_command").description).toMatch(/Prefer \/handoff/);
  });
});

describe("start_session", () => {
  it("starts a stopped session", () => {
    const h = harness([instance({ status: "stopped", runState: undefined })]);
    const out = h.toolNamed("start_session").handler({ name: "msk" });
    expect(h.started).toEqual(["id-1"]);
    expect(out).toContain("Started msk");
  });

  it("is a no-op on one already running", () => {
    const h = harness();
    const out = h.toolNamed("start_session").handler({ name: "msk" });
    expect(h.started).toHaveLength(0);
    expect(out).toMatch(/already running/);
  });

  it("reports a start that failed rather than claiming success", () => {
    const h = harness([instance({ status: "stopped" })]);
    // A host that can't find the instance returns null — the shape a real failure
    // takes in startInstance.
    const host: ManagerWriteHost = {
      listInstances: () => [instance({ status: "stopped" })],
      sendTask: () => ({ ok: true }),
      runCommand: () => ({ ok: true }),
      startSession: () => null,
    };
    const tool = buildWriteTools(host).find((t) => t.name === "start_session")!;
    expect(() => tool.handler({ name: "msk" })).toThrow(/Could not start msk/);
    expect(h.started).toHaveLength(0);
  });

  it("refuses to start the manager itself", () => {
    const h = harness([
      instance({ name: "Manager", isManager: true, status: "stopped" }),
    ]);
    expect(() =>
      h.toolNamed("start_session").handler({ name: "Manager" })
    ).toThrow(/That is you/);
    expect(h.started).toHaveLength(0);
  });

  // The point of the tool. Its absence is why the manager kept telling the user to
  // go and start things by hand.
  it("tells the model that starting sessions is its job", () => {
    const { toolNamed } = harness();
    expect(toolNamed("start_session").description).toMatch(
      /instead of asking the user/
    );
  });

  it("warns that a fresh session has no history", () => {
    const h = harness([instance({ status: "stopped" })]);
    const out = h.toolNamed("start_session").handler({ name: "msk" });
    expect(out).toMatch(/no history to read/);
  });
});
