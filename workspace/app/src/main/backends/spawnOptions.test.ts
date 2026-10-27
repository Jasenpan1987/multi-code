// What goes on the manager's command line, and what must not go on anyone else's.
//
// The pairing is the thing to protect: an MCP config without a matching allowlist
// produces a manager that can see its tools and has to ask permission for every
// call, which for an agent meant to coordinate unattended is the same as having no
// tools. Measured 2026-09-02 against the real CLI.

import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { claudeBackend } from "./claude";
import {
  buildOpencodeSpawn,
  findOpencodeBinary,
  liveServiceRegistered,
  mintOpencodeSessionId,
  opencodeBackend,
  opencodeBaseEnv,
  opencodeRefusal,
  opencodeVersion,
  parseOpencodeVersion,
  pidAlive,
  SERVICE_START_SCRIPT,
  type OpencodeSpawnHost,
} from "./opencode";
import type { SessionStart } from "./types";
import { OPENCODE_VIEW_KEYS } from "../../shared/replyStart";

// Multi-Code's keys in every OpenCode terminal it starts: Ctrl+Z off, and the two
// view keys after OpenCode's defaults for those commands (opencodePlugin.ts).
const TUI_KEYBINDS = {
  "terminal.suspend": "none",
  "session.last": ["ctrl+alt+g", "end", OPENCODE_VIEW_KEYS["session.last"].stroke],
  "session.message.previous": [OPENCODE_VIEW_KEYS["session.message.previous"].stroke],
};

// A directory with no prior claude session, so the spawn opens a new one under an
// id of its own (`--session-id <uuid>`) rather than `--continue`, and the
// assertions below are about the other flags.
const freshCwd = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-spawn-"));

const managerOpts = {
  mcpConfigPath: "/tmp/manager-mcp.json",
  settingsPath: "/tmp/manager-settings.json",
  allowedTools: [
    "mcp__multi-code__list_sessions",
    "mcp__multi-code__read_session",
  ],
};

