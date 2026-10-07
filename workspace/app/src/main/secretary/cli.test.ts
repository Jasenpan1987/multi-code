// The secretary's one-shot CLI call with the process faked: what it is started
// with, how its output is read, and how it is stopped on a timeout or an abort.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import os from "os";
import type { ChildProcess, SpawnOptions } from "child_process";
import {
  CLI_TIMEOUT_MS,
  KILL_GRACE_MS,
  NO_AUTH_REFRESH_SETTINGS,
  SECRETARY_MODEL,
  interpretCliOutput,
  runJsonPrompt,
  secretaryCliArgs,
} from "./cli";
import type { CliOptions, SpawnFn } from "./cli";

interface FakeChild {
  command: string;
  args: string[];
  options: SpawnOptions;
  stdin: string;
  stdinEnded: boolean;
  kills: string[];
  // Finish the process the way node reports it: output, then exit, then close.
  exit(code: number | null, signal?: NodeJS.Signals | null, stdout?: string, stderr?: string): void;
  emitError(err: Error): void;
  print(chunk: string): void;
}

let children: FakeChild[] = [];

function fakeSpawn(behaviour: { exitOnTerm?: boolean } = {}): SpawnFn {
  return (command, args, options) => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const fake: FakeChild = {
      command,
      args,
      options,
      stdin: "",
      stdinEnded: false,
      kills: [],
      exit(code, signal = null, out = "", err = "") {
        if (out) stdout.emit("data", out);
        if (err) stderr.emit("data", err);
        proc.emit("exit", code, signal);
        proc.emit("close", code, signal);
      },
      emitError(err) {
        proc.emit("error", err);
      },
      print(chunk) {
        stdout.emit("data", chunk);
      },
    };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = Object.assign(new EventEmitter(), {
      end: (data: string) => {
        fake.stdin += data;
        fake.stdinEnded = true;
      },
    });
    proc.kill = (signal: string) => {
      fake.kills.push(signal);
      if (signal === "SIGTERM" && behaviour.exitOnTerm) {
        queueMicrotask(() => fake.exit(null, "SIGTERM"));
      }
      return true;
    };
    children.push(fake);
    return proc as unknown as ChildProcess;
  };
}

const COMMAND = { command: "/fake/claude", env: { PATH: "/fake/bin" } };

function run(options: Partial<CliOptions> = {}, behaviour: { exitOnTerm?: boolean } = {}) {
  return runJsonPrompt("SYSTEM", '{"session":"x"}', {
    command: COMMAND,
    spawn: fakeSpawn(behaviour),
    ...options,
  });
}

// What `claude -p --output-format json` prints for a successful call.
function envelope(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...extra });
}

beforeEach(() => {
  children = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the call", () => {
  it("runs the spike's command, with the prompt in argv and the input on stdin", async () => {
    const pending = run();
    const child = children[0];
    expect(child.command).toBe("/fake/claude");
    expect(child.args).toEqual([
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
      "SYSTEM",
    ]);
    expect(child.options.cwd).toBe(os.tmpdir());
    expect(child.options.env).toEqual(COMMAND.env);
    expect(child.stdin).toBe('{"session":"x"}');
    expect(child.stdinEnded).toBe(true);
    child.exit(0, null, envelope('{"a":1}'));
    await pending;
  });

  it("overrides the builder's awsAuthRefresh with a command that only fails", () => {
    // An expired SSO login must fail the brief, never open a browser login.
    expect(JSON.parse(NO_AUTH_REFRESH_SETTINGS)).toEqual({ awsAuthRefresh: "false" });
    // The only --settings: a second would replace the first outright.
    expect(secretaryCliArgs("p").filter((arg) => arg === "--settings")).toHaveLength(1);
  });

  it("returns the answer's JSON object, extra keys and all", async () => {
    const pending = run();
    children[0].exit(0, null, envelope('{"language":"English","brief":"Done.","extra":null}'));
    expect(await pending).toEqual({
      ok: true,
      output: { language: "English", brief: "Done.", extra: null },
    });
  });

  it("reads output that arrives in pieces", async () => {
    const pending = run();
    const whole = envelope('{"brief":"多段"}');
    const child = children[0];
    child.print(whole.slice(0, 20));
    child.print(whole.slice(20));
    child.exit(0, null);
    expect(await pending).toEqual({ ok: true, output: { brief: "多段" } });
  });

  it("never rejects when spawning throws", async () => {
    const result = await runJsonPrompt("SYSTEM", "{}", {
      command: COMMAND,
      spawn: () => {
        throw new Error("spawn EACCES");
      },
    });
    expect(result).toEqual({ ok: false, reason: "couldn't start claude: spawn EACCES" });
  });

  it("reports a binary that can't be started", async () => {
    const pending = run();
    children[0].emitError(new Error("spawn /fake/claude ENOENT"));
    expect(await pending).toEqual({
      ok: false,
      reason: "couldn't start claude: spawn /fake/claude ENOENT",
    });
  });
});

