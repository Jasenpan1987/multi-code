// Decides whether an instance activity ("waiting" = turn finished, "prompt" =
// agent blocked on user input) deserves the audible/dock attention signals.
//
// Two rules, both borrowed from Orca's notification dispatch
// (src/main/ipc/notifications.ts) and matched to the QQ aesthetic:
//
//  1. suppress-when-focused — for routine activity ("waiting") the user is
//     already looking at this instance (it is the selected one AND the window
//     has focus), so the beep and dock bounce are noise; QQ does not sound
//     for the conversation that is open. Urgent activity ("prompt" — the
//     agent is blocked until the user acts) overrides this: that sound must
//     play even while the user is watching, or the "needs input" notification
//     the whole feature exists for never fires in the common case of
//     watching the terminal. The badge/flash still updates either way, and a
//     paired phone keeps receiving every activity.
//  2. cooldown dedupe — "prompt" and "waiting" often land in one burst for the
//     same instance (answering a prompt lets the turn finish moments later);
//     only the first alert within the window sounds. Orca uses 5s per worktree.

export const ATTENTION_COOLDOWN_MS = 5000;

export interface AttentionPolicyInput {
  /** The activity's instance is the one currently selected in the UI. */
  isSelected: boolean;
  /** The app window currently has OS focus (true even for background tabs). */
  windowFocused: boolean;
  /** When this instance last produced an audible alert; <= 0 means never. */
  lastSoundAt: number;
  /** Current time, Date.now(). */
  now: number;
  /**
   * Urgent activity (agent blocked on user input) lifts the
   * suppress-when-focused rule: the sound plays even while the user is
   * looking at this instance. The cooldown still applies.
   */
  urgent?: boolean;
  /** Cooldown length; exported for tests, defaults to the Orca-style 5s. */
  cooldownMs?: number;
}

export function shouldPlayAttentionSound(input: AttentionPolicyInput): boolean {
  const { isSelected, windowFocused, lastSoundAt, now, urgent } = input;
  const cooldownMs = input.cooldownMs ?? ATTENTION_COOLDOWN_MS;

  if (!urgent && isSelected && windowFocused) return false;
  // Only real alert timestamps participate in the cooldown; <= 0 means this
  // instance has never sounded.
  if (lastSoundAt > 0 && now - lastSoundAt < cooldownMs) return false;
  return true;
}