describe("claude spawn with manager options", () => {
  it("passes the config path as a file, not inline JSON", () => {
    // Inline JSON would put the bearer token in argv, where `ps` shows it to every
    // local process — and that token grants tool access to every managed session.
    const { args } = claudeBackend.spawn(freshCwd, managerOpts);
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("/tmp/manager-mcp.json");
    expect(args.join(" ")).not.toContain("mcpServers");
  });

  it("pre-approves the tools as one comma-separated value", () => {
    const { args } = claudeBackend.spawn(freshCwd, managerOpts);
    const i = args.indexOf("--allowedTools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(
      "mcp__multi-code__list_sessions,mcp__multi-code__read_session"
    );
  });

  it("passes the settings file that makes the manager's own tools visible", () => {
    // Without this, the manager's Bash/Edit/Write go from its CLI to the machine
    // with nothing recording them — the most privileged thing it does would be the
    // only invisible thing it does.
    const { args } = claudeBackend.spawn(freshCwd, managerOpts);
    const i = args.indexOf("--settings");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("/tmp/manager-settings.json");
  });

  it("passes settings as a path, keeping the token out of argv", () => {
    // Same reason as --mcp-config above. The hook's own credential lives in the
    // curl config that this file points at, never on a command line.
    const { args } = claudeBackend.spawn(freshCwd, managerOpts);
    expect(args.join(" ")).not.toContain("Authorization");
    expect(args.join(" ")).not.toContain("hooks");
  });

  it("does not pass --strict-mcp-config, so the user's own servers stay available", () => {
    const { args } = claudeBackend.spawn(freshCwd, managerOpts);
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("adds nothing when there are no options — a project session must stay clean", () => {
    const { args } = claudeBackend.spawn(freshCwd);
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
    // A project session's tool calls are the user's own work, not the manager's,
    // and reporting them into the Manager feed would be surveillance of the user.
    expect(args).not.toContain("--settings");
  });

  it("adds nothing for an empty options object", () => {
    const { args } = claudeBackend.spawn(freshCwd, {});
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--settings");
  });

  it("still passes the mcp config when settings could not be written", () => {
    // A manager with tools but no self-reporting beats a manager with neither, so
    // a failure to write the settings file degrades the feed, not the manager.
    const { args } = claudeBackend.spawn(freshCwd, {
      mcpConfigPath: "/tmp/x.json",
      allowedTools: ["mcp__multi-code__list_sessions"],
    });
    expect(args).toContain("--mcp-config");
    expect(args).not.toContain("--settings");
  });

  it("omits the allowlist flag for an empty tool array rather than passing nothing", () => {
    // `--allowedTools ""` would be a flag with an empty value; leaving it off is
    // the same intent and can't be misparsed.
    const { args } = claudeBackend.spawn(freshCwd, {
      mcpConfigPath: "/tmp/x.json",
      allowedTools: [],
    });
    expect(args).toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
  });
});

// OpenCode's spawn reads the machine only through its host, so none of these touch
// the real HOME, DB, service registration or login shell.
function fakeHost(over: Partial<OpencodeSpawnHost> = {}): OpencodeSpawnHost {
  return {
    env: () => ({ HOME: "/Users/x", PATH: "/usr/bin:/bin", LC_CTYPE: "UTF-8" }),
    binary: () => "/Users/x/.opencode/bin/opencode",
    version: () => ({ version: "2.0.32", major: 2 }),
    serviceRunning: () => true,
    latestRootSession: () => null,
    mintSessionId: () => "ses_minted",
    readFile: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    ...over,
  };
}

const opencodePlugin = {
  pluginPath: "/Users/x/Library/Application Support/multi-code/opencode/tui",
  targetPath: "/Users/x/Library/Application Support/multi-code/opencode/alert.json",
};

describe("opencode spawn", () => {
  it("ignores manager options rather than emitting flags it doesn't support", () => {
    // OpenCode has no --allowedTools equivalent, so a manager here would stop for a
    // permission prompt on every call. The create path refuses to make one; this
    // asserts the spawn doesn't quietly produce a broken command line either.
    const { command, args } = buildOpencodeSpawn(freshCwd, managerOpts, { kind: "fresh" }, fakeHost());
    expect(command).toBe("/Users/x/.opencode/bin/opencode");
    expect(args).toEqual(["--session", "ses_minted"]);
  });

  it("always names the session, and returns it", () => {
    const cases: [SessionStart | undefined, Partial<OpencodeSpawnHost>, string][] = [
      // The contact's own, whether or not it still exists: OpenCode creates it under
      // that id on the first prompt if not.
      [{ kind: "own", sessionId: "ses_own" }, { latestRootSession: () => "ses_latest" }, "ses_own"],
      [{ kind: "latest" }, { latestRootSession: () => "ses_latest" }, "ses_latest"],
      [{ kind: "latest" }, {}, "ses_minted"],
      // The newest, checked against the other contacts as it is picked.
      [{ kind: "latest", isClaimed: () => false }, { latestRootSession: () => "ses_latest" }, "ses_latest"],
      [{ kind: "latest", isClaimed: (id) => id === "ses_held" }, { latestRootSession: () => "ses_held" }, "ses_minted"],
      [undefined, { latestRootSession: () => "ses_latest" }, "ses_latest"],
      [{ kind: "fresh" }, { latestRootSession: () => "ses_latest" }, "ses_minted"],
    ];
    for (const [session, over, expected] of cases) {
      const { args, sessionId } = buildOpencodeSpawn(freshCwd, undefined, session, fakeHost(over));
      expect(args).toEqual(["--session", expected]);
      expect(sessionId).toBe(expected);
      expect(args).not.toContain("--continue");
    }
  });

  it("asks for the directory's newest root session with the contact's cwd, after the env", () => {
    // The env first: the login shell may move OpenCode's database, and the newest
    // session has to come from the database the TUI will open.
    const asked: string[] = [];
    const host = fakeHost({
      latestRootSession: (cwd) => {
        asked.push(cwd);
        return null;
      },
    });
    const env = host.env;
    host.env = () => {
      asked.push("env");
      return env();
    };
    buildOpencodeSpawn(freshCwd, undefined, { kind: "latest" }, host);
    expect(asked).toEqual(["env", freshCwd]);
  });

  it("turns Ctrl+Z off, leaves tabs to the builder, and loads Multi-Code's plugin by directory", () => {
    const { env } = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "fresh" }, fakeHost());
    // No `tabs` key: the builder's cli.json (or OpenCode's default) decides, as in any
    // terminal (builder, 2026-10-20).
    expect(JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT)).toEqual({
      keybinds: TUI_KEYBINDS,
      plugins: [{ package: opencodePlugin.pluginPath }],
    });
    expect(env.MULTICODE_ALERT_FILE).toBe(opencodePlugin.targetPath);
    // Nothing for the server: no server plugin, no config the shared service could
    // inherit (decisions.md 2026-10-16), no config dir replacing the user's.
    expect(Object.keys(env).filter((key) => key.startsWith("OPENCODE_CONFIG"))).toEqual([]);
  });

  it("keeps the builder's cli.json plugins, read from the spawn env's config dir", () => {
    const read: string[] = [];
    const { env } = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "fresh" }, fakeHost({
      env: () => ({ HOME: "/Users/x", XDG_CONFIG_HOME: "/Users/x/cfg", PATH: "/usr/bin" }),
      readFile: (file) => {
        read.push(file);
        return JSON.stringify({ plugins: ["./mine", "npm-plugin"] });
      },
    }));
    expect(read).toEqual(["/Users/x/cfg/opencode/cli.json"]);
    expect(JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT).plugins).toEqual([
      "/Users/x/cfg/opencode/mine",
      "npm-plugin",
      { package: opencodePlugin.pluginPath },
    ]);
  });

  it("spawns without the plugin when cli.json can't be read safely", () => {
    const { env } = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "fresh" }, fakeHost({
      readFile: () => "{ broken",
    }));
    expect(JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT)).toEqual({
      keybinds: TUI_KEYBINDS,
    });
    expect(env.MULTICODE_ALERT_FILE).toBeUndefined();
  });

  it("leaves an inherited OPENCODE_CLI_CONFIG_CONTENT it can't read untouched, and spawns without the plugin", () => {
    const broken = '{ "theme": ';
    const { env } = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "fresh" }, fakeHost({
      env: () => ({ PATH: "/usr/bin", OPENCODE_CLI_CONFIG_CONTENT: broken }),
    }));
    expect(env.OPENCODE_CLI_CONFIG_CONTENT).toBe(broken);
    expect(env.MULTICODE_ALERT_FILE).toBeUndefined();
  });

  it("merges into an inherited OPENCODE_CLI_CONFIG_CONTENT", () => {
    const { env } = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "fresh" }, fakeHost({
      env: () => ({ PATH: "/usr/bin", OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ theme: { name: "nord" } }) }),
    }));
    expect(JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT)).toEqual({
      theme: { name: "nord" },
      keybinds: TUI_KEYBINDS,
      plugins: [{ package: opencodePlugin.pluginPath }],
    });
  });

  it("sets only the TUI settings without the option", () => {
    const { env } = buildOpencodeSpawn(freshCwd, { settingsPath: "/tmp/alert-settings.json" }, { kind: "fresh" }, fakeHost());
    expect(JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT).plugins).toBeUndefined();
    expect(env.MULTICODE_ALERT_FILE).toBeUndefined();
  });

  it("runs the TUI directly when a live service is registered", () => {
    const { command, args } = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "fresh" }, fakeHost());
    expect(command).toBe("/Users/x/.opencode/bin/opencode");
    expect(args).toEqual(["--session", "ses_minted"]);
  });

  it("starts a missing service first, from the pty's shell, then execs the TUI", () => {
    const checked: Record<string, string>[] = [];
    const { command, args, env, sessionId } = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "fresh" }, fakeHost({
      serviceRunning: (e) => {
        checked.push(e);
        return false;
      },
    }));
    expect(command).toBe("/bin/sh");
    expect(args).toEqual(["-c", SERVICE_START_SCRIPT, "/Users/x/.opencode/bin/opencode", "--session", "ses_minted"]);
    expect(sessionId).toBe("ses_minted");
    // The registration is looked for with the env the TUI gets (its XDG_STATE_HOME).
    expect(checked[0]).toBe(env);
  });

  it("refuses OpenCode 1.x with the upgrade command, spawning nothing it needs", () => {
    const config = buildOpencodeSpawn(freshCwd, { opencodePlugin }, { kind: "own", sessionId: "ses_x" }, fakeHost({
      version: () => ({ version: "1.18.35", major: 1 }),
    }));
    expect(config.refusal).toBe(
      "Multi-Code needs OpenCode 2 (found 1.18.35). Upgrade with: curl -fsSL https://opencode.ai/v2/install | bash"
    );
    expect(opencodeRefusal("1.2.3")).toContain("(found 1.2.3)");
  });

  it("still starts an OpenCode whose version it can't tell", () => {
    const config = buildOpencodeSpawn(freshCwd, undefined, { kind: "fresh" }, fakeHost({ version: () => null }));
    expect(config.refusal).toBeUndefined();
    expect(config.args).toEqual(["--session", "ses_minted"]);
  });

  it("resumes elsewhere with the command the TUI itself prints", () => {
    expect(opencodeBackend.buildResumeCommand("ses_abc")).toBe("opencode -s ses_abc");
  });
});

