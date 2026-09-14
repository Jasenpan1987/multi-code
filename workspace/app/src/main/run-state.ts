// Whether it is safe to write to an instance's terminal right now.
//
// This exists because of a measured hazard, not a theoretical one. On 2026-09-02 a
// PTY write to a session parked on a plan-approval dialog selected that dialog's
// highlighted default — "Yes, and use auto mode" — and the session went on to edit a
// real file. The payload was ordinary prose with no digits in it, so filtering the
// text could never have prevented it. The only defence is knowing the target's state
// before writing a byte.
//
// Kept separate from process-manager so it can actually be tested: that module pulls
// in electron and node-pty, neither of which loads under plain-node vitest.

export type RunState = "starting" | "idle" | "busy" | "blocked";

export type WriteVerdict =
  | { ok: true }
  | { ok: false; reason: string };

// How long the terminal must have been silent before a non-idle instance is treated
// as suspect.
//
// Both CLIs repaint a spinner while they work — claude's detector relies on that,
// noting it repaints "at least once per second", and OpenCode's keeps painting even
// through a permission dialog. So a working session is never quiet for a whole
// second. A quiet one that hasn't reported finishing is either blocked on something
// the detector hasn't recognised yet, or doing something we can't see; either way it
// is not a safe target.
//
// This is deliberately shorter than the detector's own path to declaring a prompt
// (1500ms of unpaired tool_use plus 800ms of PTY silence for claude), so it covers
// the window where a dialog is already up and the detector hasn't said so.
const SUSPICIOUS_SILENCE_MS = 1000;

/**
 * Tracks one instance's state from the events the backend detector emits, plus the
 * writes we make ourselves.
 *
 * State meanings, and why the distinction matters for writing:
 * - `starting`  spawned, nothing heard yet. May be painting a trust dialog.
 * - `idle`      reported a finished turn and has had no input since. Safe.
 * - `busy`      given work and hasn't reported finishing. Safe *if* still noisy —
 *               the CLI queues input while working, verified 2026-09-02.
 * - `blocked`   on a dialog awaiting a human decision. Never safe.
 */
export class RunStateTracker {
  private current: RunState = "starting";

  state(): RunState {
    return this.current;
  }

  /** Feed a detector activity event. Unknown types are ignored. */
  onActivity(type: string) {
    if (type === "waiting") {
      this.current = "idle";
      return;
    }
    if (type === "prompt") {
      this.current = "blocked";
      return;
    }
    if (type === "prompt-cleared") {
      // The dialog was answered, by the user at the desk or on their phone. It went
      // back to working, not to idle — `waiting` is what says idle.
      this.current = "busy";
    }
  }

  /** Called when bytes are written to this instance, from any source. */
  onWrite() {
    // Even a write while blocked lands as an answer to that dialog rather than as a
    // prompt, so the instance is no longer parked — the detector's `prompt-cleared`
    // will follow. Treating it as busy here keeps the next write gated on silence
    // rather than waving it straight through.
    this.current = "busy";
  }

  /** The pty exited. */
  onExit() {
    this.current = "starting";
  }

  /**
   * `ptySilentMs` is how long since the last byte arrived from this instance.
   *
   * Refusals name the state, because the caller passes the reason up to the manager,
   * which has to relay something actionable to the user rather than "no".
   */
  canAcceptWrite(ptySilentMs: number): WriteVerdict {
    if (this.current === "blocked") {
      return {
        ok: false,
        reason:
          "waiting on a decision from you (a permission prompt, a question, or a plan approval). " +
          "Answer it in Multi-Code first — a message sent now would be read as the answer.",
      };
    }

    if (this.current === "idle") {
      // It said it finished and nothing has been sent since, so the quiet is expected
      // and the silence check would reject every legitimate write.
      return { ok: true };
    }

    if (ptySilentMs >= SUSPICIOUS_SILENCE_MS) {
      return {
        ok: false,
        reason:
          this.current === "starting"
            ? "still starting up and has gone quiet, which usually means it is waiting on something " +
              "(the CLI asks about trusting a new folder on first launch). Check it in Multi-Code."
            : `working but has produced no terminal output for ${Math.round(ptySilentMs / 1000)}s. ` +
              "Both CLIs animate while they work, so silence means it is probably waiting on " +
              "something that hasn't been recognised yet. Check it in Multi-Code.",
      };
    }

    return { ok: true };
  }
}

export const SUSPICIOUS_SILENCE_MS_FOR_TESTS = SUSPICIOUS_SILENCE_MS;
