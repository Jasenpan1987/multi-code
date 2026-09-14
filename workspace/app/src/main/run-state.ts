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

// How long the terminal must have been silent to count as "no reaction".
//
// Both CLIs echo input and start animating within a beat of receiving it, so a
// second of nothing right after a write means the write did not land as a prompt.
const SUSPICIOUS_SILENCE_MS = 1000;

// How long after a write silence still means anything.
//
// **Silence on its own cannot tell an idle session from one sitting on a dialog.**
// Both are a static screen waiting for a human, and an earlier version of this file
// claimed otherwise — that a working session is never quiet, so quiet implies
// trouble. That was wrong, and it made the gate refuse ordinary targets: measured
// 2026-09-15, an idle OpenCode session was refused with "has produced no terminal
// output for 81s" simply because it was waiting for input, which is what idle looks
// like. A session resumed with --continue never reports `waiting` for its old
// history, so it sits in `starting`/`busy` indefinitely and every dispatch to it was
// rejected.
//
// So silence is only consulted inside a window after *we* wrote something, where the
// absence of any reaction is itself the signal — most usefully, it catches a second
// dispatch when the first one landed on a dialog. Outside that window, quiet is just
// quiet, and the detector's `prompt` event is the only thing that knows about
// dialogs.
const REACTION_WINDOW_MS = 8000;

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
  // When something last wrote to this instance. 0 means never, which is why a
  // freshly resumed session that nobody has typed at is never judged on silence.
  private lastWriteAt = 0;

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
  onWrite(now = Date.now()) {
    // Even a write while blocked lands as an answer to that dialog rather than as a
    // prompt, so the instance is no longer parked — the detector's `prompt-cleared`
    // will follow. Treating it as busy here keeps the next write gated on silence
    // rather than waving it straight through.
    this.current = "busy";
    this.lastWriteAt = now;
  }

  /** The pty exited. */
  onExit() {
    this.current = "starting";
    this.lastWriteAt = 0;
  }

  /**
   * `ptySilentMs` is how long since the last byte arrived from this instance.
   *
   * Refusals name the state, because the caller passes the reason up to the manager,
   * which has to relay something actionable to the user rather than "no".
   */
  canAcceptWrite(ptySilentMs: number, now = Date.now()): WriteVerdict {
    if (this.current === "blocked") {
      return {
        ok: false,
        reason:
          "waiting on a decision from you (a permission prompt, a question, or a plan approval). " +
          "Answer it in Multi-Code first — a message sent now would be read as the answer.",
      };
    }

    // Only inside the reaction window, and only when we were the ones who wrote. A
    // static screen is what idle looks like, so judging silence outside this window
    // refuses perfectly good targets — see REACTION_WINDOW_MS.
    const wroteRecently =
      this.lastWriteAt > 0 && now - this.lastWriteAt <= REACTION_WINDOW_MS;
    if (wroteRecently && ptySilentMs >= SUSPICIOUS_SILENCE_MS) {
      return {
        ok: false,
        reason:
          `not reacting: something was sent ${Math.round((now - this.lastWriteAt) / 1000)}s ago ` +
          `and its terminal has been silent for ${Math.round(ptySilentMs / 1000)}s. ` +
          "Both CLIs echo input immediately, so that write probably landed somewhere " +
          "unexpected — check it in Multi-Code before sending more.",
      };
    }

    return { ok: true };
  }
}

export const SUSPICIOUS_SILENCE_MS_FOR_TESTS = SUSPICIOUS_SILENCE_MS;
export const REACTION_WINDOW_MS_FOR_TESTS = REACTION_WINDOW_MS;
