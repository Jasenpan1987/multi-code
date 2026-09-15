import type { PromptDetail } from "../remote/promptExtract";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { ContextUsage } from "../../shared/types";

export type BackendName = "claude" | "opencode";

export interface SpawnConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Extra spawn wiring for an instance that isn't a plain project session. Only the
 * manager uses this today.
 *
 * Both fields are needed together or not at all: an MCP server the instance can
 * reach but whose tools it must ask permission for on every call is useless to an
 * agent that is supposed to coordinate unattended. Measured 2026-09-02 — without
 * the allowlist the CLI answers "Claude requested permissions to use
 * mcp__multi-code__manager_health, but you haven't granted it yet" and the tool
 * never runs.
 */
export interface SpawnOptions {
  // Path to a JSON file in `--mcp-config` form. A file rather than the inline JSON
  // form because it carries a bearer token, and argv is world-readable via `ps`.
  mcpConfigPath?: string;
  // Fully-qualified tool names to pre-approve, e.g. `mcp__multi-code__list_sessions`.
  // Enumerated rather than wildcarded: the write tools should each need a
  // deliberate line of code before the manager can use them unattended.
  allowedTools?: string[];
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

  /**
   * Feed a chunk of PTY output to the detector, for backends whose blocking
   * state is only visible on the painted terminal.
   *
   * Claude doesn't need this — its prompts are in the session JSONL. OpenCode
   * does: its permission requests ("Allow once / Allow always / Reject") are
   * never persisted, so reading the terminal is the only way to see one without
   * changing how the process is launched. Optional so backends that have a
   * structured source don't implement a no-op.
   */
  onPtyData?(chunk: string): void;
}

export interface SessionDiscovery {
  cancel(): void;
}

export interface Backend {
  readonly name: BackendName;

  /**
   * Build the command line for a new instance. `opts` is present only for the
   * manager instance; a backend that can't honour it should ignore it rather than
   * fail, and say so in its implementation.
   */
  spawn(cwd: string, opts?: SpawnOptions): SpawnConfig;

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
   *
   * Note that PTY idleness is a Claude-specific signal, not a universal
   * one. OpenCode keeps a spinner running the entire time a permission
   * dialog is up — measured across a 31s dialog, the longest gap between
   * writes was 295ms — so an idle threshold can never fire there. Backends
   * are free to ignore this argument and detect blocking another way.
   */
  createCompletionDetector(
    sessionId: string,
    onActivity: ActivityCallback,
    isPtyIdle: (ms: number) => boolean
  ): CompletionDetector;

  /**
   * Translate "the user tapped option N on their phone" into the keystrokes
   * this CLI's option box expects, or null when the choice can't be made
   * safely (out of range, or a box this backend can't drive reliably).
   *
   * This MUST be per-backend: the CLIs do not agree. Claude's boxes take the
   * option's number directly, while OpenCode's ignore digits entirely and
   * navigate with arrows — and its two dialog kinds even use different arrows
   * (permission is a horizontal row, question is a vertical list). Sending the
   * wrong family of keys doesn't error, it silently does nothing or picks the
   * wrong option, which for a permission dialog means granting the wrong thing.
   *
   * `tool` is the PromptDetail.tool the backend itself reported, so each
   * backend can dispatch on values it defined.
   */
  keystrokeForChoice(
    tool: string,
    index: number,
    optionCount: number
  ): string | null;

  /**
   * Read the tail of the session as reflowable text, newest last.
   *
   * This exists because the terminal mirror can't be made readable on a phone:
   * the PTY is a fixed 120 columns and the CLIs paint absolutely-positioned
   * cells, so there is nothing to reflow. Both CLIs already keep a structured
   * record of the conversation for their own use (Claude a session JSONL,
   * OpenCode a sqlite db), and reading that gives text a phone can wrap.
   *
   * Returns an empty array when the session can't be read, which the phone
   * shows as "no transcript" while leaving the terminal view available.
   */
  readTranscript(sessionId: string, limit: number): TranscriptEntry[];

  /**
   * How full this session's context window is, from the newest assistant turn.
   *
   * Returns null when the session has no assistant turn yet, or can't be read.
   * That is deliberately distinct from zero: a fresh session and an unreadable
   * one both have unknown usage, and showing "0" for either would read as "plenty
   * of room left" when we simply don't know.
   *
   * Both CLIs record per-turn usage and lifetime totals, and only the former
   * answers this question — the totals reach millions of tokens against a
   * 200k–1M window. Claude keeps it in the session JSONL's assistant records
   * (`message.usage`), OpenCode in its sqlite `message` rows (`data.tokens`).
   */
  readContextUsage(sessionId: string): ContextUsage | null;

  /**
   * The most recent session this CLI has recorded for `cwd`, from what is on
   * disk. Null when the directory has no history, or the store can't be read.
   *
   * Distinct from `discoverSessionId`, which finds the session of a *live*
   * process and is the only thing allowed to decide what an instance owns. This
   * one answers a different question — "what did this directory last work on" —
   * and is for read paths only: a stopped instance has no sessionId at all after
   * an app restart, because contacts.json doesn't store one, which left the
   * manager unable to read the history of any session it hadn't watched run.
   *
   * **Callers must not write the result into an instance's `sessionId`.**
   * `spawnProcess` treats an instance holding a session id as that session's
   * owner, so a stopped contact pre-filled from disk would veto discovery for a
   * *running* instance in the same directory — a shape this user already has, with
   * two contacts on the same repo.
   */
  findLatestSessionId(cwd: string): string | null;

  buildResumeCommand(sessionId: string): string;
}
