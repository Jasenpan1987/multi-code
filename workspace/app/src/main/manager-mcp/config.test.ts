// The thing worth testing here is the file mode. The token in this file is the
// only thing standing between any local process and the ability to dispatch work
// into every session Multi-Code manages, so 0600 is the point of the module —
// and writeFileSync's mode silently does nothing when the file already exists.
//
// The settings/hook half is tested for the same property from the other side: the
// token must not reach the hook's command line, where `ps` shows it to every
// process on the machine.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// A space in the path on purpose: the real userData dir on macOS is under
// "Application Support", and an unquoted path there breaks the hook command.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode mcp-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const {
  writeMcpConfig,
  writeManagerSettings,
  removeManagerSpawnFiles,
  MCP_SERVER_NAME,
} = await import("./config");

const configFile = path.join(userData, "manager-mcp.json");
const settingsFile = path.join(userData, "manager-settings.json");
const curlFile = path.join(userData, "manager-hook.curl");
const target = { endpoint: "http://127.0.0.1:54321/mcp", token: "tok_abc" };

afterEach(() => {
  removeManagerSpawnFiles();
});

describe("writeMcpConfig", () => {
  it("writes the shape the CLI expects", () => {
    const file = writeMcpConfig(target);
    expect(file).toBe(configFile);
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(parsed).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: "http://127.0.0.1:54321/mcp",
          headers: { Authorization: "Bearer tok_abc" },
        },
      },
    });
  });

  it("writes the file 0600", () => {
    writeMcpConfig(target);
    const mode = fs.statSync(configFile).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("forces 0600 even when a laxer file was already there", () => {
    // The regression this guards: writeFileSync's `mode` applies only when
    // creating, so overwriting a 0644 file left the token world-readable.
    fs.writeFileSync(configFile, "{}", { mode: 0o644 });
    fs.chmodSync(configFile, 0o644);
    writeMcpConfig(target);
    const mode = fs.statSync(configFile).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("returns null and writes nothing for a null target", () => {
    expect(writeMcpConfig(null)).toBeNull();
    expect(fs.existsSync(configFile)).toBe(false);
  });
});

describe("writeManagerSettings", () => {
  it("registers the same hook on both PreToolUse and PostToolUse", () => {
    const file = writeManagerSettings(target);
    expect(file).toBe(settingsFile);
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(Object.keys(parsed)).toEqual(["hooks"]);
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
    ]);
    // Two phases of one entry in the feed, so both must fire for the same tools.
    expect(parsed.hooks.PreToolUse).toEqual(parsed.hooks.PostToolUse);
  });

  it("matches the tools that act and not the ones that only look", () => {
    writeManagerSettings(target);
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const matcher = new RegExp(parsed.hooks.PreToolUse[0].matcher);
    for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(matcher.test(tool)).toBe(true);
    }
    // Reads would fill a 200-entry feed with what the manager looked at and push
    // the dispatches — the entries the user is scanning for — off the end.
    for (const tool of ["Read", "Grep", "Glob", "TodoWrite"]) {
      expect(matcher.test(tool)).toBe(false);
    }
    // Anchored, so a future tool doesn't ride in on a prefix.
    expect(matcher.test("BashOutput")).toBe(false);
  });

  it("keeps the bearer token out of the hook command line", () => {
    // The whole reason the curl config file exists. A hook runs as a child
    // process, so anything in its argv is readable by every process on the
    // machine via `ps` — and this token can dispatch work into every session.
    writeManagerSettings(target);
    const raw = fs.readFileSync(settingsFile, "utf8");
    expect(raw).not.toContain(target.token);
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("curl -K");
  });

  it("quotes the config path, which really does contain a space", () => {
    writeManagerSettings(target);
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const command: string = parsed.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toContain(`'${curlFile}'`);
  });

  it("ends the hook command so it cannot fail the tool it reports on", () => {
    // A PreToolUse hook exiting 2 blocks the call. Reporting must never be able
    // to disarm the manager, whatever happens to the server or to curl.
    writeManagerSettings(target);
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toMatch(/\|\| true$/);
  });

  it("carries no permission rules", () => {
    // Deliberate, and the reason this assertion exists rather than the absence
    // just being true today: the manager is meant to be able to verify a claim
    // and fix something small itself. A deny list here is how it became the
    // assistant that told the user to go and run things by hand (T-215). Its
    // bound is this feed plus the user's own rules.
    writeManagerSettings(target);
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(parsed.permissions).toBeUndefined();
  });

  it("writes the curl config 0600 with the token and the hook endpoint", () => {
    writeManagerSettings(target);
    const mode = fs.statSync(curlFile).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
    const body = fs.readFileSync(curlFile, "utf8");
    expect(body).toContain(`header = "Authorization: Bearer ${target.token}"`);
    expect(body).toContain(`url = "http://127.0.0.1:54321/hook"`);
    // Reads the hook delivery from the hook command's stdin.
    expect(body).toContain(`data-binary = "@-"`);
    // A hook runs on every tool call, so it must never become the slow part.
    expect(body).toContain("max-time = 2");
  });

  it("forces 0600 on the curl config even when a laxer file was there", () => {
    fs.writeFileSync(curlFile, "stale", { mode: 0o644 });
    fs.chmodSync(curlFile, 0o644);
    writeManagerSettings(target);
    expect((fs.statSync(curlFile).mode & 0o777).toString(8)).toBe("600");
  });

  it("refuses a token that would break out of the quoted config value", () => {
    // Never happens with a base64url token, which is why this is a guard rather
    // than an escaping routine: writing a broken config would put the credential
    // somewhere unintended.
    for (const token of ['tok"abc', "tok\\abc", "tok\nabc"]) {
      expect(writeManagerSettings({ ...target, token })).toBeNull();
      expect(fs.existsSync(settingsFile)).toBe(false);
    }
  });

  it("returns null and writes nothing for a null target", () => {
    expect(writeManagerSettings(null)).toBeNull();
    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(fs.existsSync(curlFile)).toBe(false);
  });
});


describe("removeManagerSpawnFiles", () => {
  it("deletes every file, so a dead token doesn't outlive the run", () => {
    writeMcpConfig(target);
    writeManagerSettings(target);
    expect(fs.existsSync(configFile)).toBe(true);
    expect(fs.existsSync(settingsFile)).toBe(true);
    expect(fs.existsSync(curlFile)).toBe(true);
    removeManagerSpawnFiles();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(fs.existsSync(curlFile)).toBe(false);
  });

  it("is a no-op when the files are already gone", () => {
    expect(() => removeManagerSpawnFiles()).not.toThrow();
  });
});
