// The interesting cases are the early exits. A wait that only ever resolves on a
// clean finish leaves the manager sitting out a five-minute timeout on a session
// that has been parked on a dialog since the first second — which is the slow,
// silent behaviour this tool exists to remove.

import { describe, expect, it, vi } from "vitest";
import { buildWaitTools, clampTimeout, type ManagerWaitHost } from "./wait-tools";
import type { InstanceInfo } from "../process-manager";
import type { RunState } from "../run-state";

function instance(over: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: "id-1",
    cwd: "/Users/x/code/msk",
    name: "msk",
    status: "running",
    startedAt: 1000,
    backend: "claude",
    sessionId: "ses-1",
    runState: "busy",
    ...over,
  };
}

interface Harness {
  tool: ReturnType<typeof buildWaitTools>[number];
  emit: (id: string, type: string) => void;
  listenerCount: () => number;
}

function harness(
  instances: InstanceInfo[] = [instance()],
  state: RunState | undefined = "busy"
): Harness {
  const listeners = new Set<(id: string, type: string) => void>();
  const host: ManagerWaitHost = {
    listInstances: () => instances,
    runStateOf: () => state,
    onActivity: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    tool: buildWaitTools(host)[0],
    emit: (id, type) => {
      // A listener unsubscribing mid-iteration is the normal case here, and
      // deleting the current entry of a Set while iterating it is well-defined.
      for (const l of listeners) l(id, type);
    },
    listenerCount: () => listeners.size,
  };
}

describe("wait_for_idle — resolving", () => {
  it("resolves when the turn ends", async () => {
    const h = harness();
    const pending = h.tool.handler({ name: "msk" });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));
    h.emit("id-1", "waiting");
    await expect(pending).resolves.toMatch(/msk finished after/);
  });

  it("resolves early when the session blocks on a decision", async () => {
    const h = harness();
    const pending = h.tool.handler({ name: "msk" });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));
    h.emit("id-1", "prompt");
    const out = await pending;
    expect(out).toMatch(/only the user can make/);
    expect(out).toMatch(/read_session/);
  });

  it("resolves when the session exits mid-turn", async () => {
    const h = harness();
    const pending = h.tool.handler({ name: "msk" });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));
    h.emit("id-1", "exit");
    await expect(pending).resolves.toMatch(/exited after .* without finishing/);
  });

  it("ignores activity from a different session", async () => {
    const h = harness([instance(), instance({ id: "id-2", name: "other" })]);
    const pending = h.tool.handler({ name: "msk", timeoutMs: 1000 });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));
    h.emit("id-2", "waiting");
    // Still waiting, so the only way out is the timeout.
    await expect(pending).resolves.toMatch(/still working/);
  });

  it("ignores the bookkeeping events", async () => {
    const h = harness();
    const pending = h.tool.handler({ name: "msk", timeoutMs: 1000 });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));
    h.emit("id-1", "prompt-cleared");
    await expect(pending).resolves.toMatch(/still working/);
  });
});

describe("wait_for_idle — not leaving anything behind", () => {
  it("detaches its listener once resolved", async () => {
    const h = harness();
    const pending = h.tool.handler({ name: "msk" });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));
    h.emit("id-1", "waiting");
    await pending;
    expect(h.listenerCount()).toBe(0);
  });

  it("detaches its listener on timeout too", async () => {
    const h = harness();
    await h.tool.handler({ name: "msk", timeoutMs: 1000 });
    expect(h.listenerCount()).toBe(0);
  });

  it("resolves only once when several events arrive", async () => {
    const h = harness();
    const pending = h.tool.handler({ name: "msk" });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));
    h.emit("id-1", "waiting");
    h.emit("id-1", "prompt");
    h.emit("id-1", "exit");
    await expect(pending).resolves.toMatch(/finished/);
  });
});

describe("wait_for_idle — states it answers without waiting", () => {
  it("returns immediately when the session is already idle, and says so", async () => {
    // A manager that reads a bare "idle" as "done" reports success for a task that
    // never reached the session.
    const h = harness([instance({ runState: "idle" })], "idle");
    const out = await h.tool.handler({ name: "msk" });
    expect(out).toMatch(/already idle/);
    expect(out).toMatch(/did not reach it/);
    expect(h.listenerCount()).toBe(0);
  });

  it("returns immediately when the session is already blocked", async () => {
    const h = harness([instance({ runState: "blocked" })], "blocked");
    const out = await h.tool.handler({ name: "msk" });
    expect(out).toMatch(/only the user can make/);
    expect(h.listenerCount()).toBe(0);
  });

  it("refuses a stopped session instead of waiting forever", async () => {
    const h = harness([instance({ status: "stopped" })], undefined);
    await expect(h.tool.handler({ name: "msk" })).rejects.toThrow(
      /will never become idle/
    );
  });

  it("refuses an unknown name and lists what exists", async () => {
    const h = harness();
    await expect(h.tool.handler({ name: "ghost" })).rejects.toThrow(/msk/);
  });
});

describe("wait_for_idle — a timeout is not a failure", () => {
  // Handed an error, a model reports the task as failed. It hasn't: the session is
  // still working, and the only thing that ran out was our patience.
  it("resolves rather than throwing on timeout", async () => {
    const h = harness();
    const out = await h.tool.handler({ name: "msk", timeoutMs: 1000 });
    expect(out).toMatch(/gave up waiting, it did not fail/);
  });

  it("clamps a timeout to something sane", () => {
    expect(clampTimeout(undefined)).toBe(300_000);
    expect(clampTimeout("soon")).toBe(300_000);
    expect(clampTimeout(NaN)).toBe(300_000);
    expect(clampTimeout(0)).toBe(1_000);
    expect(clampTimeout(-5)).toBe(1_000);
    expect(clampTimeout(99_999_999)).toBe(900_000);
    expect(clampTimeout(4_500.7)).toBe(4_500);
  });
});

describe("wait_for_idle — the description steers the model", () => {
  it("says to use this instead of repeated reads", () => {
    const { tool } = harness();
    expect(tool.description).toMatch(/instead of reading the session over and over/);
    expect(tool.description).toMatch(/each one costs you a whole turn/);
  });
});
