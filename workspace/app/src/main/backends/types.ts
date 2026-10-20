import type { PromptDetail } from "../remote/promptExtract";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { AlertsDegradedReason, ContextUsage } from "../../shared/types";

export type { AlertsDegradedReason, BackendAvailability } from "../../shared/types";

export type BackendName = "claude" | "opencode";

export interface SpawnConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  // The session this spawn opens, when the backend knows it before the process
  // starts: the one it resumes, or one it named itself. Absent for Claude's
  // `--continue`.
  sessionId?: string;
  // Set when the backend won't start this CLI (OpenCode 1.x): one line for the
  // contact's page saying why and what to do. Nothing is spawned.
  refusal?: string;
}

/**
 * A dialog a backend answers through the CLI's own API rather than keystrokes
 * (OpenCode 2: docs/timeline/2026-10-20_opencode-v2-source-reading.md, "Answering
 * dialogs through the API"). `requestId` is the permission request's or the form's
 * id; `sessionId` the session that asked, a subagent's included.
 */
export interface DialogRef {
  kind: "permission" | "form";
  sessionId: string;
  requestId: string;
}

// What to answer a DialogRef with. A form's answer maps field keys (`q0`, …) to the
// picked option's label, a typed text, or a list for multi-select.
export type DialogAnswer =
  | { kind: "permission"; decision: "once" | "always" | "reject"; message?: string }
  | { kind: "form"; answer: Record<string, string | string[]> };

// `gone`: the dialog was already answered or no longer exists, so nothing was
// answered. `failed`: the CLI couldn't be reached or refused the answer.
export type AnswerResult = { ok: true } | { ok: false; reason: "gone" | "failed" };

/**
 * Which conversation a spawn opens.
 *
 *   - "own": the contact's own session, by id. Resumed while its transcript exists;
 *     once it is gone (or was never written, as when nobody typed in it) a fresh
 *     session starts instead, under that id where the backend allows it.
 *   - "fresh": a new, empty session.
 *   - "latest": the directory's most recent session (Claude's `--continue`;
 *     OpenCode's newest root session, named by id), for a contact with no session
 *     of its own on record, as every contact had before contacts.json kept one.
 *     `isClaimed` says whether another contact holds a session. A backend that
 *     picks the session itself (OpenCode, by id) asks it about the one it picks,
 *     when it picks it, and takes a fresh one when that is held: the newest may
 *     have changed since process-manager looked, or it looked in another database
 *     (OpenCode's paths come from the login shell, read by the spawn).
 *
 * Without "own", two contacts on one project both open the directory's most recent
 * session after every restart, and then share it.
 */
