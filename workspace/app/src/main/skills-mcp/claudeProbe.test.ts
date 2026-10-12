// The Claude probe with the process faked: what it is started with, how the init
// and result lines are read, and how it fails. The fixtures are the init and
// result lines of a real probe in `multi-code` on Claude Code 2.1.296
// (2026-10-13).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChildProcess, SpawnOptions } from "child_process";
import {
  PROBE_SETTINGS,
  PROBE_TIMEOUT_MS,
  clipReason,
  gotPastHook,
  parseInit,
  probeArgs,
  probeClaude,
} from "./claudeProbe";
import type { ProbeOptions } from "./claudeProbe";
import type { SpawnFn } from "../secretary/cli";

const FIXTURES = path.join(__dirname, "__fixtures__");
const INIT_LINE = JSON.stringify(
  JSON.parse(fs.readFileSync(path.join(FIXTURES, "claude-init-2.1.296.json"), "utf8"))
);
const RESULT = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "claude-result-2.1.296.json"), "utf8")
);
const RESULT_LINE = JSON.stringify(RESULT);
const INFO_LINE = JSON.stringify({
  type: "system",
  subtype: "informational",
  content: "UserPromptSubmit operation blocked by hook",
});

function withInit(change: (init: Record<string, unknown>) => void): string {
  const init = JSON.parse(INIT_LINE);
  change(init);
  return JSON.stringify(init);
}

describe("parseInit", () => {
  it("reads the real 2.1.296 init message", () => {
    const init = parseInit(INIT_LINE);
    expect(init?.version).toBe("2.1.296");
    expect(init?.mcpServers).toEqual([
      { name: "sentry", status: "connected", source: "user" },
    ]);
    expect(init?.plugins).toHaveLength(7);
    expect(init?.plugins).toContainEqual({
      name: "omt",
      version: "3.5.0",
      source: "omt@apra-amcos-cc-marketplace",
      path: "/Users/jasenpan/.claude/plugins/cache/apra-amcos-cc-marketplace/omt/3.5.0",
    });
    // A built-in plugin has no version.
    expect(init?.plugins).toContainEqual({
      name: "cc-plugin-agents-md",
      source: "cc-plugin-agents-md@builtin",
      path: "builtin",
    });
    expect(init?.skills).toHaveLength(40);
    expect(init?.skills).toContain("digest");
    expect(init?.skills).toContain("omt:digest");
  });

  it("is null for any other line", () => {
    expect(parseInit(RESULT_LINE)).toBeNull();
    expect(parseInit(INFO_LINE)).toBeNull();
    expect(parseInit("not json")).toBeNull();
    expect(parseInit("")).toBeNull();
  });

  it("throws when a list is missing, so a renamed field can't show as empty", () => {
    const line = withInit((init) => {
      delete init.skills;
    });
    expect(() => parseInit(line)).toThrow("Claude Code's init message has no `skills` list");
  });

  it("throws on an entry it can't read", () => {
    const line = withInit((init) => {
      init.mcp_servers = [{ name: "sentry", state: "connected", source: "user" }];
    });
    expect(() => parseInit(line)).toThrow("unexpected `mcp_servers` entry");
  });
});

describe("gotPastHook", () => {
  it("is false for the real blocked run", () => {
    expect(gotPastHook(RESULT_LINE)).toBe(false);
  });

  // What the model backstop produces when the hook doesn't run: measured
  // 2026-10-13 with a project `"disableAllHooks": true`, 0 tokens and an error.
  it("is true for an error result, tokens or not", () => {
    const rejected = JSON.stringify({
      ...RESULT,
      is_error: true,
      result: "API Error (multicode-probe-no-model): 400 The provided model identifier is invalid.",
    });
    expect(gotPastHook(rejected)).toBe(true);
    expect(gotPastHook(JSON.stringify({ ...RESULT, is_error: undefined }))).toBe(true);
  });

  it("is true when any token count is above zero", () => {
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ]) {
      const line = JSON.stringify({ ...RESULT, usage: { ...RESULT.usage, [key]: 12 } });
      expect(gotPastHook(line)).toBe(true);
    }
  });

  it("is true when the cost is above zero", () => {
    expect(gotPastHook(JSON.stringify({ ...RESULT, total_cost_usd: 0.01 }))).toBe(true);
  });

  it("is true when the token counts are missing: the guard fails closed", () => {
    expect(gotPastHook(JSON.stringify({ ...RESULT, usage: undefined }))).toBe(true);
  });

  it("is null for any other line", () => {
    expect(gotPastHook(INIT_LINE)).toBeNull();
    expect(gotPastHook("not json")).toBeNull();
  });
});

