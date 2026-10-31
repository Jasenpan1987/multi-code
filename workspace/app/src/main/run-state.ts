// What an instance is doing right now, from what it reports about itself and the
// writes made to it: starting, idle, busy, or blocked on a dialog. The quit
// confirmation and a paired phone read it.
//
// Kept separate from process-manager so it can actually be tested: that module pulls
// in electron and node-pty, neither of which loads under plain-node vitest.

export type RunState = "starting" | "idle" | "busy" | "blocked";

/**
 * Tracks one instance's state from the events the backend detector emits, plus the
 * writes made to it.
 *
 * - `starting`  spawned, nothing heard yet. May be painting a trust dialog.
 * - `idle`      reported a finished turn and has had no input since.
 * - `busy`      given work and hasn't reported finishing.
 * - `blocked`   on a dialog awaiting a human decision.
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
    // prompt, so the instance is no longer parked; the detector's `prompt-cleared`
    // will follow.
    this.current = "busy";
  }

  /** The pty exited. */
  onExit() {
    this.current = "starting";
  }
}
