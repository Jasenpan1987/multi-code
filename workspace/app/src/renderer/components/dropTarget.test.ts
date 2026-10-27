import { describe, expect, it } from "vitest";
import { dropState } from "./dropTarget";
import type { Instance } from "../../shared/types";

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "a",
    cwd: "/tmp/project",
    name: "project",
    status: "stopped",
    startedAt: 0,
    backend: "claude",
    ...overrides,
  };
}

describe("dropState", () => {
  it("targets the selected contact", () => {
    const selected = instance();
    expect(dropState(selected, false)).toEqual({ kind: "target", instance: selected });
  });

  it("targets a running contact as well as a stopped one", () => {
    const selected = instance({ status: "running" });
    expect(dropState(selected, false)).toEqual({ kind: "target", instance: selected });
  });

  it("refuses the Manager", () => {
    expect(dropState(instance({ isManager: true }), false)).toEqual({
      kind: "refused",
      reason: "manager",
    });
  });

  it("refuses when no contact is selected", () => {
    expect(dropState(null, false)).toEqual({ kind: "refused", reason: "no-selection" });
    expect(dropState(undefined, false)).toEqual({ kind: "refused", reason: "no-selection" });
  });

  it("does nothing while a dialog is open, whatever is selected", () => {
    expect(dropState(instance(), true)).toEqual({ kind: "none" });
    expect(dropState(instance({ isManager: true }), true)).toEqual({ kind: "none" });
    expect(dropState(null, true)).toEqual({ kind: "none" });
  });
});
