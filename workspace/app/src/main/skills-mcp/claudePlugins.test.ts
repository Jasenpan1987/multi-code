// Install records, enable switches and the merge that says why each plugin loads.
// `claude-plugin-list-2.1.296.json` is `claude plugin list --json` run in
// `multi-code` on 2026-10-13; `claude-init-2.1.296.json` is the probe there the
// same day. The dolce case is the state before 2026-10-12, from the table in
// docs/timeline/2026-10-12_skills-mcp-inventory-investigation.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  mergePlugins,
  parsePluginList,
  readEnableSwitches,
  readPluginState,
} from "./claudePlugins";
import type { EnableSwitches, ExecFn, PluginRecord } from "./claudePlugins";
import { parseInit } from "./claudeProbe";
import type { InitPlugin } from "./claudeProbe";

const FIXTURES = path.join(__dirname, "__fixtures__");
const LIST_OUTPUT = fs.readFileSync(path.join(FIXTURES, "claude-plugin-list-2.1.296.json"), "utf8");
const INIT = parseInit(
  JSON.stringify(
    JSON.parse(fs.readFileSync(path.join(FIXTURES, "claude-init-2.1.296.json"), "utf8"))
  )
)!;
const MULTI_CODE = "/Users/jasenpan/code/apra/multi-code";
const DOLCE = "/Users/jasenpan/code/apra/apra-amcos-admin-dolce";

describe("parsePluginList", () => {
  it("reads every record of the real output", () => {
    const records = parsePluginList(LIST_OUTPUT);
    expect(records).toHaveLength(19);
    expect(records).toContainEqual({
      id: "omt@apra-amcos-cc-marketplace",
      version: "3.5.0",
      scope: "project",
      projectPath: MULTI_CODE,
    });
    expect(records).toContainEqual({
      id: "apra-ai-ba@apra-amcos-cc-marketplace",
      version: "1.0.0",
      scope: "user",
    });
  });

  it("fails on output it can't explain", () => {
    expect(() => parsePluginList("Error: something")).toThrow("printed no JSON");
    expect(() => parsePluginList("{}")).toThrow("printed no list");
    expect(() => parsePluginList('[{"id":"a@b","scope":"user"}]')).toThrow(
      "an entry it doesn't explain"
    );
    // A renamed `projectPath` must not make a project record vanish.
    expect(() =>
      parsePluginList('[{"id":"a@b","version":"1","scope":"project","projectDirectory":"/p"}]')
    ).toThrow("an entry it doesn't explain");
  });
});

