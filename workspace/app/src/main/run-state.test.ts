// The states an instance moves through, as the quit confirmation and a paired phone
// read them.

import { describe, expect, it } from "vitest";
import { RunStateTracker } from "./run-state";

function tracker(...activity: string[]) {
  const t = new RunStateTracker();
  for (const a of activity) t.onActivity(a);
  return t;
}

describe("state transitions", () => {
  it("starts in `starting`, before anything has been heard", () => {
    expect(new RunStateTracker().state()).toBe("starting");
  });

  it("`waiting` means the turn ended: idle", () => {
    expect(tracker("waiting").state()).toBe("idle");
  });

  it("`prompt` means a dialog is up: blocked", () => {
    expect(tracker("waiting", "prompt").state()).toBe("blocked");
  });

  it("`prompt-cleared` goes back to busy, not idle", () => {
    // The dialog was answered, so it resumed working. Only `waiting` means idle.
    expect(tracker("prompt", "prompt-cleared").state()).toBe("busy");
  });

  it("a write marks it busy", () => {
    const t = tracker("waiting");
    t.onWrite();
    expect(t.state()).toBe("busy");
  });

  it("a write while blocked leaves it busy, not blocked", () => {
    // That write answered the dialog, whether it meant to or not, so it isn't
    // parked any more.
    const t = tracker("prompt");
    t.onWrite();
    expect(t.state()).toBe("busy");
  });

  it("an exit resets to starting", () => {
    const t = tracker("waiting");
    t.onExit();
    expect(t.state()).toBe("starting");
  });

  it("ignores event types it doesn't model", () => {
    expect(tracker("waiting", "something-new").state()).toBe("idle");
  });
});