describe("probeArgs", () => {
  it("never writes a session file and never runs bare", () => {
    expect(probeArgs()).toContain("--no-session-persistence");
    expect(probeArgs("/u/manager-mcp.json")).toContain("--no-session-persistence");
    expect(probeArgs()).not.toContain("--bare");
  });

  it("carries only the probe's own settings", () => {
    const args = probeArgs("/u/manager-mcp.json");
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(args[args.indexOf("--settings") + 1]).toBe(PROBE_SETTINGS);
    expect(JSON.parse(PROBE_SETTINGS)).toEqual({
      awsAuthRefresh: "false",
      // A project's or local `"disableAllHooks": true` would skip the hook.
      disableAllHooks: false,
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo probe >&2; exit 2" }] },
        ],
      },
    });
  });

  it("names a model no provider has, so a skipped hook still spends nothing", () => {
    const args = probeArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("multicode-probe-no-model");
  });

  it("puts --mcp-config before another flag, so it can't take the prompt", () => {
    const args = probeArgs("/u/manager-mcp.json");
    const at = args.indexOf("--mcp-config");
    expect(args[at + 1]).toBe("/u/manager-mcp.json");
    expect(args[at + 2]).toBe("--settings");
    expect(args.at(-1)).toBe("probe");
    expect(probeArgs()).not.toContain("--mcp-config");
  });
});

interface FakeChild {
  command: string;
  args: string[];
  options: SpawnOptions;
  kills: string[];
  print(chunk: string): void;
  printErr(chunk: string): void;
  close(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(err: Error): void;
}

let children: FakeChild[] = [];

function fakeSpawn(): SpawnFn {
  return (command, args, options) => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const fake: FakeChild = {
      command,
      args,
      options,
      kills: [],
      print: (chunk) => stdout.emit("data", chunk),
      printErr: (chunk) => stderr.emit("data", chunk),
      close(code, signal = null) {
        proc.emit("exit", code, signal);
        proc.emit("close", code, signal);
      },
      emitError: (err) => proc.emit("error", err),
    };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = (signal: string) => {
      fake.kills.push(signal);
      return true;
    };
    children.push(fake);
    return proc as unknown as ChildProcess;
  };
}

const COMMAND = { command: "/fake/claude", env: { PATH: "/fake/bin" } };
const CWD = os.tmpdir();

function options(extra: Partial<ProbeOptions> = {}): ProbeOptions {
  return { spawn: fakeSpawn(), command: COMMAND, ...extra };
}