describe("mergePlugins", () => {
  // The switches in multi-code's settings files on 2026-10-13.
  const multiCodeSwitches: EnableSwitches[] = [
    { scope: "project", path: "p", enabled: { "omt@apra-amcos-cc-marketplace": true } },
    {
      scope: "user",
      path: "u",
      enabled: {
        "apra-post-release-backward-merge@apra-amcos-cc-marketplace": true,
        "cross-model-review@apra-amcos-cc-marketplace": true,
        "epcc-workflow@aws-claude-code-plugins": true,
        "agent-evals@apra-amcos-cc-marketplace": true,
      },
    },
  ];
  const multiCodeRecords = (): PluginRecord[] =>
    parsePluginList(LIST_OUTPUT).filter(
      (r) => r.scope === "user" || r.projectPath === MULTI_CODE
    );

  it("explains every plugin in multi-code", () => {
    const rows = mergePlugins(multiCodeRecords(), multiCodeSwitches, INIT.plugins);
    expect(rows.map((r) => [r.name, r.scope, r.loaded, r.note])).toEqual([
      ["apra-post-release-backward-merge", "user", true, undefined],
      ["cross-model-review", "user", true, undefined],
      ["epcc-workflow", "user", true, undefined],
      ["agent-evals", "user", true, undefined],
      ["omt", "project", true, undefined],
      ["cc-plugin-agents-md", undefined, true, undefined],
      ["cc-plugin-plugin-authoring", undefined, true, undefined],
      ["apra-ai-ba", "user", false, "installed, not enabled"],
    ]);
    expect(rows.find((r) => r.name === "omt")?.enableSwitch).toEqual({
      on: true,
      scope: "project",
    });
    expect(rows.find((r) => r.name === "apra-ai-ba")?.enableSwitch).toBeUndefined();
    expect(rows.map((r) => r.group)).toEqual([
      "global",
      "global",
      "global",
      "global",
      "project",
      "builtin",
      "builtin",
      "global",
    ]);
  });

  it("names the winner and the record it overrides (dolce before 2026-10-12)", () => {
    const records: PluginRecord[] = [
      { id: "omt@m", version: "3.4.1", scope: "project", projectPath: DOLCE },
      { id: "omt@m", version: "3.5.0", scope: "user" },
    ];
    const switches: EnableSwitches[] = [{ scope: "user", path: "u", enabled: { "omt@m": true } }];
    const loaded: InitPlugin[] = [
      { name: "omt", version: "3.4.1", source: "omt@m", path: "/cache/omt/3.4.1" },
    ];
    expect(mergePlugins(records, switches, loaded)).toEqual([
      {
        id: "omt@m",
        name: "omt",
        version: "3.4.1",
        scope: "project",
        group: "project",
        loaded: true,
        enableSwitch: { on: true, scope: "user" },
        note: "overrides user 3.5.0",
      },
      {
        id: "omt@m",
        name: "omt",
        version: "3.5.0",
        scope: "user",
        group: "global",
        loaded: false,
        enableSwitch: { on: true, scope: "user" },
        note: "overridden by this project's 3.4.1",
      },
    ]);
  });

  it("says a global winner overrides a project record", () => {
    const records: PluginRecord[] = [
      { id: "x@m", version: "1.0.0", scope: "local", projectPath: DOLCE },
      { id: "x@m", version: "2.0.0", scope: "user" },
    ];
    const loaded: InitPlugin[] = [{ name: "x", version: "2.0.0", source: "x@m", path: "/c" }];
    const rows = mergePlugins(records, [], loaded);
    expect(rows.map((r) => r.note)).toEqual(["overrides local 1.0.0", "overridden by global 2.0.0"]);
  });

  it("does not guess between two records of the loaded version", () => {
    const records: PluginRecord[] = [
      { id: "omt@m", version: "3.5.0", scope: "project", projectPath: DOLCE },
      { id: "omt@m", version: "3.5.0", scope: "user" },
    ];
    const loaded: InitPlugin[] = [{ name: "omt", version: "3.5.0", source: "omt@m", path: "/c" }];
    const rows = mergePlugins(records, [], loaded);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.loaded).toBe(true);
      expect(row.note).toBe("which of these records loaded is not stated by Claude Code");
    }
  });

  it("shows a switch with no record", () => {
    const switches: EnableSwitches[] = [
      { scope: "project", path: "p", enabled: { "gone@m": true, "off@m": false } },
    ];
    expect(mergePlugins([], switches, [])).toEqual([
      {
        id: "gone@m",
        name: "gone",
        group: "project",
        loaded: false,
        enableSwitch: { on: true, scope: "project" },
        note: "enabled, not installed",
      },
    ]);
  });

  it("lets the most specific switch decide", () => {
    const records: PluginRecord[] = [{ id: "x@m", version: "1.0.0", scope: "user" }];
    const switches: EnableSwitches[] = [
      { scope: "local", path: "l", enabled: { "x@m": false } },
      { scope: "user", path: "u", enabled: { "x@m": true } },
    ];
    expect(mergePlugins(records, switches, [])).toEqual([
      {
        id: "x@m",
        name: "x",
        version: "1.0.0",
        scope: "user",
        group: "global",
        loaded: false,
        enableSwitch: { on: false, scope: "local" },
        note: "installed, not enabled",
      },
    ]);
  });

  it("flags a loaded marketplace plugin that has no record here", () => {
    const loaded: InitPlugin[] = [{ name: "x", version: "1.0.0", source: "x@m", path: "/c" }];
    expect(mergePlugins([], [], loaded)[0].note).toBe("no install record for this project");
    const inline: InitPlugin[] = [{ name: "p", source: "p@inline", path: "/dev/p" }];
    expect(mergePlugins([], [], inline)[0].note).toBeUndefined();
  });
});

