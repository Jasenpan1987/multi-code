// The measured hazard this gate exists for: on 2026-09-02 a PTY write to a session
// parked on a plan-approval dialog picked that dialog's highlighted default ("Yes,
// and use auto mode") and the session edited a real file. The payload was prose with
// no digits, so no amount of filtering the text would have helped.
//
// Everything below is really one assertion in different shapes: a target that might
// be sitting on a dialog is never writable.

import { describe, expect, it } from "vitest";
import { RunStateTracker, SUSPICIOUS_SILENCE_MS_FOR_TESTS as QUIET } from "./run-state";

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
    // The dialog was answered, so it resumed working. Only `waiting` means idle, and
    // treating a cleared prompt as idle would skip the silence check on the next
    // write.
    expect(tracker("prompt", "prompt-cleared").state()).toBe("busy");
  });

  it("a write marks it busy", () => {
    const t = tracker("waiting");
    t.onWrite();
    expect(t.state()).toBe("busy");
  });

  it("a write while blocked leaves it busy, not blocked", () => {
    // That write answered the dialog, whether we wanted it to or not, so it isn't
    // parked any more. The next write is then gated on silence rather than let
    // straight through.
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

describe("canAcceptWrite — the blocked case", () => {
  it("refuses a blocked target however long it has been quiet", () => {
    const t = tracker("prompt");
    for (const quiet of [0, 500, QUIET, 60_000]) {
      expect(t.canAcceptWrite(quiet).ok).toBe(false);
    }
  });

  it("says what the user has to do, not just no", () => {
    // The manager relays this to the user, so it has to be actionable.
    const v = tracker("prompt").canAcceptWrite(0);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/waiting on a decision from you/);
      expect(v.reason).toMatch(/would be read as the answer/);
    }
  });

  it("allows writes again once the prompt is cleared and it is noisy", () => {
    const t = tracker("prompt", "prompt-cleared");
    expect(t.canAcceptWrite(0).ok).toBe(true);
  });
});

describe("canAcceptWrite — idle", () => {
  it("allows an idle target no matter how long it has been quiet", () => {
    // Idle means it reported finishing and nothing has been sent since, so quiet is
    // exactly what's expected. Applying the silence check here would refuse every
    // legitimate write.
    const t = tracker("waiting");
    expect(t.canAcceptWrite(0).ok).toBe(true);
    expect(t.canAcceptWrite(600_000).ok).toBe(true);
  });
});

describe("canAcceptWrite — the silence guard", () => {
  it("allows a busy target that is still animating", () => {
    // Both CLIs repaint a spinner while working, and the CLI queues the input —
    // verified 2026-09-02, the screen showed `queued` and the task ran after.
    const t = tracker("waiting");
    t.onWrite();
    expect(t.canAcceptWrite(0).ok).toBe(true);
    expect(t.canAcceptWrite(QUIET - 1).ok).toBe(true);
  });

  it("refuses a busy target that has gone quiet", () => {
    // This is the Q7 window: a dialog is up but the detector hasn't said `prompt`
    // yet, because claude needs 1500ms of unpaired tool_use plus 800ms of silence to
    // decide. A working session is never quiet this long.
    const t = tracker("waiting");
    t.onWrite();
    const v = t.canAcceptWrite(QUIET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no terminal output/);
  });

  it("refuses a starting instance that has gone quiet", () => {
    // First launch of a new directory parks on the CLI's trust dialog, whose default
    // is "No, exit". Writing into that is how you kill a fresh manager.
    const v = new RunStateTracker().canAcceptWrite(QUIET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/trusting a new folder/);
  });

  it("allows a starting instance that is still painting", () => {
    expect(new RunStateTracker().canAcceptWrite(0).ok).toBe(true);
  });

  it("reports the silence in seconds, so the reason reads sensibly", () => {
    const t = tracker("waiting");
    t.onWrite();
    const v = t.canAcceptWrite(4200);
    if (!v.ok) expect(v.reason).toContain("4s");
  });
});

describe("the measured hazard, as a sequence", () => {
  it("refuses the exact case that approved a plan", () => {
    // Reproduces the shape of the 2026-09-02 incident: the session had been working,
    // a plan-approval dialog came up, and the terminal fell silent waiting for a
    // human. Both the detector's verdict and the silence guard must refuse, so that
    // whichever notices first, no bytes go out.
    const viaDetector = tracker("waiting");
    viaDetector.onWrite();
    viaDetector.onActivity("prompt");
    expect(viaDetector.canAcceptWrite(0).ok).toBe(false);

    const viaSilence = tracker("waiting");
    viaSilence.onWrite();
    expect(viaSilence.canAcceptWrite(2500).ok).toBe(false);
  });
});
