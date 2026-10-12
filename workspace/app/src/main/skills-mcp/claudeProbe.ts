// What a Claude Code session started now in a directory loads, read from the CLI
// itself: `claude -p --output-format stream-json --verbose` prints a `system/init`
// message with the MCP servers, plugins and skill names before it reads the prompt
// (docs/timeline/2026-10-12_skills-mcp-inventory-investigation.md, "The init
// message"). The probe stops there, so nothing reaches the model.
//
// Settled on Claude Code 2.1.296 (docs/specs/skills-mcp/prd.md, Technical
// Constraints):
//
// - **The prompt never leaves.** A `UserPromptSubmit` hook in the probe's own
//   `--settings` exits 2, which blocks the prompt: the result reports 0 tokens and
//   `total_cost_usd` 0, in about 3 s. The same settings turn `disableAllHooks` off:
//   measured 2026-10-13, a project or local `"disableAllHooks": true` skipped the
//   hook and sent the prompt to the API, and the probe's `false` overrides both.
//   Two backstops for whatever else could skip the hook (a managed
//   `allowManagedHooksOnly`, a CLI change): a model name no provider has, which the
//   API rejects with a 400 before any tokens (the init lists are the same with it),
//   and a result that is an error or reports tokens fails the refresh.
// - **No session file.** `--no-session-persistence`. Without it each probe left an
//   empty `.jsonl`, and the project's next `claude --continue` resumed that.
// - **No SSO browser.** `awsAuthRefresh: "false"`, for the reason in
//   secretary/cli.ts (`NO_AUTH_REFRESH_SETTINGS`). It shares the one `--settings`
//   with the hook: the CLI applies only the last one it is given.
// - **No alerts.** The probe carries none of Multi-Code's hooks, and
//   `claudeCliCommand()` strips the instance and spawn ids that `/alert` routes on.
// - **Not `--bare`.** Measured 2026-10-13 in `multi-code`: `--bare` dropped every MCP
//   server and 24 of the 40 skills, and did not run the hook, so no result came.

import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import { claudeCliCommand } from "../backends/claude";
import { KILL_GRACE_MS } from "../secretary/cli";
import type { SpawnFn } from "../secretary/cli";

export const PROBE_SETTINGS = JSON.stringify({
  awsAuthRefresh: "false",
  disableAllHooks: false,
  hooks: {
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: "echo probe >&2; exit 2" }] },
    ],
  },
});

const PROBE_PROMPT = "probe";
const PROBE_MODEL = "multicode-probe-no-model";

export const PROBE_TIMEOUT_MS = 30_000;

export interface InitMcpServer {
  name: string;
  status: string;
  source: string;
}

export interface InitPlugin {
  name: string;
  // Absent for a built-in plugin, whose `path` is "builtin".
  version?: string;
  // `<plugin>@<marketplace>`, `<plugin>@builtin`, `<plugin>@inline`.
  source: string;
  path: string;
}

export interface ClaudeInit {
  mcpServers: InitMcpServer[];
  plugins: InitPlugin[];
  skills: string[];
  version: string;
}

export type ProbeResult =
  | { ok: true; init: ClaudeInit }
  | { ok: false; reason: string };

export interface ProbeOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  // For tests. Production spawns the real binary with an instance's env.
  spawn?: SpawnFn;
  command?: { command: string; env: Record<string, string> };
}

export function probeArgs(mcpConfigPath?: string): string[] {
  const args = [
    "-p",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    PROBE_MODEL,
  ];
  // Before `--settings`, never last: the flag takes every argument up to the next
  // flag. Measured 2026-10-13: `--mcp-config <file> probe` failed with "MCP config
  // file not found: <cwd>/probe".
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  args.push("--settings", PROBE_SETTINGS, PROBE_PROMPT);
  return args;
}

// The init message in a line of the probe's output, or null when the line is any
// other message. Throws when it is the init message but a list is missing or
// malformed: field names are bound to the CLI version, and a renamed field must
// fail the refresh rather than show an empty list.
export function parseInit(line: string): ClaudeInit | null {
  const message = parseRecord(line);
  if (message?.type !== "system" || message.subtype !== "init") return null;

  const mcpServers = listOf(message, "mcp_servers", (s) =>
    isRecord(s) &&
    typeof s.name === "string" &&
    typeof s.status === "string" &&
    typeof s.source === "string"
      ? { name: s.name, status: s.status, source: s.source }
      : null
  );
  const plugins = listOf(message, "plugins", (p) =>
    isRecord(p) &&
    typeof p.name === "string" &&
    typeof p.source === "string" &&
    typeof p.path === "string" &&
    (p.version === undefined || typeof p.version === "string")
      ? {
          name: p.name,
          source: p.source,
          path: p.path,
          ...(typeof p.version === "string" ? { version: p.version } : {}),
        }
      : null
  );
  const skills = listOf(message, "skills", (s) => (typeof s === "string" ? s : null));
  const version =
    typeof message.claude_code_version === "string" ? message.claude_code_version : "";
  return { mcpServers, plugins, skills, version };
}

