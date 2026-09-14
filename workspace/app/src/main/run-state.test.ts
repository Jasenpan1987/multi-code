// The measured hazard this gate exists for: on 2026-09-02 a PTY write to a session
// parked on a plan-approval dialog picked that dialog's highlighted default ("Yes,
// and use auto mode") and the session edited a real file. The payload was prose with
// no digits, so no amount of filtering the text would have helped.
//
// Everything below is really one assertion in different shapes: a target that might
// be sitting on a dialog is never writable.

import { describe, expect, it } from "vitest";
import {
  RunStateTracker,
  SUSPICIOUS_SILENCE_MS_FOR_TESTS as QUIET,
  REACTION_WINDOW_MS_FOR_TESTS as WINDOW,
} from "./run-state";

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

describe("canAcceptWrite — the reaction window", () => {
  const T0 = 10_000_000;

  it("allows a target nobody has written to, however long it has been quiet", () => {
    // This is the regression that mattered. A session resumed with --continue never
    // reports `waiting` for its old history, so it stays `starting` forever. Measured
    // 2026-09-15: an idle OpenCode session was refused with "no terminal output for
    // 81s" purely for waiting for input, which is what idle looks like.
    const t = new RunStateTracker();
    expect(t.canAcceptWrite(81_000, T0).ok).toBe(true);
    expect(t.canAcceptWrite(600_000, T0).ok).toBe(true);
  });

  it("allows a busy target that went quiet long after the last write", () => {
    const t = tracker("waiting");
    t.onWrite(T0);
    expect(t.canAcceptWrite(60_000, T0 + WINDOW + 1).ok).toBe(true);
  });

  it("refuses when a recent write produced no reaction at all", () => {
    // Most usefully this catches a second dispatch when the first one landed on a
    // dialog: the CLI echoes input immediately, so silence means it didn't.
    const t = tracker("waiting");
    t.onWrite(T0);
    const v = t.canAcceptWrite(QUIET, T0 + 2000);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/not reacting/);
      expect(v.reason).toMatch(/2s ago/);
    }
  });

  it("allows a recent write that is being echoed normally", () => {
    const t = tracker("waiting");
    t.onWrite(T0);
    expect(t.canAcceptWrite(QUIET - 1, T0 + 2000).ok).toBe(true);
  });

  it("forgets the write after an exit, so a restarted instance isn't judged on it", () => {
    const t = tracker("waiting");
    t.onWrite(T0);
    t.onExit();
    expect(t.canAcceptWrite(60_000, T0 + 1000).ok).toBe(true);
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
