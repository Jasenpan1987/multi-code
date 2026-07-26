import type { PromptDetail } from "../remote/promptExtract";

export type BackendName = "claude" | "opencode";

export interface SpawnConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Activity callback. `detail` is populated only for the "prompt" event, and
 * only when the blocking tool_use could be decoded into a question plus
 * options — it's what lets a paired phone render real buttons instead of a
 * raw terminal. Backends that can't decode their prompts omit it.
 */
export type ActivityCallback = (type: string, detail?: PromptDetail) => void;

export interface CompletionDetector {
  stop(): void;
}

export interface SessionDiscovery {
  cancel(): void;
}

export interface Backend {
  readonly name: BackendName;

  spawn(cwd: string): SpawnConfig;

  /**
   * Begin trying to discover the sessionId for an instance running in `cwd`.
   * Calls `onFound` once when the sessionId is determined; never calls it
   * if the agent never registers a session within a reasonable window.
   * The returned handle can be used to cancel discovery early.
   *
   * `isClaimed` lets the caller veto a candidate sessionId that another
   * instance has already latched onto — important when two instances run
   * in the same cwd, because the most-recent jsonl would otherwise be
   * picked by both.
   */
  discoverSessionId(
    cwd: string,
    onFound: (sessionId: string) => void,
    isClaimed?: (sessionId: string) => boolean
  ): SessionDiscovery;

  /**
   * Begin watching for completion / activity events for the session.
   * `onActivity` fires with a string event type whenever the agent
   * reaches a state that warrants notifying the user:
   *   - "waiting": the assistant turn ended (end_turn) and the user
   *     should respond.
   *   - "prompt": the assistant is mid-turn but blocked on an
   *     interactive question (permission box, AskUserQuestion, plan
   *     approval, etc.). Detected from a tool_use that hasn't been
   *     paired with a tool_result while the PTY has fallen silent.
   *     Carries a PromptDetail second argument when the question and
   *     its options could be decoded.
   *   - "prompt-cleared": a previously reported prompt was answered
   *     (on either the desktop or a paired phone).
   *
   * `isPtyIdle(ms)` returns true when no PTY bytes have been written
   * for at least `ms` milliseconds. Used to disambiguate "Claude
   * waiting on the user" (screen static) from "Claude running a
   * subagent / long tool" (spinner is repainting).
   */
  createCompletionDetector(
    sessionId: string,
    onActivity: ActivityCallback,
    isPtyIdle: (ms: number) => boolean
  ): CompletionDetector;

  buildResumeCommand(sessionId: string): string;
}
