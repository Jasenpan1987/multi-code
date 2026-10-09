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
import { claudeBackend } from "./claude";
import { opencodeBackend } from "./opencode";

// A directory with no prior claude session, so `--continue` isn't added and the
// assertions below are about the manager flags alone.
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

describe("opencode spawn", () => {
  it("ignores manager options rather than emitting flags it doesn't support", () => {
    // OpenCode has no --allowedTools equivalent, so a manager here would stop for a
    // permission prompt on every call. The create path refuses to make one; this
    // asserts the spawn doesn't quietly produce a broken command line either.
    const { args } = opencodeBackend.spawn(freshCwd, managerOpts);
    expect(args).toEqual(["--continue"]);
  });
});

describe("opencode spawn with the alert plugin", () => {
  // userData on macOS has a space in it, so the file URL must be encoded.
  const opencodePlugin = {
    pluginPath: "/Users/x/Library/Application Support/multi-code/opencode/multicode-plugin.js",
    targetPath: "/Users/x/Library/Application Support/multi-code/opencode/alert.json",
  };
  const pluginUrl =
    "file:///Users/x/Library/Application%20Support/multi-code/opencode/multicode-plugin.js";

  function withInheritedContent(value: string | undefined, fn: () => void) {
    const before = process.env.OPENCODE_CONFIG_CONTENT;
    if (value === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = value;
    try {
      fn();
    } finally {
      if (before === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = before;
    }
  }

  it("names the plugin in OPENCODE_CONFIG_CONTENT and its target file by path", () => {
    withInheritedContent(undefined, () => {
      const { args, env } = opencodeBackend.spawn(freshCwd, { opencodePlugin });
      expect(args).toEqual(["--continue"]);
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ plugin: [pluginUrl] });
      expect(env.MULTICODE_ALERT_FILE).toBe(opencodePlugin.targetPath);
      // Never OPENCODE_CONFIG_DIR: it replaces the global config dir, dropping the
      // user's AGENTS.md.
      expect(env.OPENCODE_CONFIG_DIR).toBe(process.env.OPENCODE_CONFIG_DIR);
    });
  });

  it("merges into the user's own OPENCODE_CONFIG_CONTENT", () => {
    withInheritedContent(JSON.stringify({ model: "x/y", plugin: ["theirs"] }), () => {
      const { env } = opencodeBackend.spawn(freshCwd, { opencodePlugin });
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
        model: "x/y",
        plugin: ["theirs", pluginUrl],
      });
    });
  });

  it("leaves a value it can't merge untouched and spawns without the plugin", () => {
    const jsonc = '{ // theirs\n "model": "x/y" }';
    withInheritedContent(jsonc, () => {
      const { env } = opencodeBackend.spawn(freshCwd, { opencodePlugin });
      expect(env.OPENCODE_CONFIG_CONTENT).toBe(jsonc);
      expect(env.MULTICODE_ALERT_FILE).toBeUndefined();
    });
  });

  it("adds nothing without the option", () => {
    withInheritedContent(undefined, () => {
      const { env } = opencodeBackend.spawn(freshCwd, { settingsPath: "/tmp/alert-settings.json" });
      expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(env.MULTICODE_ALERT_FILE).toBeUndefined();
    });
  });

  it("is ignored by claude", () => {
    const { args, env } = claudeBackend.spawn(freshCwd, { opencodePlugin });
    expect(args).toEqual([]);
    expect(env.MULTICODE_ALERT_FILE).toBeUndefined();
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
      for (const backend of [claudeBackend, opencodeBackend]) {
        const { env } = backend.spawn(freshCwd);
        expect(env.MULTICODE_INSTANCE_ID).toBeUndefined();
        expect(env.MULTICODE_SPAWN_ID).toBeUndefined();
      }
      // OpenCode's plugin reads its token from the file this names, so a parent's
      // must never reach an OpenCode spawned without the plugin.
      expect(opencodeBackend.spawn(freshCwd).env.MULTICODE_ALERT_FILE).toBeUndefined();
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
      for (const backend of [claudeBackend, opencodeBackend]) {
        const { env } = backend.spawn(freshCwd);
        expect(env.LC_CTYPE).toBe("UTF-8");
        expect(env.LANG).toBeUndefined();
      }
    });
  });

  it("is left alone when the user set one", () => {
    withLocale({ LANG: "zh_CN.UTF-8" }, () => {
      for (const backend of [claudeBackend, opencodeBackend]) {
        const { env } = backend.spawn(freshCwd);
        expect(env.LANG).toBe("zh_CN.UTF-8");
        expect(env.LC_CTYPE).toBeUndefined();
      }
    });
  });
});

describe("claude spawn with session options", () => {
  it("passes the alert settings file, and nothing of the manager's", () => {
    const { args } = claudeBackend.spawn(freshCwd, { settingsPath: "/tmp/alert-settings.json" });
    expect(args).toEqual(["--settings", "/tmp/alert-settings.json"]);
  });
});