export type SessionStart =
  | { kind: "own"; sessionId: string }
  | { kind: "fresh" }
  | { kind: "latest"; isClaimed?: (sessionId: string) => boolean };

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
  // OpenCode's alert wiring: the directory of Multi-Code's TUI plugin, named in the
  // TUI's OPENCODE_CLI_CONFIG_CONTENT, and the 0600 file it reads `/alert`'s
  // endpoint and token from. Both in userData; see backends/opencodePlugin.ts.
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
 * The tool call a dialog is asking about, exactly as the agent reported it: for a
 * Bash permission, `toolInput` holds the command itself. Kept apart from
 * PromptDetail on purpose: PromptDetail is what a paired phone is sent, and the
 * raw input (a whole script, a file's new contents) is for the secretary in main
 * only.
 */
export interface PromptToolCall {
  toolName: string;
  toolInput: unknown;
  // Present when the backend answers this dialog through its API; the answer paths
  // then use it instead of keystrokes.
  dialog?: DialogRef;
}

/**
 * What the builder last said in a session and what happened since: the voice
 * secretary's material for a brief (`Backend.readBuilderTurn`).
 */
export interface BuilderTurn {
  // Absent when the session has no message the builder typed.
  builderLatestMessage?: string;
  // Up to three typed before it, oldest first.
  builderEarlierMessages: string[];
  // Everything after the latest message, or the whole session when there is none.
  turn: TranscriptEntry[];
}

/**
 * Activity callback. `detail` is populated only for the "prompt" event, and
 * only when the blocking tool_use could be decoded into a question plus
 * options — it's what lets a paired phone render real buttons instead of a
 * raw terminal. Backends that can't decode their prompts omit it. `toolCall`
 * comes with a "prompt" from a backend that knows which tool call raised it.
 */
export type ActivityCallback = (
  type: string,
  detail?: PromptDetail,
  toolCall?: PromptToolCall,
  // `prompt` only: a dialog reported before is the one blocking the contact again,
  // after the one shown closed or a turn ended around it (OpenCode, whose contact can
  // have several open). Everything follows it as the live dialog; nothing chimes,
  // vibrates or counts it a second time.
  restated?: boolean
) => void;

export interface HookAttention {
  handle(delivery: AlertDelivery): void;
  stop(): void;
  // Answer a dialog through the CLI's own API. Absent for a backend whose dialogs
  // are answered by keystrokes (Claude).
  answer?(ref: DialogRef, answer: DialogAnswer): Promise<AnswerResult>;
}

// What createHookAttention is told about the process it watches.
export interface AttentionContext {
  // The contact; its alert deliveries carry it as a header.
  instanceId: string;
  // The session the spawn opened, when the backend knew it up front.
  sessionId?: string;
  // The terminal now shows this session (OpenCode's TUI plugin reports it). The
  // caller claim-checks it and makes it the contact's own.
  onSessionShown(sessionId: string): void;
}

export interface SessionDiscovery {
  cancel(): void;
}

export interface Backend {
  readonly name: BackendName;

  /**
   * Whether this backend's instances keep a secretary event (their latest
   * Finished or Needs-you, see ProcessManager.onSecretaryEvent), which the voice
   * secretary briefs from `readBuilderTurn`. True for both today; OpenCode joined
   * in voice-secretary PRD v1.6.
   */
  readonly keepsSecretaryEvents: boolean;

  /**
   * Whether the backend picks the directory's newest session itself when it spawns
   * a "latest" start, checking its pick with the start's `isClaimed` (OpenCode: the
   * database it reads is named by the login-shell env the spawn resolves). Then
   * process-manager doesn't look first, and doesn't turn a held newest into
   * "fresh": its look could be in another database.
   */
  readonly picksLatestSession?: boolean;

  /**
   * Build the command line for a new instance. `opts` carries the manager's MCP
   * wiring for the manager, and the alert hooks' settings for every instance; a
   * backend that can't honour it should ignore it rather than fail, and say so in
   * its implementation. `session` picks the conversation; "latest" when absent.
   */
  spawn(cwd: string, opts?: SpawnOptions, session?: SessionStart): SpawnConfig;

  /**
   * Start preparing, in the background, what this backend's first spawn will need,
   * so `spawn` (which is synchronous) doesn't wait for it. Called when contacts of
   * this backend are loaded. Optional: OpenCode reads the builder's login-shell
   * environment here (backends/opencodeShellEnv.ts).
   */
  warm?(): void;

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
   * The activity events:
   *   - "waiting": the agent finished and is waiting for a new message.
   *   - "prompt": the agent is blocked on a human decision (permission box,
   *     AskUserQuestion, plan approval, an MCP input request). Carries a
   *     PromptDetail second argument when the question and its options could be
   *     decoded.
   *   - "prompt-cleared": a previously reported prompt was answered (on either
   *     the desktop or a paired phone).
   *
   * The agent reports its own state: Claude through the hooks Multi-Code passes at
   * spawn, delivered to the `/alert` endpoint and routed here by instance; OpenCode
   * through its shared service's event stream, with Multi-Code's TUI plugin naming
   * the session the terminal shows (also through `/alert`). Per process, not per
   * session, so it survives `/clear` and `/new`. `pid` is the pty child's, which
   * Claude keys its own registry on.
   * `onHooksHealth(false, reason)` says alerts can't work for this process (the
   * hooks or plugin don't seem to run, or OpenCode's service can't be reached),
   * `true` that they work again (PRD Story 6).
   */
  createHookAttention(
    pid: number,
    onActivity: ActivityCallback,
    onHooksHealth: (ok: boolean, reason?: AlertsDegradedReason) => void,
    context: AttentionContext
  ): HookAttention;

  /**
   * Translate "the user tapped option N on their phone" into the keystrokes
   * this CLI's option box expects, or null when the choice can't be made
   * safely (out of range, or a box this backend can't drive reliably).
   *
   * This MUST be per-backend: the CLIs do not agree, and the wrong family of keys
   * doesn't error, it silently does nothing or picks the wrong option, which for a
   * permission dialog means granting the wrong thing. Claude's boxes take the
   * option's number directly. OpenCode 2's are answered through its API instead
   * (HookAttention.answer), so it returns null for every choice.
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
   * OpenCode 2 its `session_message` table), and reading that gives text a phone
   * can wrap.
   *
   * Returns an empty array when the session can't be read, which the phone
   * shows as "no transcript" while leaving the terminal view available.
   */
  readTranscript(sessionId: string, limit: number): TranscriptEntry[];

  /**
   * What the builder last typed in this session, up to three messages before it,
   * and everything since, for the voice secretary's brief. Only what the builder
   * typed counts as theirs, never text the CLI added to the conversation itself.
   * Null when the session can't be read.
   */
  readBuilderTurn(sessionId: string): Promise<BuilderTurn | null>;

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
   * (`message.usage`), OpenCode 2 in its `session_message` assistant rows
   * (`tokens`).
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
   * `startedAt` is when the process started, for a backend with no registry to
   * tell a session it made from an older one in the same directory.
   * Return null rather than guessing: a wrong id here points every read at
   * another session's transcript.
   */
  findLiveSessionId(cwd: string, pid: number, startedAt: number): string | null;

  buildResumeCommand(sessionId: string): string;
}
