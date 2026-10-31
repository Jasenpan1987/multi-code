// The thing worth testing here is the file mode. The token in these files is the
// only thing standing between any local process and the ability to light up any
// contact and raise dialog cards on a paired phone, so 0600 is the point of the
// module, and writeFileSync's mode silently does nothing when the file already
// exists.
//
// The hook command is tested for the same property from the other side: the token
// must not reach the hook's command line, where `ps` shows it to every process on
// the machine.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// A space in the path on purpose: the real userData dir on macOS is under
// "Application Support", and an unquoted path there breaks the hook command.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode alert-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const {
  writeAlertSettings,
  writeOpencodePlugin,
  removeSpawnFiles,
  ALERT_HOOK_EVENTS,
} = await import("./config");
const { opencodePluginSource } = await import("../backends/opencodePlugin");

const alertSettingsFile = path.join(userData, "alert-settings.json");
const alertCurlFile = path.join(userData, "alert-hook.curl");
const alert = { endpoint: "http://127.0.0.1:54321/alert", token: "alert_tok_xyz" };
const opencodeDir = path.join(userData, "opencode");
const opencodePluginDir = path.join(opencodeDir, "tui");
const opencodePluginFile = path.join(opencodePluginDir, "tui.js");
const opencodeAlertFile = path.join(opencodeDir, "alert.json");

const modeOf = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

afterEach(() => {
  removeSpawnFiles();
});

describe("writeAlertSettings", () => {
  function read() {
    return JSON.parse(fs.readFileSync(alertSettingsFile, "utf8"));
  }

  it("registers exactly the events the attention logic acts on, and nothing per tool call", () => {
    expect(writeAlertSettings(alert)).toBe(alertSettingsFile);
    const parsed = read();
    expect(Object.keys(parsed)).toEqual(["hooks"]);
    expect(Object.keys(parsed.hooks).sort()).toEqual([...ALERT_HOOK_EVENTS].sort());
    // A hook on every tool call would cost every call a curl, for nothing the
    // attention logic needs.
    expect(parsed.hooks.PreToolUse).toBeUndefined();
    expect(parsed.hooks.PostToolUse).toBeUndefined();
  });

  it("posts the delivery with the instance header, async, and can never fail the agent", () => {
    writeAlertSettings(alert);
    for (const entries of Object.values(read().hooks) as { hooks: Record<string, unknown>[] }[][]) {
      expect(entries).toHaveLength(1);
      const [hook] = entries[0].hooks;
      expect(hook.type).toBe("command");
      // async: the CLI waits for a synchronous hook; a report must never make the
      // agent wait on Multi-Code.
      expect(hook.async).toBe(true);
      expect(hook.timeout).toBe(5);
      const command = hook.command as string;
      expect(command).toContain(`curl -K '${alertCurlFile}'`);
      expect(command).toContain('-H "X-Multicode-Instance: $MULTICODE_INSTANCE_ID"');
      expect(command).toContain('-H "X-Multicode-Spawn: $MULTICODE_SPAWN_ID"');
      expect(command).toMatch(/\|\| true$/);
    }
  });

  it("keeps the token out of the settings file and behind a 0600 curl config", () => {
    writeAlertSettings(alert);
    expect(fs.readFileSync(alertSettingsFile, "utf8")).not.toContain(alert.token);
    const body = fs.readFileSync(alertCurlFile, "utf8");
    expect(body).toContain(`url = "${alert.endpoint}"`);
    expect(body).toContain(`header = "Authorization: Bearer ${alert.token}"`);
    expect(body).toContain(`data-binary = "@-"`);
    expect(body).toContain(`output = "/dev/null"`);
    expect(modeOf(alertCurlFile)).toBe("600");
  });

  it("writes the settings file 0600, even over a laxer one", () => {
    fs.writeFileSync(alertSettingsFile, "{}", { mode: 0o644 });
    fs.chmodSync(alertSettingsFile, 0o644);
    writeAlertSettings(alert);
    expect(modeOf(alertSettingsFile)).toBe("600");
  });

  it("carries no permission rules", () => {
    // These hooks report what an agent does; they must never change what it may do.
    writeAlertSettings(alert);
    expect(read().permissions).toBeUndefined();
  });

  it("returns null and writes nothing for a null target or an unquotable token", () => {
    expect(writeAlertSettings(null)).toBeNull();
    expect(writeAlertSettings({ ...alert, token: 'tok"x' })).toBeNull();
    expect(fs.existsSync(alertSettingsFile)).toBe(false);
  });
});

