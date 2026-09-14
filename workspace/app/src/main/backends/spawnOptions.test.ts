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

  it("does not pass --strict-mcp-config, so the user's own servers stay available", () => {
    const { args } = claudeBackend.spawn(freshCwd, managerOpts);
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("adds nothing when there are no options — a project session must stay clean", () => {
    const { args } = claudeBackend.spawn(freshCwd);
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
  });

  it("adds nothing for an empty options object", () => {
    const { args } = claudeBackend.spawn(freshCwd, {});
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
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