describe("the service start wrapper", () => {
  it("keeps Multi-Code's variables away from the service and execs the TUI in place", () => {
    for (const name of [
      "MULTICODE_INSTANCE_ID",
      "MULTICODE_SPAWN_ID",
      "MULTICODE_ALERT_FILE",
      "OPENCODE_CLI_CONFIG_CONTENT",
      "CLAUDE_CODE_SSE_PORT",
    ]) {
      expect(SERVICE_START_SCRIPT).toContain(`-u ${name}`);
    }
    expect(SERVICE_START_SCRIPT).toMatch(/^\/usr\/bin\/env .* "\$0" service start >\/dev\/null 2>&1; exec "\$0" "\$@"$/);
  });

  it("runs as sh runs it: the service start without Multi-Code's env, then the TUI with it", () => {
    // A stand-in binary that records its argv and the env names it saw; nothing of
    // OpenCode runs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-wrapper-"));
    const log = path.join(dir, "log");
    const fake = path.join(dir, "fake opencode");
    fs.writeFileSync(
      fake,
      `#!/bin/sh\necho "argv:$*" >> '${log}'\nenv | cut -d= -f1 | grep -E '^(MULTICODE_|OPENCODE_CLI|KEEP_ME)' | sort | tr '\\n' ' ' >> '${log}'\necho >> '${log}'\n`,
      { mode: 0o755 }
    );
    const result = spawnSync("/bin/sh", ["-c", SERVICE_START_SCRIPT, fake, "--session", "ses_x y"], {
      env: {
        PATH: "/usr/bin:/bin",
        KEEP_ME: "1",
        MULTICODE_INSTANCE_ID: "i",
        MULTICODE_SPAWN_ID: "s",
        MULTICODE_ALERT_FILE: "/f",
        OPENCODE_CLI_CONFIG_CONTENT: "{}",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.trim())).toEqual([
      "argv:service start",
      "KEEP_ME",
      "argv:--session ses_x y",
      "KEEP_ME MULTICODE_ALERT_FILE MULTICODE_INSTANCE_ID MULTICODE_SPAWN_ID OPENCODE_CLI_CONFIG_CONTENT",
    ]);
  });
});

describe("liveServiceRegistered", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-state-"));
  const env = { XDG_STATE_HOME: state, HOME: "/nonexistent" };
  const file = path.join(state, "opencode", "service.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const register = (body: unknown) => fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));

  it("is true for a registration whose pid is alive", () => {
    register({ id: "x", url: "http://127.0.0.1:49374", pid: process.pid, password: "p" });
    expect(liveServiceRegistered(env)).toBe(true);
  });

  it("is false for a dead pid, a broken file or none", () => {
    const dead = spawnSync("/usr/bin/true").pid!;
    register({ url: "http://127.0.0.1:49374", pid: dead });
    expect(liveServiceRegistered(env, (pid) => pid === process.pid)).toBe(false);
    register("{ not json");
    expect(liveServiceRegistered(env)).toBe(false);
    register({ url: "x", pid: "12" });
    expect(liveServiceRegistered(env)).toBe(false);
    fs.rmSync(file);
    expect(liveServiceRegistered(env)).toBe(false);
  });

  it("checks a pid with signal 0 only", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(spawnSync("/usr/bin/true").pid!)).toBe(false);
  });
});