describe("writeOpencodePlugin", () => {
  it("writes the TUI plugin as <dir>/tui.js and the file it reads its target from, both 0600", () => {
    // OpenCode names a TUI plugin by its directory and loads `<dir>/tui.js` (spike
    // G-601), so the directory is what the spawn is given.
    const written = writeOpencodePlugin(alert);
    expect(written).toEqual({ pluginPath: opencodePluginDir, targetPath: opencodeAlertFile });
    expect(fs.readFileSync(opencodePluginFile, "utf8")).toBe(opencodePluginSource());
    expect(JSON.parse(fs.readFileSync(opencodeAlertFile, "utf8"))).toEqual(alert);
    expect(modeOf(opencodeAlertFile)).toBe("600");
    expect(modeOf(opencodePluginFile)).toBe("600");
    // Nothing else in the plugin's directory that OpenCode could take for an entry.
    expect(fs.readdirSync(opencodePluginDir)).toEqual(["tui.js"]);
  });

  it("keeps both directories 0700, even ones a laxer earlier run left", () => {
    fs.mkdirSync(opencodePluginDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(opencodeDir, 0o755);
    fs.chmodSync(opencodePluginDir, 0o755);
    writeOpencodePlugin(alert);
    expect(modeOf(opencodeDir)).toBe("700");
    expect(modeOf(opencodePluginDir)).toBe("700");
  });

  it("keeps the token out of the plugin itself", () => {
    writeOpencodePlugin(alert);
    expect(fs.readFileSync(opencodePluginFile, "utf8")).not.toContain(alert.token);
  });

  it("forces 0600 on the target file even over a laxer one", () => {
    writeOpencodePlugin(alert);
    fs.chmodSync(opencodeAlertFile, 0o644);
    writeOpencodePlugin(alert);
    expect(modeOf(opencodeAlertFile)).toBe("600");
  });

  it("returns null and writes nothing for a null target", () => {
    expect(writeOpencodePlugin(null)).toBeNull();
    expect(fs.existsSync(opencodeDir)).toBe(false);
  });
});

describe("removeSpawnFiles", () => {
  it("deletes the files the retired manager spawned with, which carry a token", () => {
    const legacy = ["manager-mcp.json", "manager-settings.json", "manager-hook.curl"].map(
      (name) => path.join(userData, name)
    );
    for (const file of legacy) fs.writeFileSync(file, "tok_old", { mode: 0o600 });
    removeSpawnFiles();
    for (const file of legacy) expect(fs.existsSync(file)).toBe(false);
  });

  it("deletes the alert files, so a dead token doesn't outlive the run", () => {
    writeAlertSettings(alert);
    removeSpawnFiles();
    expect(fs.existsSync(alertSettingsFile)).toBe(false);
    expect(fs.existsSync(alertCurlFile)).toBe(false);
  });

  it("deletes OpenCode's TUI plugin, its target file and their folders", () => {
    writeOpencodePlugin(alert);
    removeSpawnFiles();
    expect(fs.existsSync(opencodeDir)).toBe(false);
  });

  it("deletes the server plugin an older Multi-Code left there too", () => {
    writeOpencodePlugin(alert);
    fs.writeFileSync(path.join(opencodeDir, "multicode-plugin.js"), "// 1.x");
    removeSpawnFiles();
    expect(fs.existsSync(opencodeDir)).toBe(false);
  });

  it("leaves a folder holding something it didn't write", () => {
    writeOpencodePlugin(alert);
    fs.writeFileSync(path.join(opencodePluginDir, "theirs.txt"), "x");
    removeSpawnFiles();
    expect(fs.readdirSync(opencodePluginDir)).toEqual(["theirs.txt"]);
    fs.rmSync(opencodeDir, { recursive: true });
  });

  it("is a no-op when the files are already gone", () => {
    expect(() => removeSpawnFiles()).not.toThrow();
  });
});