describe("reading the output", () => {
  it("gives the CLI's own reason on is_error and a non-zero exit", () => {
    // Seen in the spike with user settings skipped: exit 1 and this result.
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    expect(interpretCliOutput(stdout, "", 1, null)).toEqual({
      ok: false,
      reason: "Not logged in · Please run /login",
    });
  });

  it("treats is_error as a failure even on exit 0", () => {
    const stdout = JSON.stringify({ is_error: true, result: "API Error: overloaded" });
    expect(interpretCliOutput(stdout, "", 0, null)).toEqual({
      ok: false,
      reason: "API Error: overloaded",
    });
  });

  it("falls back to stderr, then the exit code", () => {
    expect(interpretCliOutput("", "  boom\n  at line 2 ", 2, null)).toEqual({
      ok: false,
      reason: "boom at line 2",
    });
    expect(interpretCliOutput("", "", 2, null)).toEqual({
      ok: false,
      reason: "claude exited with code 2",
    });
    expect(interpretCliOutput("", "", null, "SIGKILL")).toEqual({
      ok: false,
      reason: "claude was killed (SIGKILL)",
    });
  });

  it("caps a long reason at one short line", () => {
    const result = interpretCliOutput("", "x".repeat(5000), 1, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeLessThanOrEqual(300);
  });

  it("fails on output that isn't JSON", () => {
    expect(interpretCliOutput("Segmentation fault", "", 0, null)).toEqual({
      ok: false,
      reason: "claude's output wasn't JSON",
    });
  });

  it("fails on an answer that isn't JSON, or isn't an object", () => {
    expect(interpretCliOutput(envelope("Here is your brief: done."), "", 0, null)).toEqual({
      ok: false,
      reason: "claude's answer wasn't JSON",
    });
    expect(interpretCliOutput(envelope('```json\n{"brief":"x"}\n```'), "", 0, null)).toEqual({
      ok: false,
      reason: "claude's answer wasn't JSON",
    });
    expect(interpretCliOutput(envelope('["a"]'), "", 0, null)).toEqual({
      ok: false,
      reason: "claude's answer wasn't a JSON object",
    });
  });

  it("fails on an empty answer", () => {
    expect(interpretCliOutput(envelope("  "), "", 0, null)).toEqual({
      ok: false,
      reason: "claude returned no answer",
    });
  });
});

describe("stopping", () => {
  it("times out: SIGTERM at the limit, SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    const pending = run();
    const child = children[0];
    vi.advanceTimersByTime(CLI_TIMEOUT_MS - 1);
    expect(child.kills).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(await pending).toEqual({ ok: false, reason: "timed out after 60 s" });
    expect(child.kills).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("doesn't SIGKILL a process that went on SIGTERM", async () => {
    vi.useFakeTimers();
    const pending = run({}, { exitOnTerm: true });
    vi.advanceTimersByTime(CLI_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: "timed out after 60 s" });
    await Promise.resolve();
    vi.advanceTimersByTime(KILL_GRACE_MS * 2);
    expect(children[0].kills).toEqual(["SIGTERM"]);
  });

  it("aborting kills the CLI and resolves aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = run({ signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    expect(children[0].kills).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(children[0].kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("an already aborted signal never starts the CLI", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run({ signal: controller.signal })).toEqual({ ok: false, reason: "aborted" });
    expect(children).toHaveLength(0);
  });

  it("an abort after the answer changes nothing", async () => {
    const controller = new AbortController();
    const pending = run({ signal: controller.signal });
    children[0].exit(0, null, envelope('{"brief":"x"}'));
    expect(await pending).toEqual({ ok: true, output: { brief: "x" } });
    controller.abort();
    expect(children[0].kills).toEqual([]);
  });
});