describe("OpenCode's version", () => {
  it("parses what --version prints", () => {
    expect(parseOpencodeVersion("opencode v2.0.32\n")).toEqual({ version: "2.0.32", major: 2 });
    expect(parseOpencodeVersion("1.18.35\n")).toEqual({ version: "1.18.35", major: 1 });
    expect(parseOpencodeVersion("opencode v2.1.0-beta.3")).toEqual({ version: "2.1.0-beta.3", major: 2 });
    expect(parseOpencodeVersion("command not found")).toBeNull();
    expect(parseOpencodeVersion("")).toBeNull();
  });

  it("asks a binary once, and again after it changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-version-"));
    const binary = path.join(dir, "opencode");
    fs.writeFileSync(binary, "one");
    const outputs = ["1.18.35", "opencode v2.0.32"];
    let runs = 0;
    const run = () => outputs[runs++] ?? null;
    expect(opencodeVersion(binary, {}, run)).toEqual({ version: "1.18.35", major: 1 });
    expect(opencodeVersion(binary, {}, run)).toEqual({ version: "1.18.35", major: 1 });
    expect(runs).toBe(1);
    // The installer's binary keeps a fixed mtime; the replaced file is still noticed.
    const { mtime } = fs.statSync(binary);
    fs.rmSync(binary);
    fs.writeFileSync(binary, "two, longer");
    fs.utimesSync(binary, mtime, mtime);
    expect(opencodeVersion(binary, {}, run)).toEqual({ version: "2.0.32", major: 2 });
    expect(runs).toBe(2);
  });

  it("doesn't cache an answer it couldn't read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-version-"));
    const binary = path.join(dir, "opencode");
    fs.writeFileSync(binary, "x");
    let runs = 0;
    const run = () => (runs++ === 0 ? "garbage" : "opencode v2.0.32");
    expect(opencodeVersion(binary, {}, run)).toBeNull();
    expect(opencodeVersion(binary, {}, run)).toEqual({ version: "2.0.32", major: 2 });
  });
});