describe("readEnableSwitches", () => {
  let root: string;
  let cwd: string;
  let home: string;

  const write = (file: string, content: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "t603-"));
    cwd = path.join(root, "project");
    home = path.join(root, "home");
    fs.mkdirSync(cwd);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the three files, most specific first, booleans only", () => {
    write(path.join(cwd, ".claude/settings.local.json"), {
      enabledPlugins: { "ralph-loop@o": true },
      permissions: {},
    });
    write(path.join(cwd, ".claude/settings.json"), { enabledPlugins: { "omt@m": true } });
    write(path.join(home, ".claude/settings.json"), {
      enabledPlugins: { "a@m": true, "b@m": false, "c@m": "yes" },
      env: { SECRET: "never read" },
    });
    expect(readEnableSwitches(cwd, path.join(home, ".claude"))).toEqual([
      {
        scope: "local",
        path: path.join(cwd, ".claude/settings.local.json"),
        enabled: { "ralph-loop@o": true },
      },
      { scope: "project", path: path.join(cwd, ".claude/settings.json"), enabled: { "omt@m": true } },
      {
        scope: "user",
        path: path.join(home, ".claude/settings.json"),
        enabled: { "a@m": true, "b@m": false },
      },
    ]);
  });

  it("skips missing files and files without the key", () => {
    write(path.join(home, ".claude/settings.json"), { model: "x" });
    expect(readEnableSwitches(cwd, path.join(home, ".claude"))).toEqual([
      { scope: "user", path: path.join(home, ".claude/settings.json"), enabled: {} },
    ]);
  });

  it("fails on a settings file that isn't JSON", () => {
    write(path.join(cwd, ".claude/settings.json"), "{ not json");
    expect(() => readEnableSwitches(cwd, path.join(home, ".claude"))).toThrow(
      `${path.join(cwd, ".claude/settings.json")} is not valid JSON`
    );
  });

  it("fails on a settings file that is there but can't be read", () => {
    fs.mkdirSync(path.join(cwd, ".claude/settings.local.json"), { recursive: true });
    expect(() => readEnableSwitches(cwd, path.join(home, ".claude"))).toThrow(
      `can't read ${path.join(cwd, ".claude/settings.local.json")}: EISDIR`
    );
  });

  it("reads user settings from CLAUDE_CONFIG_DIR when the CLI's env sets it", async () => {
    const configDir = path.join(root, "custom-claude");
    write(path.join(configDir, "settings.json"), { enabledPlugins: { "x@m": true } });
    write(path.join(home, ".claude/settings.json"), { enabledPlugins: { "x@m": false } });
    const state = await readPluginState(cwd, {
      command: { command: "/fake/claude", env: { CLAUDE_CONFIG_DIR: configDir } },
      exec: (_c, _a, _o, callback) => callback(null, "[]", ""),
    });
    expect(state.ok && state.switches).toEqual([
      { scope: "user", path: path.join(configDir, "settings.json"), enabled: { "x@m": true } },
    ]);
  });
});

describe("readPluginState", () => {
  const COMMAND = { command: "/fake/claude", env: { PATH: "/fake/bin" } };
  const answering =
    (err: Error | null, stdout: string, stderr = "", calls: unknown[][] = []): ExecFn =>
    (command, args, options, callback) => {
      calls.push([command, args, options.cwd]);
      callback(err, stdout, stderr);
    };

  it("runs `claude plugin list --json` in the cwd and keeps the records that apply", async () => {
    const calls: unknown[][] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "t603-home-"));
    try {
      const state = await readPluginState(MULTI_CODE, {
        configDir: home,
        command: COMMAND,
        exec: answering(null, LIST_OUTPUT, "", calls),
      });
      expect(calls).toEqual([["/fake/claude", ["plugin", "list", "--json"], MULTI_CODE]]);
      expect(state.ok).toBe(true);
      if (!state.ok) return;
      expect(state.records.map((r) => `${r.id} ${r.scope}`)).toEqual([
        "agent-evals@apra-amcos-cc-marketplace user",
        "apra-ai-ba@apra-amcos-cc-marketplace user",
        "apra-post-release-backward-merge@apra-amcos-cc-marketplace user",
        "cross-model-review@apra-amcos-cc-marketplace user",
        "epcc-workflow@aws-claude-code-plugins user",
        "omt@apra-amcos-cc-marketplace project",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches a project path through a symlink", async () => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t603-real-")));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    try {
      const output = JSON.stringify([
        { id: "x@m", version: "1.0.0", scope: "local", projectPath: real },
      ]);
      const state = await readPluginState(link, {
        configDir: real,
        command: COMMAND,
        exec: answering(null, output),
      });
      expect(state.ok && state.records.map((r) => r.id)).toEqual(["x@m"]);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("fails with the CLI's own words", async () => {
    const state = await readPluginState(MULTI_CODE, {
      configDir: os.tmpdir(),
      command: COMMAND,
      exec: answering(new Error("Command failed"), "", "Error: plugins unavailable\n"),
    });
    expect(state).toEqual({
      ok: false,
      reason: "claude plugin list failed: Error: plugins unavailable",
    });
    const masked = await readPluginState(MULTI_CODE, {
      configDir: os.tmpdir(),
      command: COMMAND,
      exec: answering(new Error("Command failed"), "", "Authorization: Bearer s3cret\n"),
    });
    expect(masked.ok || masked.reason).not.toContain("s3cret");
  });
});
