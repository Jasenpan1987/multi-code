// One-shot `claude -p` calls for the voice secretary: a system prompt in argv, one
// JSON object on stdin, one JSON object back. The brief writer (T-504) is the first
// prompt run through here; the reply interpreter (T-509) is the second, which is why
// the spawn lives apart from either prompt.
//
// Everything here was settled by the T-501 spike on the real CLI
// (docs/timeline/2026-10-08_brief-writer-spike.md):
//
// - **The command.** `--bare` with `--setting-sources user` still applies the `env`
//   block of `~/.claude/settings.json`, which is where the Bedrock profile lives, so
//   a Dock-launched app reaches Bedrock with no AWS variables of its own. No tools,
//   no session persistence: nothing is left in `~/.claude/projects`. Spawned with the
//   same binary and env as an instance, from the temp directory, so no project's
//   `.claude/` applies.
// - **Stdin, not argv, for the input.** The prompt has no secrets; the input holds a
//   transcript, and argv is `ps`-visible.
// - **Parsing.** The CLI explains a failure in its JSON on stdout, exit code or not
//   (`Not logged in · Please run /login`, exit 1), so stdout is read either way.
//   Prompt-only JSON parsed on 142 of 142 runs without `--json-schema`, which was
//   slower and got the brief's language wrong; the caller checks the keys it needs
//   and ignores the rest.
// - **Stopping.** SIGTERM first: the CLI exits within about half a second and
//   removes its registry entry and plugin `.in_use` markers. SIGKILL, after a grace
//   period, leaves the markers behind, and the next CLI run doesn't clear them.

import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import os from "os";
import { claudeCliCommand } from "../backends/claude";

export const SECRETARY_MODEL = "global.anthropic.claude-sonnet-5-5";

// The slowest call measured was 8.9 s, on a 75k-token input.
export const CLI_TIMEOUT_MS = 60_000;
export const KILL_GRACE_MS = 3_000;

// An expired SSO login must fail the call, not log the builder in. Their settings
// carry `awsAuthRefresh: aws sso login …`, which the CLI runs when it finds the
// credentials expired, `-p --bare` included, and which opens a browser on a screen
// nobody is watching. A key in `--settings` overrides the user file's, so this one
// process runs `false` instead: the refresh fails at once and the CLI reports the
// credential error in its result. Measured against 2.1.292 in a fake HOME (the
// spike record's T-504 addendum). `false` rather than "" because the key is typed as
// a shell command line, and a CLI that rejected an empty one would drop this whole
// flag and bring the browser back. The only `--settings`: a second would replace it.
export const NO_AUTH_REFRESH_SETTINGS = JSON.stringify({ awsAuthRefresh: "false" });

export const ABORTED_REASON = "aborted";

export function secretaryCliArgs(systemPrompt: string): string[] {
  return [
    "-p",
    "--bare",
    "--no-session-persistence",
    "--model",
    SECRETARY_MODEL,
    "--output-format",
    "json",
    "--setting-sources",
    "user",
    "--tools",
    "",
    "--settings",
    NO_AUTH_REFRESH_SETTINGS,
    "--system-prompt",
    systemPrompt,
  ];
}

export type CliResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; reason: string };

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

export interface CliOptions {
  // Aborting kills the CLI and resolves { ok: false, reason: "aborted" }.
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  // For tests. Production spawns the real binary with an instance's env.
  spawn?: SpawnFn;
  command?: { command: string; env: Record<string, string> };
}

// Run one prompt. Never rejects: every way it can go wrong is a reason.
export function runJsonPrompt(
  systemPrompt: string,
  stdin: string,
  options: CliOptions = {}
): Promise<CliResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: ABORTED_REASON });
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let child: ChildProcess | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    // Answer now and let the process die on its own time: whoever is waiting on
    // this call has already moved on.
    const stop = (result: CliResult) => {
      if (settled) return;
      finish(result);
      if (!child || exited) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) child?.kill("SIGKILL");
      }, killGraceMs);
      // Never what keeps the app from quitting.
      killTimer.unref?.();
    };

    const onAbort = () => stop({ ok: false, reason: ABORTED_REASON });
    const timer = setTimeout(
      () => stop({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)} s` }),
      timeoutMs
    );

    try {
      const { command, env } = options.command ?? claudeCliCommand();
      const spawnFn = options.spawn ?? nodeSpawn;
      child = spawnFn(command, secretaryCliArgs(systemPrompt), {
        cwd: os.tmpdir(),
        env,
        stdio: "pipe",
      });
    } catch (err) {
      finish({ ok: false, reason: `couldn't start claude: ${messageOf(err)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      exited = true;
      finish({ ok: false, reason: `couldn't start claude: ${messageOf(err)}` });
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", (code: number | null, killedBy: NodeJS.Signals | null) => {
      exited = true;
      clearTimeout(killTimer);
      finish(interpretCliOutput(stdout, stderr, code, killedBy));
    });
    // A CLI that exits before reading its input would otherwise surface as an
    // unhandled EPIPE on the stream.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// What a finished CLI process amounts to. Exported for tests.
export function interpretCliOutput(
  stdout: string,
  stderr: string,
  code: number | null,
  killedBy: NodeJS.Signals | null
): CliResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = undefined;
  }
  const record = isRecord(envelope) ? envelope : null;
  const result = typeof record?.result === "string" ? record.result.trim() : "";

  if (code !== 0 || record?.is_error === true) {
    const fallback =
      code === null ? `claude was killed (${killedBy ?? "no signal"})` : `claude exited with code ${code}`;
    return { ok: false, reason: clip(result || stderr.trim() || fallback) };
  }
  if (!record) return { ok: false, reason: "claude's output wasn't JSON" };
  if (!result) return { ok: false, reason: "claude returned no answer" };

  let answer: unknown;
  try {
    answer = JSON.parse(result);
  } catch {
    return { ok: false, reason: "claude's answer wasn't JSON" };
  }
  if (!isRecord(answer)) return { ok: false, reason: "claude's answer wasn't a JSON object" };
  return { ok: true, output: answer };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reasons reach the card; the CLI's own are one line, but stderr could be anything.
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 299)}…` : oneLine;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