describe("findOpencodeBinary", () => {
  it("takes the first executable opencode on the env's PATH", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-bin-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-bin-b-"));
    fs.writeFileSync(path.join(a, "opencode"), "", { mode: 0o644 });
    fs.mkdirSync(path.join(b, "nested"));
    fs.writeFileSync(path.join(b, "opencode"), "", { mode: 0o755 });
    expect(findOpencodeBinary({ PATH: `relative:${a}:${b}` })).toBe(path.join(b, "opencode"));
    expect(findOpencodeBinary({ PATH: a })).toBeNull();
    expect(findOpencodeBinary({})).toBeNull();
  });
});

describe("OpenCode session ids", () => {
  it("are minted in OpenCode's own format", () => {
    const id = mintOpencodeSessionId(1792430000000, (n) => new Uint8Array(n).fill(61));
    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(id).toHaveLength(30);
    expect(id.endsWith("z".repeat(14))).toBe(true);
    // The probe's id from the spike (identifier.ts algorithm): same time prefix shape.
    expect(mintOpencodeSessionId()).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("sort newest first, as OpenCode's descending ids do", () => {
    const t = 1792430000000;
    const ids = [
      mintOpencodeSessionId(t),
      mintOpencodeSessionId(t),
      mintOpencodeSessionId(t + 1),
      mintOpencodeSessionId(t + 60_000),
    ];
    const sorted = [...ids].sort();
    expect(sorted).toEqual([...ids].reverse());
  });

  it("encode the bit-inverted ms * 4096 + counter", () => {
    const t = 1792430000123;
    const id = mintOpencodeSessionId(t + 7);
    const value = BigInt.asUintN(48, ~(BigInt(t + 7) * 0x1000n + 1n));
    expect(id.slice(4, 16)).toBe(value.toString(16).padStart(12, "0"));
  });
});

describe("an inherited instance id", () => {
  // A dev build launched from inside a Multi-Code session inherits that session's
  // MULTICODE_INSTANCE_ID. Passed on, every agent it starts would report its
  // alerts as the parent's instance.
  it("is stripped from every env a backend builds", () => {
    const before = {
      instance: process.env.MULTICODE_INSTANCE_ID,
      spawn: process.env.MULTICODE_SPAWN_ID,
      alertFile: process.env.MULTICODE_ALERT_FILE,
    };
    process.env.MULTICODE_INSTANCE_ID = "parent-instance";
    process.env.MULTICODE_SPAWN_ID = "parent-spawn";
    process.env.MULTICODE_ALERT_FILE = "/parent/opencode/alert.json";
    try {
      for (const env of [claudeBackend.spawn(freshCwd).env, opencodeBaseEnv(null)]) {
        expect(env.MULTICODE_INSTANCE_ID).toBeUndefined();
        expect(env.MULTICODE_SPAWN_ID).toBeUndefined();
      }
      // OpenCode's plugin reads its token from the file this names, so a parent's
      // must never reach an OpenCode spawned without the plugin.
      expect(opencodeBaseEnv(null).MULTICODE_ALERT_FILE).toBeUndefined();
    } finally {
      if (before.instance === undefined) delete process.env.MULTICODE_INSTANCE_ID;
      else process.env.MULTICODE_INSTANCE_ID = before.instance;
      if (before.spawn === undefined) delete process.env.MULTICODE_SPAWN_ID;
      else process.env.MULTICODE_SPAWN_ID = before.spawn;
      if (before.alertFile === undefined) delete process.env.MULTICODE_ALERT_FILE;
      else process.env.MULTICODE_ALERT_FILE = before.alertFile;
    }
  });
});

describe("an OpenCode spawn's env", () => {
  const login = {
    HOME: "/Users/x",
    PATH: "/Users/x/.nvm/versions/node/v24/bin:/usr/bin:/bin",
    NVM_DIR: "/Users/x/.nvm",
    LANG: "en_US.UTF-8",
    // A login shell started from a Multi-Code terminal, or rc files exporting them.
    MULTICODE_INSTANCE_ID: "parent",
    MULTICODE_SPAWN_ID: "parent-spawn",
    MULTICODE_ALERT_FILE: "/parent/alert.json",
    MULTICODE_ANYTHING: "x",
    CLAUDE_CODE_SSE_PORT: "12345",
  };

  it("is the login shell's, with Multi-Code's variables and Claude's IDE port taken out", () => {
    const env = opencodeBaseEnv(login, () => ({ FALLBACK: "1" }), ["/Users/x/.opencode/bin", "/usr/bin"]);
    expect(env).toEqual({
      HOME: "/Users/x",
      PATH: "/Users/x/.nvm/versions/node/v24/bin:/usr/bin:/bin:/Users/x/.opencode/bin",
      NVM_DIR: "/Users/x/.nvm",
      LANG: "en_US.UTF-8",
    });
  });

  it("gets a UTF-8 locale when the login shell sets none", () => {
    expect(opencodeBaseEnv({ PATH: "/usr/bin" }, () => ({}), []).LC_CTYPE).toBe("UTF-8");
  });

  it("falls back to Multi-Code's own env without the login shell's", () => {
    expect(opencodeBaseEnv(null, () => ({ FALLBACK: "1" }))).toEqual({ FALLBACK: "1" });
    const before = process.env.CLAUDE_CODE_SSE_PORT;
    process.env.CLAUDE_CODE_SSE_PORT = "12345";
    try {
      // The TUI would connect to that Claude IDE socket as its editor.
      expect(opencodeBaseEnv(null).CLAUDE_CODE_SSE_PORT).toBeUndefined();
      expect(opencodeBaseEnv(null).PATH).toContain(".opencode/bin");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_SSE_PORT;
      else process.env.CLAUDE_CODE_SSE_PORT = before;
    }
  });
});

describe("the spawn locale", () => {
  // A Dock launch has no locale, and Claude Code's `pbcopy` then puts mojibake on
  // the clipboard.
  const keys = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
  function withLocale(values: Partial<Record<(typeof keys)[number], string>>, check: () => void) {
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) {
      if (values[k] === undefined) delete process.env[k];
      else process.env[k] = values[k];
    }
    try {
      check();
    } finally {
      for (const k of keys) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  }

  it("is UTF-8 when the app was given none", () => {
    withLocale({}, () => {
      for (const env of [claudeBackend.spawn(freshCwd).env, opencodeBaseEnv(null)]) {
        expect(env.LC_CTYPE).toBe("UTF-8");
        expect(env.LANG).toBeUndefined();
      }
    });
  });

  it("is left alone when the user set one", () => {
    withLocale({ LANG: "zh_CN.UTF-8" }, () => {
      for (const env of [claudeBackend.spawn(freshCwd).env, opencodeBaseEnv(null)]) {
        expect(env.LANG).toBe("zh_CN.UTF-8");
        expect(env.LC_CTYPE).toBeUndefined();
      }
    });
  });
});

describe("claude spawn with the OpenCode plugin option", () => {
  it("ignores it", () => {
    const { args, env } = claudeBackend.spawn(freshCwd, { opencodePlugin });
    expect(args).toEqual(["--session-id", expect.any(String)]);
    expect(env.MULTICODE_ALERT_FILE).toBeUndefined();
    expect(env.OPENCODE_CLI_CONFIG_CONTENT).toBe(process.env.OPENCODE_CLI_CONFIG_CONTENT);
  });
});

describe("claude spawn with session options", () => {
  it("passes the alert settings file, and nothing of the manager's", () => {
    const { args } = claudeBackend.spawn(freshCwd, { settingsPath: "/tmp/alert-settings.json" });
    expect(args).toEqual([
      "--session-id",
      expect.any(String),
      "--settings",
      "/tmp/alert-settings.json",
    ]);
  });
});
