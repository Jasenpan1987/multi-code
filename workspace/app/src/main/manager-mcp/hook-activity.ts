// Turns a Claude Code hook delivery into an entry in the manager's activity feed.
//
// Why this exists. T-210 records every call the manager makes *through our MCP
// server*, which covers everything it does to other sessions. It does not cover
// what the manager does with its own hands: its `Bash`, `Edit` and `Write` calls
// go straight from its CLI to the machine and never touch our server. That was
// the largest of them going unseen — the manager runs `cd <a user repo> && git …`
// in real use, and the user authorised it to act unattended on the condition that
// nothing it does is invisible.
//
// The CLI's own hooks are the only seam that reports those calls, so the manager
// spawns with a `--settings` file (see config.ts) whose PreToolUse/PostToolUse
// hooks POST the delivery back to the same server, with the same bearer token.
//
// This is deliberately not "hooks middleware", which CLAUDE.md rules out. Nothing
// here decides anything: the hook never blocks a call, never rewrites one, and its
// failure changes nothing about what the manager is able to do. It is a report
// after the fact, and the feed is strictly better informed for it.
//
// Both halves of a call share a `tool_use_id`, verified against the real CLI
// (2.1.273), which is what makes the two-phase entry possible.

import path from "path";
import { managerActivityLog } from "./activity-log";

// Tools worth a row in the feed: the shell, and anything that edits a file.
//
// Read/Grep/Glob are deliberately absent. The feed holds 200 entries and is read
// by a human, so its capacity belongs to what the manager *did*, not what it
// looked at — a single turn can read a dozen files and would push real dispatches
// off the end. Reads also change nothing, which is the property that makes them
// safe to leave out. This string is a regex, matched by the CLI against the tool
// name; `^…$` so a future `BashOutput` doesn't ride in on `Bash`.
export const SELF_TOOL_MATCHER =
  "^(Bash|Edit|Write|MultiEdit|NotebookEdit|KillShell)$";

// Beyond this a payload is not more informative, just longer. The feed truncates
// again at its own limit; this keeps a whole written file out of the POST body in
// the first place.
const MAX_PAYLOAD = 2000;

// The hook posts to the same server as the tools, on a different path, so this is
// derived from the MCP endpoint rather than configured separately — one port, one
// token, one thing to get right. Lives here rather than in config.ts so that
// nothing needing it has to acquire that module's dependency on electron.
export function hookEndpointFor(mcpEndpoint: string): string | null {
  try {
    const url = new URL(mcpEndpoint);
    url.pathname = "/hook";
    return url.toString();
  } catch {
    return null;
  }
}

export interface HookDelivery {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  cwd?: unknown;
}

export type HookOutcome = "started" | "finished" | "ignored";

// Records the delivery and says what it did, so the HTTP layer can answer
// something meaningful and a test can assert on it without reading the feed.
export function recordHookDelivery(delivery: HookDelivery): HookOutcome {
  const event = str(delivery.hook_event_name);
  const tool = str(delivery.tool_name);
  const key = str(delivery.tool_use_id);
  if (!tool || !key) return "ignored";

  const input = isRecord(delivery.tool_input) ? delivery.tool_input : {};

  if (event === "PreToolUse") {
    managerActivityLog.startSelf(key, tool, {
      payload: formatInput(tool, input, str(delivery.cwd)),
    });
    return "started";
  }

  if (event === "PostToolUse") {
    const outcome = formatResponse(delivery.tool_response);
    // No matching PreToolUse: the app can start listening between a call's two
    // hooks, and dropping the half we did get would hide a real call. Open and
    // close one entry so it appears complete rather than stuck on `running`.
    if (!managerActivityLog.finishSelf(key, outcome)) {
      managerActivityLog.startSelf(key, tool, {
        payload: formatInput(tool, input, str(delivery.cwd)),
      });
      managerActivityLog.finishSelf(key, outcome);
    }
    return "finished";
  }

  return "ignored";
}

// Bash gets its bare command, because that is the whole of what it did and a
// JSON wrapper only makes it harder to read at a glance. Everything else is its
// arguments, with any bulk field replaced by its size: the feed's job is to show
// *which* file was written, and a whole file body would fill the row and push
// four other calls out of view.
function formatInput(
  tool: string,
  input: Record<string, unknown>,
  cwd: string
): string {
  if (tool === "Bash") {
    const command = str(input.command);
    return command || "(no command)";
  }

  const parts: string[] = [];
  const file = str(input.file_path) || str(input.notebook_path);
  if (file) parts.push(displayPath(file, cwd));

  for (const [field, value] of Object.entries(input)) {
    if (field === "file_path" || field === "notebook_path") continue;
    if (typeof value === "string") {
      // Bulk becomes a size. A written file body or a large replacement fills the
      // row and pushes four other calls out of view, and its length is the part
      // that tells the user how big a change this was.
      parts.push(
        value.length > 120 ? `${field}: ${value.length} chars` : `${field}: ${value}`
      );
    } else if (value !== undefined) {
      parts.push(`${field}: ${short(JSON.stringify(value))}`);
    }
  }
  return truncate(parts.join(" · ")) || "(no arguments)";
}

// Relative only when the file really is under the cwd. The manager's cwd is its
// own workspace under userData, so almost everything it edits is somewhere else
// entirely, and path.relative answers that with a chain of `../../..` that leaves
// the user working out which repo was touched. The absolute path names it.
function displayPath(file: string, cwd: string): string {
  if (!cwd) return file;
  const relative = path.relative(cwd, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return file;
  }
  return relative;
}

// A tool's own report of how it went. `interrupted` is the one signal the CLI
// gives for a call that did not complete, so it is the only thing treated as a
// failure here — a shell command exiting non-zero is ordinary and often the
// point (`git diff --quiet`), and colouring those red would train the user to
// ignore the colour.
function formatResponse(response: unknown): { ok: boolean; text: string } {
  if (typeof response === "string") {
    return { ok: true, text: truncate(response) };
  }
  if (!isRecord(response)) {
    return { ok: true, text: "" };
  }

  const interrupted = response.interrupted === true;
  const pieces: string[] = [];
  const stdout = str(response.stdout);
  const stderr = str(response.stderr);
  if (stdout) pieces.push(stdout);
  if (stderr) pieces.push(`stderr: ${stderr}`);
  if (pieces.length === 0) {
    // Edit and Write report their result in fields of their own rather than as
    // stdout, and an empty row would read as "nothing happened".
    pieces.push(short(JSON.stringify(response)));
  }
  if (interrupted) pieces.unshift("interrupted");

  return { ok: !interrupted, text: truncate(pieces.join("\n")) };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(text: string | undefined): string {
  if (!text) return "";
  return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
}

function truncate(text: string): string {
  return text.length <= MAX_PAYLOAD ? text : `${text.slice(0, MAX_PAYLOAD)}…`;
}
