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
 * Extra spawn wiring. The manager gets the three Claude fields; every other
 * instance gets its backend's alert wiring alone: `settingsPath` for Claude,
 * `opencodePlugin` for OpenCode.
 *
 * The MCP fields are needed together or not at all: an MCP server the instance can
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
  // Path to a JSON settings file in `--settings` form, carrying hooks only: the
  // attention-alert hooks for every Claude instance, plus, for the manager, the
  // ones that report its own Bash/Edit/Write into the activity feed. Additive to
  // the user's own settings, and holds no permission rules — see config.ts. One
  // file, because the CLI applies only the last `--settings` it is given.
  settingsPath?: string;
  // OpenCode's alert wiring: Multi-Code's plugin, loaded through
  // OPENCODE_CONFIG_CONTENT, and the 0600 file it reads `/alert`'s endpoint and
  // token from. Both in userData; see backends/opencodePlugin.ts.
  opencodePlugin?: { pluginPath: string; targetPath: string };
}

/**
 * One hook delivery from a Claude instance, as the `/alert` endpoint received it.
 * The named fields are the ones attention logic keys on, lifted from the CLI's hook
 * stdin (field names measured on CLI 2.1.291, see
 * docs/timeline/2026-10-06_attention-alerts-investigation.md, "Hook spike");
 * `payload` keeps the whole delivery for anything else, such as `Stop`'s
 * `background_tasks`.
 *
 * `instanceId` comes from the hook command's `X-Multicode-Instance` header, not from
 * the payload: the CLI knows nothing about Multi-Code's instances. A delivery for an
 * id no instance has is the receiver's to drop.
 */
export interface AlertDelivery {
  instanceId: string;
  // The `X-Multicode-Spawn` header: which spawn of the instance sent it.
  spawnId?: string;
  // `hook_event_name`: "Stop", "PermissionRequest", "UserPromptSubmit", …
  event: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  // Present on PreToolUse/PostToolUse; PermissionRequest carries none.
  toolUseId?: string;
  // Set only on deliveries from inside a subagent.
  agentId?: string;
  payload: Record<string, unknown>;
}

/**
 * Activity callback. `detail` is populated only for the "prompt" event, and
 * only when the blocking tool_use could be decoded into a question plus
 * options — it's what lets a paired phone render real buttons instead of a
 * raw terminal. Backends that can't decode their prompts omit it.
 */
export type ActivityCallback = (type: string, detail?: PromptDetail) => void;

export interface HookAttention {
  handle(delivery: AlertDelivery): void;
  stop(): void;
}

export interface CompletionDetector {
  stop(): void;

  /**
   * Feed a chunk of PTY output to the detector, for backends whose blocking
   * state is only visible on the painted terminal.
   *
   * OpenCode needs this: its permission requests ("Allow once / Allow always / Reject") are
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
   * Build the command line for a new instance. `opts` carries the manager's MCP
   * wiring for the manager, and the alert hooks' settings for every instance; a
   * backend that can't honour it should ignore it rather than fail, and say so in
   * its implementation.
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
   * The activity events, whichever of the two seams below produces them:
   *   - "waiting": the agent finished and is waiting for a new message.
   *   - "prompt": the agent is blocked on a human decision (permission box,
   *     AskUserQuestion, plan approval, an MCP input request). Carries a
   *     PromptDetail second argument when the question and its options could be
   *     decoded.
   *   - "prompt-cleared": a previously reported prompt was answered (on either
   *     the desktop or a paired phone).
   *
   * A backend implements exactly one of the two.
   *
   * `createHookAttention`: the agent reports its own state through hooks Multi-Code
   * injects at spawn, delivered to the `/alert` endpoint and routed here by
   * instance. Claude Code. Per process, not per session, so it survives `/clear`.
   * `pid` is the pty child's, which the CLI keys its own registry on.
   * `onHooksHealth(false)` says the hooks don't seem to run at all, `true` that one
   * was heard after all (PRD Story 6).
   *
   * `createCompletionDetector`: Multi-Code watches the session from outside.
   * OpenCode, until it moves to its plugin (epic attention-alerts, Track 2).
   */
  createHookAttention?(
    pid: number,
    onActivity: ActivityCallback,
    onHooksHealth: (ok: boolean) => void
  ): HookAttention;

  createCompletionDetector?(
    sessionId: string,
    onActivity: ActivityCallback
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

  /**
   * The session a *running* process is working in right now, or null when it
   * can't be established.
   *
   * Distinct from `discoverSessionId`, which answers once at spawn and stops. A
   * session id is not stable for the life of a process: `/new` and `/clear` start
   * a fresh transcript under a new id, leaving the old file on disk and never
   * writing to it again (measured 2026-09-17). Everything that reads a session
   * goes through this id — context usage, `readTranscript`, and the completion
   * detector behind notifications and the write-safety gate — so an instance
   * holding a stale one goes quiet in three ways at once, and the visible symptom
   * is only that its context percentage stops moving.
   *
   * `pid` is the pty child's pid, which is what the CLI keys its own registry on.
   * Return null rather than guessing: a wrong id here points every read at
   * another session's transcript.
   */
  findLiveSessionId(cwd: string, pid: number): string | null;

  buildResumeCommand(sessionId: string): string;
}
