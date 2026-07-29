import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import type {
  ActivityCallback,
  Backend,
  CompletionDetector,
  SessionDiscovery,
  SpawnConfig,
} from "./types";
import {
  buildPermissionDetail,
  hasPermissionDialog,
  keystrokeForPermission,
  keystrokeForQuestion,
  MULTI_QUESTION_TOOL_LABEL,
  PERMISSION_TOOL,
  QUESTION_TOOL_LABEL,
  visibleText,
  type OpencodePromptDetail,
} from "./opencodePrompt";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import { resolvePath } from "./resolvePath";

const HOME = process.env.HOME || "";

const SEARCH_PATH = [
  // opencode's official install script drops the binary here by default; it's
  // added to the user's shell rc, so it's on the login-shell PATH but NOT on
  // the sparse PATH Electron inherits when launched from Finder/Dock.
  path.join(HOME, ".opencode/bin"),
  path.join(HOME, ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "",
].join(":");

const OPENCODE_DB = path.join(HOME, ".local/share/opencode/opencode.db");

function findOpencodeBinary(): string {
  // Try PATH-resolve first (handles nvm-installed binaries etc.)
  try {
    const resolved = execSync("command -v opencode", {
      env: { ...process.env, PATH: SEARCH_PATH },
      encoding: "utf8",
    }).trim();
    if (resolved) return resolved;
  } catch {
    // fallthrough
  }

  const candidates = [
    path.join(HOME, ".opencode/bin/opencode"),
    path.join(HOME, ".local/bin/opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "opencode";
}

const opencodePath = findOpencodeBinary();

function buildEnv(): Record<string, string> {
  return {
    ...process.env,
    PATH: SEARCH_PATH,
  } as Record<string, string>;
}

// Open a read-only sqlite handle. Throws on failure (caller decides how to handle).
function openDb(): Database.Database {
  return new Database(OPENCODE_DB, { readonly: true, fileMustExist: true });
}


// Find the most recently created session whose `directory` matches `cwd`.
// Returns null if not found or if the db is currently inaccessible (e.g.
// not yet created on first opencode launch).
//
// Both the stored and the requested path are resolved before comparing, because
// OpenCode records the path it resolved rather than the one it was given. On
// macOS `/tmp` is a symlink to `/private/tmp`, so an instance whose cwd is
// `/tmp/x` writes `/private/tmp/x` and a plain string compare never matches —
// session discovery then silently times out and the instance gets no prompt
// detection at all.
function findLatestSessionForCwd(
  cwd: string,
  isClaimed?: (sessionId: string) => boolean
): string | null {
  let db: Database.Database | null = null;
  try {
    db = openDb();
    const target = resolvePath(cwd);
    // Query both spellings so the common case still hits the index: `cwd` as
    // given, and its resolved form (what OpenCode actually stored). Only when
    // neither matches literally does this fall back to resolving candidates.
    const rows = db
      .prepare(
        "SELECT id, directory FROM session WHERE directory IN (?, ?) " +
          "ORDER BY time_created DESC LIMIT 8"
      )
      .all(cwd, target) as Array<{ id: string; directory: string }>;
    for (const row of rows) {
      if (!isClaimed || !isClaimed(row.id)) return row.id;
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

class OpencodeSessionDiscovery implements SessionDiscovery {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    cwd: string,
    onFound: (sessionId: string) => void,
    isClaimed?: (sessionId: string) => boolean
  ) {
    let attempts = 0;
    this.interval = setInterval(() => {
      attempts++;
      if (attempts > 30) {
        this.cancel();
        return;
      }
      const sessionId = findLatestSessionForCwd(cwd, isClaimed);
      if (!sessionId) return;
      if (isClaimed && isClaimed(sessionId)) return;

      this.cancel();
      onFound(sessionId);
    }, 1000);
  }

  cancel() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

interface OpencodeMessageData {
  role?: string;
  finish?: string;
  content?: unknown;
}

// Bound on the terminal text kept for permission-dialog matching. This only has
// to hold one repaint of the dialog; it is NOT relied on to expire anything (see
// the note on `permissionSeen` below for why eviction can't be a clear signal).
const PTY_WINDOW_BYTES = 24 * 1024;

// A dialog must stay up this long before it's reported. Two reasons, both
// measured against a live dialog:
//   - the option row animates for ~3s after painting, and the answer path
//     depends on the selection having settled on option 0
//   - it debounces a dialog the user answers at the desk immediately
const PROMPT_SETTLE_MS = 3500;

// Poll interval for both the db queries and the terminal-text check.
const PTY_CHECK_MS = 500;

// A running `question` tool part is the CLI waiting on a choice. Unlike a
// permission request, this one IS in the db with its full option list, so it's
// read from there rather than scraped off the screen.
const QUESTION_TOOL = "question";

// Tools whose `running` state is normal work rather than a block. A permission
// request always sits on top of some tool that is stuck mid-flight, so the db
// tells us "a tool is in flight" and the terminal text tells us "and it's
// blocked on a permission dialog". Neither signal alone is enough: `running`
// covers a 5-minute test run just as much as a blocked one.
const IN_FLIGHT_STATUS = "running";

interface OpencodeQuestionOption {
  label?: unknown;
  description?: unknown;
}

// Decode a `question` tool's stored input into renderable options. Mirrors what
// promptExtract does for Claude's AskUserQuestion; kept separate because the
// payload shape and the answering keystrokes both differ.
function extractQuestionDetail(raw: string): OpencodePromptDetail | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const part = parsed as Record<string, unknown>;
  const state = part.state as Record<string, unknown> | undefined;
  const input = state?.input as Record<string, unknown> | undefined;
  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const first = questions[0] as Record<string, unknown>;
  const rawOptions = Array.isArray(first.options) ? first.options : [];
  const options: { label: string; description?: string }[] = [];
  for (const entry of rawOptions) {
    const option = entry as OpencodeQuestionOption;
    if (typeof option?.label !== "string" || option.label.length === 0) continue;
    options.push({
      label: option.label,
      description:
        typeof option.description === "string" ? option.description : undefined,
    });
  }
  if (options.length === 0) return null;

  // OpenCode appends its own free-text escape hatch to the on-screen list, so
  // the phone must offer it too — otherwise the indices the phone sends would
  // line up against a shorter list than the one being navigated.
  options.push({ label: "Type your own answer", description: "Send a custom reply" });

  const question =
    typeof first.question === "string"
      ? first.question
      : typeof first.header === "string"
        ? first.header
        : undefined;

  // Multi-select boxes are a two-stage interaction (toggle, then Tab to a Confirm
  // step) that tapping a single option can't express. Labelled separately so the
  // answer path declines instead of ticking one box and stranding the agent; the
  // phone still shows the question, and the free-text box and terminal both work.
  const multiple = first.multiple === true;
  return {
    tool: multiple ? MULTI_QUESTION_TOOL_LABEL : QUESTION_TOOL_LABEL,
    question,
    options,
  };
}

class OpencodeCompletionDetector implements CompletionDetector {
  private lastSeenTime = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pendingNotify: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  // Bounded tail of recently painted terminal text, the only place a permission
  // request is visible at all.
  private ptyWindow = "";
  // Sticky flag: a permission dialog was seen on the terminal.
  //
  // This can't be re-derived from `ptyWindow` on each tick, because OpenCode
  // paints the dialog's option row EXACTLY ONCE and never repaints it — after
  // that only a one-glyph spinner cell updates. So the marker neither refreshes
  // (a phone connecting later would miss it) nor disappears when the dialog is
  // dismissed (teardown emits no clear sequence and no erase-in-display). The
  // flag is therefore set from the terminal and cleared from the db, which is
  // the only source that positively reports the block ending: answering lets the
  // stuck tool proceed, so its part row leaves "running".
  private permissionSeen = false;
  // Snapshot of the terminal at the moment the dialog was latched, so the
  // subject line is decoded from the text that actually contained the dialog
  // rather than from a window that has since scrolled on.
  private permissionText = "";
  // When the current block was first observed, for the settle delay.
  private blockedSince = 0;
  // Edge-trigger latch: report a given blocking state once, and not again until
  // it clears.
  private promptReported = false;

  constructor(
    private readonly sessionId: string,
    private readonly onActivity: ActivityCallback
  ) {
    // Snapshot the latest message timestamp so existing rows don't trigger.
    this.lastSeenTime = this.getCurrentLatestTime();
    this.pollInterval = setInterval(() => this.tick(), PTY_CHECK_MS);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.pendingNotify) clearTimeout(this.pendingNotify);
    this.pollInterval = null;
    this.pendingNotify = null;
  }

  // Fed from process-manager. Matched against markers, never replayed, so only a
  // bounded tail is kept.
  onPtyData(chunk: string) {
    if (this.stopped) return;
    this.ptyWindow += visibleText(chunk);
    if (this.ptyWindow.length > PTY_WINDOW_BYTES) {
      this.ptyWindow = this.ptyWindow.slice(-PTY_WINDOW_BYTES);
    }
    // Latch as soon as the dialog appears. Checked here rather than on the poll
    // tick because the option row is painted once and could otherwise be evicted
    // between ticks by a burst of output.
    if (!this.permissionSeen && hasPermissionDialog(this.ptyWindow)) {
      this.permissionSeen = true;
      this.permissionText = this.ptyWindow;
    }
  }

  private tick() {
    this.checkForChanges();
    this.checkForPrompt();
  }

  private cancelPending() {
    if (this.pendingNotify) {
      clearTimeout(this.pendingNotify);
      this.pendingNotify = null;
    }
  }

  private getCurrentLatestTime(): number {
    let db: Database.Database | null = null;
    try {
      db = openDb();
      const row = db
        .prepare(
          "SELECT MAX(time_created) AS t FROM message WHERE session_id = ?"
        )
        .get(this.sessionId) as { t: number | null } | undefined;
      return row?.t ?? 0;
    } catch {
      return this.lastSeenTime;
    } finally {
      db?.close();
    }
  }

  private checkForChanges() {
    let db: Database.Database | null = null;
    try {
      db = openDb();
      const rows = db
        .prepare(
          "SELECT time_created, data FROM message WHERE session_id = ? AND time_created > ? ORDER BY time_created ASC"
        )
        .all(this.sessionId, this.lastSeenTime) as Array<{
        time_created: number;
        data: string;
      }>;

      if (rows.length === 0) return;

      let shouldScheduleNotify = false;

      for (const row of rows) {
        this.lastSeenTime = row.time_created;
        let parsed: OpencodeMessageData;
        try {
          parsed = JSON.parse(row.data);
        } catch {
          continue;
        }

        if (parsed.role === "assistant") {
          // finish === "stop"        -> assistant truly done, schedule notify
          // finish === "tool-calls"  -> still working, ignore
          // finish === undefined     -> intermediate streaming row, ignore
          if (parsed.finish === "stop") {
            shouldScheduleNotify = true;
          }
        } else if (parsed.role === "user") {
          // Distinguish a real user prompt from a tool result. In opencode,
          // user prompts have no `content` field at the top level (the prompt
          // text lives in linked `part` rows); tool results carry payload.
          // We treat any user-role message as "user has acted" → cancel
          // pending notify, since it means the user already responded.
          shouldScheduleNotify = false;
          this.cancelPending();
        }
      }

      if (shouldScheduleNotify) {
        this.cancelPending();
        this.pendingNotify = setTimeout(() => {
          this.pendingNotify = null;
          if (!this.stopped) this.onActivity("waiting");
        }, 2000);
      }
    } catch {
      // sqlite locked / db missing / etc — silent retry next tick
    } finally {
      db?.close();
    }
  }

  // Scan the session's recent tool parts once, reporting both things the prompt
  // logic needs: a pending `question` box (structured, with its options) and
  // whether ANY tool is still in flight (which is what keeps a permission
  // dialog alive).
  private scanTools(): {
    question: OpencodePromptDetail | null;
    anyInFlight: boolean;
  } {
    let db: Database.Database | null = null;
    try {
      db = openDb();
      const rows = db
        .prepare(
          "SELECT data FROM part WHERE session_id = ? ORDER BY time_created DESC LIMIT 60"
        )
        .all(this.sessionId) as Array<{ data: string }>;

      let question: OpencodePromptDetail | null = null;
      let anyInFlight = false;

      for (const row of rows) {
        // Cheap pre-filter: most parts are text/reasoning/step markers.
        if (!row.data.includes(IN_FLIGHT_STATUS)) continue;
        let shape: Record<string, unknown>;
        try {
          shape = JSON.parse(row.data);
        } catch {
          continue;
        }
        if (shape.type !== "tool") continue;
        const state = shape.state as Record<string, unknown> | undefined;
        if (state?.status !== IN_FLIGHT_STATUS) continue;

        anyInFlight = true;
        if (!question && shape.tool === QUESTION_TOOL) {
          question = extractQuestionDetail(row.data);
        }
      }
      return { question, anyInFlight };
    } catch {
      // sqlite locked / db missing — report nothing rather than guessing, so a
      // transient failure can't clear a live prompt.
      return { question: null, anyInFlight: true };
    } finally {
      db?.close();
    }
  }

  // Report "prompt" once when OpenCode is blocked, and "prompt-cleared" once it
  // isn't.
  //
  // Deliberately NOT using PTY idleness the way the Claude detector does: a
  // spinner repaints throughout an OpenCode dialog, so an idle threshold can
  // never be crossed here.
  //
  // The two blocking kinds use different evidence, because that's what each one
  // leaves behind:
  //   - `question`: fully in the db. Its own `running` row both detects and
  //     clears it.
  //   - permission: not persisted at all. The terminal says a dialog appeared
  //     (latched in onPtyData, since it's painted once and never repainted), and
  //     the db's in-flight tool is what says it's still waiting — answering
  //     releases the stuck tool, flipping its row out of "running".
  private checkForPrompt() {
    if (this.stopped) return;

    const { question, anyInFlight } = this.scanTools();

    // A latched permission dialog only counts while some tool is still in
    // flight. This is what makes the latch self-clearing.
    if (this.permissionSeen && !anyInFlight) {
      this.permissionSeen = false;
      this.permissionText = "";
    }

    const blocked = question !== null || this.permissionSeen;

    if (!blocked) {
      this.blockedSince = 0;
      if (this.promptReported) {
        this.promptReported = false;
        this.onActivity("prompt-cleared");
      }
      return;
    }

    if (this.promptReported) return;

    const now = Date.now();
    if (this.blockedSince === 0) {
      this.blockedSince = now;
      return;
    }
    if (now - this.blockedSince < PROMPT_SETTLE_MS) return;

    this.promptReported = true;
    // Prefer the question box: its options are structured data, not markers.
    const detail = question ?? buildPermissionDetail(this.permissionText);
    this.onActivity("prompt", detail);
  }
}

// One-line description of an OpenCode tool call. Its tool names are lowercase
// and its inputs use different keys than Claude's, so this can't be shared.
function summarizeOpencodeTool(
  tool: string,
  input: Record<string, unknown> | undefined
): string {
  if (!input) return "";
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  switch (tool) {
    case "bash":
      return str(input.command) ?? str(input.description) ?? "";
    case "read":
      return str(input.filePath) ?? "";
    case "write":
    case "edit":
    case "apply_patch":
      return str(input.filePath) ?? str(input.path) ?? "";
    case "grep":
      return str(input.pattern) ?? "";
    case "glob":
      return str(input.pattern) ?? "";
    case "webfetch":
      return str(input.url) ?? "";
    case "task":
      return str(input.description) ?? str(input.prompt) ?? "";
    case QUESTION_TOOL: {
      // Show what was asked. Without this the transcript renders a bare
      // "question" line, which is the least useful entry on the screen given
      // it's usually the one the agent is blocked on.
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length === 0) return "";
      const first = questions[0] as Record<string, unknown>;
      return str(first.question) ?? str(first.header) ?? "";
    }
    default:
      return str(input.description) ?? str(input.command) ?? "";
  }
}

// Read the tail of an OpenCode session as reflowable lines.
//
// The `part` table holds the conversation broken into typed pieces, which maps
// onto transcript entries directly. Rows are fetched newest-first (that's what
// the index supports) and reversed, so the phone gets chronological order.
export function readOpencodeTranscript(
  sessionId: string,
  limit: number
): TranscriptEntry[] {
  let db: Database.Database | null = null;
  try {
    db = openDb();
    // Over-fetch: many rows are step markers or reasoning that get dropped, so
    // fetching exactly `limit` would usually return fewer usable entries.
    const rows = db
      .prepare(
        "SELECT p.data AS data, m.data AS message FROM part p " +
          "JOIN message m ON p.message_id = m.id " +
          "WHERE p.session_id = ? ORDER BY p.time_created DESC LIMIT ?"
      )
      .all(sessionId, limit * 6) as Array<{ data: string; message: string }>;

    const entries: TranscriptEntry[] = [];
    for (const row of rows) {
      if (entries.length >= limit) break;
      let part: Record<string, unknown>;
      try {
        part = JSON.parse(row.data);
      } catch {
        continue;
      }

      if (part.type === "text") {
        const text = typeof part.text === "string" ? part.text.trim() : "";
        if (!text) continue;
        let role = "assistant";
        try {
          const message = JSON.parse(row.message) as { role?: string };
          if (typeof message.role === "string") role = message.role;
        } catch {
          // fall back to assistant
        }
        entries.push({
          kind: role === "user" ? "user" : "assistant",
          text,
        });
        continue;
      }

      if (part.type === "tool" && typeof part.tool === "string") {
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input as Record<string, unknown> | undefined;
        entries.push({
          kind: "tool",
          tool: part.tool,
          text: summarizeOpencodeTool(part.tool, input),
          pending: state?.status === IN_FLIGHT_STATUS ? true : undefined,
        });
      }
      // step-start / step-finish / reasoning / patch: bookkeeping, not content.
    }

    return entries.reverse();
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export const opencodeBackend: Backend = {
  name: "opencode",

  spawn(_cwd: string): SpawnConfig {
    // OpenCode handles "no prior session" gracefully — always pass --continue.
    return {
      command: opencodePath,
      args: ["--continue"],
      env: buildEnv(),
    };
  },

  discoverSessionId(cwd, onFound, isClaimed): SessionDiscovery {
    return new OpencodeSessionDiscovery(cwd, onFound, isClaimed);
  },

  // `isPtyIdle` is unused: OpenCode keeps a spinner running while it blocks, so
  // idleness never happens. Blocking is detected from the db plus the painted
  // dialog instead — see OpencodeCompletionDetector.checkForPrompt.
  createCompletionDetector(sessionId, onActivity, _isPtyIdle): CompletionDetector {
    return new OpencodeCompletionDetector(sessionId, onActivity);
  },

  readTranscript(sessionId, limit): TranscriptEntry[] {
    return readOpencodeTranscript(sessionId, limit);
  },

  keystrokeForChoice(tool, index, optionCount): string | null {
    // The dialogs navigate on different axes, verified on a live TUI: permission
    // is a horizontal row (left/right), a single-select question is a vertical
    // list (up/down). Digits do nothing in either.
    if (tool === PERMISSION_TOOL) {
      return keystrokeForPermission(index, optionCount);
    }
    if (tool === QUESTION_TOOL_LABEL) {
      return keystrokeForQuestion(index, optionCount);
    }
    // Multi-select and unknown dialogs: decline rather than fire keystrokes at a
    // layout we haven't confirmed. For multi-select specifically, one tap can't
    // express the toggle-then-confirm flow, and half-answering would leave the
    // agent blocked while the phone showed the prompt as handled.
    return null;
  },

  buildResumeCommand(sessionId: string): string {
    // `opencode tui --session <id>` is the explicit form for resuming a
    // specific session in the interactive TUI (the bare `opencode --session`
    // shorthand also works, but this is unambiguous when pasted elsewhere).
    return `opencode tui --session ${sessionId}`;
  },
};

export function isOpencodeAvailable(): boolean {
  // Re-check at call time (PATH may differ from spawn time).
  try {
    execSync("command -v opencode", {
      env: { ...process.env, PATH: SEARCH_PATH },
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
