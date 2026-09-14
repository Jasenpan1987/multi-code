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
  sent: Array<{ id: string; text: string }>;
}
type ToolLike = ReturnType<typeof buildWriteTools>[number];

function harness(
  instances: InstanceInfo[] = [instance()],
  verdict: WriteVerdict = { ok: true }
): Harness {
  const sent: Array<{ id: string; text: string }> = [];
  const host: ManagerWriteHost = {
    listInstances: () => instances,
    sendTask: (id, text) => {
      // A real host refuses before writing; this records only what got through.
      if (!verdict.ok) return verdict;
      sent.push({ id, text });
      return { ok: true };
    },
  };
  const tool = buildWriteTools(host).find((t) => t.name === "send_task")!;
  return { tool, sent };
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
});