describe("probeClaude", () => {
  beforeEach(() => {
    children = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the CLI in the cwd with stdin closed and the instance's env", async () => {
    const done = probeClaude(CWD, "/u/manager-mcp.json", options());
    const child = children[0];
    expect(child.command).toBe("/fake/claude");
    expect(child.args).toEqual(probeArgs("/u/manager-mcp.json"));
    expect(child.options.cwd).toBe(CWD);
    expect(child.options.env).toEqual(COMMAND.env);
    expect(child.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    child.print(`${INIT_LINE}\n${INFO_LINE}\n${RESULT_LINE}\n`);
    child.close(0);
    await done;
  });

  it("answers at the result line, with lines split across chunks", async () => {
    const done = probeClaude(CWD, undefined, options());
    const child = children[0];
    const all = `${INIT_LINE}\n${INFO_LINE}\n${RESULT_LINE}\n`;
    for (let i = 0; i < all.length; i += 700) child.print(all.slice(i, i + 700));
    // No close: the answer must not wait for the process to exit.
    const result = await done;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.init.skills).toHaveLength(40);
  });

  it("reads a last line that has no newline", async () => {
    const done = probeClaude(CWD, undefined, options());
    children[0].print(`${INIT_LINE}\n${RESULT_LINE}`);
    children[0].close(0);
    expect((await done).ok).toBe(true);
  });

  it("fails when the result reports tokens", async () => {
    const done = probeClaude(CWD, undefined, options());
    const spent = JSON.stringify({ ...RESULT, usage: { ...RESULT.usage, input_tokens: 9 } });
    children[0].print(`${INIT_LINE}\n${spent}\n`);
    expect(await done).toEqual({
      ok: false,
      reason: expect.stringContaining("the probe got past its prompt hook"),
    });
  });

  it("fails when the result comes with no init message", async () => {
    const done = probeClaude(CWD, undefined, options());
    children[0].print(`${INFO_LINE}\n${RESULT_LINE}\n`);
    expect(await done).toEqual({ ok: false, reason: "Claude Code printed no init message" });
  });

  it("fails with the init message's problem", async () => {
    const done = probeClaude(CWD, undefined, options());
    const bad = withInit((init) => {
      init.plugins = "seven";
    });
    children[0].print(`${bad}\n${RESULT_LINE}\n`);
    expect(await done).toEqual({
      ok: false,
      reason: "Claude Code's init message has no `plugins` list",
    });
  });

  it("fails with stderr when the CLI exits before its result", async () => {
    const done = probeClaude(CWD, "/u/missing.json", options());
    children[0].printErr(
      "Error: Invalid MCP configuration:\nMCP config file not found: /u/missing.json\n"
    );
    children[0].close(1);
    expect(await done).toEqual({
      ok: false,
      reason: "Error: Invalid MCP configuration: MCP config file not found: /u/missing.json",
    });
  });

  it("masks a credential in stderr before it becomes the reason", async () => {
    const done = probeClaude(CWD, undefined, options());
    children[0].printErr(
      'Error: SSE error, headers {"Authorization":"Bearer s3cret-token"} api_key=abc123\n'
    );
    children[0].close(1);
    const result = await done;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain("s3cret-token");
    expect(result.reason).not.toContain("abc123");
    expect(result.reason).toContain("[redacted]");
  });

  it("fails with the exit code when stderr is empty", async () => {
    const done = probeClaude(CWD, undefined, options());
    children[0].print(`${INIT_LINE}\n`);
    children[0].close(1);
    expect(await done).toEqual({
      ok: false,
      reason: "claude exited with code 1 before its result",
    });
  });

  it("fails when the CLI can't start", async () => {
    const done = probeClaude(CWD, undefined, options());
    children[0].emitError(new Error("spawn /fake/claude ENOENT"));
    expect(await done).toEqual({
      ok: false,
      reason: "couldn't start claude: spawn /fake/claude ENOENT",
    });
  });

  it("names a missing project folder instead of spawning", async () => {
    const missing = path.join(CWD, "multicode-no-such-folder-t602");
    const result = await probeClaude(missing, undefined, options());
    expect(result).toEqual({ ok: false, reason: `project folder not found: ${missing}` });
    expect(children).toHaveLength(0);
  });

  it("times out, then stops the CLI with SIGTERM and later SIGKILL", async () => {
    vi.useFakeTimers();
    const done = probeClaude(CWD, undefined, options({ killGraceMs: 3_000 }));
    children[0].print(`${INIT_LINE}\n`);
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(await done).toEqual({ ok: false, reason: "timed out after 30 s" });
    expect(children[0].kills).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(3_000);
    expect(children[0].kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stops a CLI that lingers after its result at the timeout", async () => {
    vi.useFakeTimers();
    const done = probeClaude(CWD, undefined, options());
    children[0].print(`${INIT_LINE}\n${RESULT_LINE}\n`);
    expect((await done).ok).toBe(true);
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(children[0].kills).toEqual(["SIGTERM"]);
  });

  it("leaves a CLI that exited on its own alone", async () => {
    vi.useFakeTimers();
    const done = probeClaude(CWD, undefined, options());
    children[0].print(`${INIT_LINE}\n${RESULT_LINE}\n`);
    children[0].close(0);
    await done;
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS * 2);
    expect(children[0].kills).toEqual([]);
  });
});

describe("clipReason", () => {
  it("masks bearer tokens and key-like values, and keeps the rest", () => {
    expect(clipReason("Authorization: Bearer abc.def")).toBe("Authorization: [redacted]");
    expect(clipReason('{"x-api-key": "k-123", "token":"t"}')).toBe(
      '{"x-api-key": "[redacted]", "token":"[redacted]"}'
    );
    // Two-word and spaced values lose every word, not the first.
    expect(clipReason('{"Authorization":"Basic dXNlcjpwYXNz"}')).toBe(
      '{"Authorization":"[redacted]"}'
    );
    expect(clipReason('password="correct horse battery staple" next')).toBe(
      'password="[redacted]" next'
    );
    expect(clipReason("password: correct horse battery staple\nline two")).toBe(
      "password: [redacted] line two"
    );
    // A bare scheme with no key in front.
    expect(clipReason("sent Bearer abc.def to the server")).toBe(
      "sent Bearer [redacted] to the server"
    );
    expect(clipReason("MCP config file not found: /u/x.json")).toBe(
      "MCP config file not found: /u/x.json"
    );
  });

  it("is one line of at most 300 characters", () => {
    expect(clipReason("a\n  b")).toBe("a b");
    expect(clipReason("x".repeat(400))).toHaveLength(300);
  });
});