// Whether the result line says the run got past the prompt hook, or null when the
// line is not the result. A blocked prompt is a success with no tokens; an error
// means a request went out (the model backstop's 400), and a result with no token
// count counts as past: the guard has to fail closed.
export function gotPastHook(line: string): boolean | null {
  const message = parseRecord(line);
  if (message?.type !== "result") return null;
  if (message.is_error !== false) return true;
  const usage = isRecord(message.usage) ? message.usage : null;
  const counts = [
    usage?.input_tokens,
    usage?.output_tokens,
    usage?.cache_creation_input_tokens,
    usage?.cache_read_input_tokens,
  ];
  if (!counts.every((n) => typeof n === "number")) return true;
  const cost = typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0;
  return counts.some((n) => (n as number) > 0) || cost > 0;
}

// Run one probe in `cwd`. Never rejects: every way it can go wrong is a reason.
// Answers at the result line; a process that lingers after it is stopped at the
// timeout like any other.
export function probeClaude(
  cwd: string,
  mcpConfigPath?: string,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  // Spawning in a missing directory fails as "spawn <binary> ENOENT", which
  // blames the CLI.
  if (!fs.existsSync(cwd)) {
    return Promise.resolve({ ok: false, reason: `project folder not found: ${cwd}` });
  }

  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let child: ChildProcess | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let init: ClaudeInit | null = null;
    let pending = "";
    let stderr = "";

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // SIGTERM first, as in secretary/cli.ts: SIGKILL leaves the CLI's plugin
    // `.in_use` markers behind.
    const timer = setTimeout(() => {
      finish({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)} s` });
      if (!child || exited) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) child?.kill("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);

    const onLine = (line: string) => {
      if (settled || !line.trim()) return;
      try {
        const parsed = parseInit(line);
        if (parsed) {
          init = parsed;
          return;
        }
      } catch (err) {
        finish({ ok: false, reason: messageOf(err) });
        return;
      }
      const past = gotPastHook(line);
      if (past === null) return;
      if (past) {
        finish({
          ok: false,
          reason: "the probe got past its prompt hook: Claude Code no longer stops it there",
        });
      } else if (!init) {
        finish({ ok: false, reason: "Claude Code printed no init message" });
      } else {
        finish({ ok: true, init });
      }
    };

    try {
      const { command, env } = options.command ?? claudeCliCommand();
      const spawnFn = options.spawn ?? nodeSpawn;
      child = spawnFn(command, probeArgs(mcpConfigPath), {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, reason: `couldn't start claude: ${messageOf(err)}` });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      exited = true;
      clearTimeout(timer);
      finish({ ok: false, reason: `couldn't start claude: ${messageOf(err)}` });
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", (code: number | null, killedBy: NodeJS.Signals | null) => {
      exited = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      onLine(pending);
      // Reached only when no result line came: the CLI failed before the prompt,
      // as with a bad `--mcp-config`, and said why on stderr.
      const fallback =
        code === null
          ? `claude was killed (${killedBy ?? "no signal"})`
          : `claude exited with code ${code} before its result`;
      finish({ ok: false, reason: clipReason(stderr.trim() || fallback) });
    });
  });
}

function listOf<T>(
  message: Record<string, unknown>,
  key: string,
  read: (item: unknown) => T | null
): T[] {
  const value = message[key];
  if (!Array.isArray(value)) {
    throw new Error(`Claude Code's init message has no \`${key}\` list`);
  }
  return value.map((item) => {
    const parsed = read(item);
    if (parsed === null) {
      throw new Error(`Claude Code's init message has an unexpected \`${key}\` entry`);
    }
    return parsed;
  });
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A CLI's failure text, fit for the section: one line, at most 300 characters, and
// with anything that looks like a credential masked. stderr could hold anything,
// and no token may reach the renderer (PRD Non-Functional Requirements, Secrets).
// A value after a credential key is masked whole: a quoted one to its closing
// quote, a bare one to the end of the line or the next `,` `;` `}`, so neither
// `"Basic dXNl…"` nor a password with spaces keeps a part.
export function clipReason(text: string): string {
  const masked = text
    .replace(
      /\b(authorization|x-api-key|api[-_]?key|token|password|secret)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,;}\n]+)/gi,
      (_match, key: string, separator: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
        return `${key}${separator}${quote}[redacted]${quote}`;
      }
    )
    .replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, "$1 [redacted]");
  const oneLine = masked.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 299)}…` : oneLine;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
