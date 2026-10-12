// Groups, skill scopes, MCP overrides and duplicates, on temp folders and a fake
// home. The fixtures' init message is the real probe in `multi-code` on 2.1.296.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  claudeConfigPaths,
  groupOf,
  mcpItems,
  pluginGroupOf,
  readLocalConfig,
  skillItems,
} from "./claudeScopes";
import type { LocalConfig } from "./claudeScopes";
import { parseInit } from "./claudeProbe";
import type { SkillsMcpPlugin } from "../../shared/types";

const FIXTURES = path.join(__dirname, "__fixtures__");
const INIT = parseInit(
  JSON.stringify(
    JSON.parse(fs.readFileSync(path.join(FIXTURES, "claude-init-2.1.296.json"), "utf8"))
  )
)!;

let root: string;
let cwd: string;
let home: string;

const write = (file: string, content: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
};
const skillFolder = (base: string, name: string) =>
  write(path.join(base, ".claude/skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
// The fake home's config, laid out as the CLI keeps it without CLAUDE_CONFIG_DIR.
const paths = () => ({
  configDir: path.join(home, ".claude"),
  claudeJson: path.join(home, ".claude.json"),
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t604-")));
  cwd = path.join(root, "project");
  home = path.join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("groupOf", () => {
  it("puts each scope the CLI names in its group", () => {
    expect(["local", "project", "user", "managed", "claude.ai", "dynamic", "built-in", "agent"].map(groupOf))
      .toEqual(["project", "project", "global", "global", "global", "session", "builtin", "other"]);
  });

  it("places a plugin by its record, its source, or its switch", () => {
    expect(pluginGroupOf({ id: "omt@m", scope: "project" })).toBe("project");
    expect(pluginGroupOf({ id: "a@builtin" })).toBe("builtin");
    expect(pluginGroupOf({ id: "a@inline" })).toBe("session");
    expect(pluginGroupOf({ id: "a@m", enableSwitch: { on: true, scope: "user" } })).toBe("global");
    expect(pluginGroupOf({ id: "a@m" })).toBe("other");
  });
});

describe("claudeConfigPaths", () => {
  it("follows CLAUDE_CONFIG_DIR, .claude.json included", () => {
    expect(claudeConfigPaths({}, "/Users/x", "/p")).toEqual({
      configDir: "/Users/x/.claude",
      claudeJson: "/Users/x/.claude.json",
    });
    expect(claudeConfigPaths({ CLAUDE_CONFIG_DIR: "/c" }, "/Users/x", "/p")).toEqual({
      configDir: "/c",
      claudeJson: "/c/.claude.json",
    });
    // Relative to the instance's cwd, where the CLI runs, not Electron's.
    expect(claudeConfigPaths({ CLAUDE_CONFIG_DIR: ".agent" }, "/Users/x", "/p")).toEqual({
      configDir: "/p/.agent",
      claudeJson: "/p/.agent/.claude.json",
    });
  });
});

describe("readLocalConfig", () => {
  it("lists skill folders at project and user scope", () => {
    skillFolder(cwd, "digest");
    skillFolder(home, "notes");
    // A loose file, and a folder with no SKILL.md, are not skills.
    write(path.join(cwd, ".claude/skills/README.md"), "x");
    fs.mkdirSync(path.join(cwd, ".claude/skills/notes"));
    const config = readLocalConfig(cwd, paths());
    expect(config.skillFolders).toEqual({ project: ["digest"], user: ["notes"] });
  });

  it("follows a symlinked skill folder", () => {
    skillFolder(root, "shared");
    fs.mkdirSync(path.join(cwd, ".claude/skills"), { recursive: true });
    fs.symlinkSync(path.join(root, ".claude/skills/shared"), path.join(cwd, ".claude/skills/shared"));
    expect(readLocalConfig(cwd, paths()).skillFolders.project).toEqual(["shared"]);
  });

  it("reads MCP names by key only, never a value", () => {
    write(path.join(home, ".claude.json"), {
      mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev", headers: { Authorization: "Bearer s3cret" } } },
      projects: {
        [cwd]: { mcpServers: { sentry: { command: "npx", env: { TOKEN: "s3cret" } } } },
        "/elsewhere": { mcpServers: { figma: {} } },
      },
    });
    write(path.join(cwd, ".mcp.json"), { mcpServers: { brave: { command: "x", env: { KEY: "s3cret" } } } });
    const config = readLocalConfig(cwd, paths());
    expect(config.mcpNames).toEqual({
      ok: true,
      local: ["sentry"],
      project: ["brave"],
      user: ["sentry"],
    });
    expect(JSON.stringify(config)).not.toContain("s3cret");
  });

  it("finds the local entry under the resolved path, before the path as given", () => {
    const link = `${cwd}-link`;
    fs.symlinkSync(cwd, link);
    write(path.join(home, ".claude.json"), { projects: { [cwd]: { mcpServers: { a: {} } } } });
    const config = readLocalConfig(link, paths());
    expect(config.mcpNames.ok && config.mcpNames.local).toEqual(["a"]);

    write(path.join(home, ".claude.json"), {
      projects: { [link]: {}, [cwd]: { mcpServers: { sentry: {} } } },
    });
    const both = readLocalConfig(link, paths());
    expect(both.mcpNames.ok && both.mcpNames.local).toEqual(["sentry"]);
  });

  it("fails MCP on a config file that is there but can't be read", () => {
    fs.mkdirSync(path.join(home, ".claude.json"));
    expect(readLocalConfig(cwd, paths()).mcpNames).toEqual({
      ok: false,
      reason: `can't read ${path.join(home, ".claude.json")}: EISDIR`,
    });
  });

  it("is empty when nothing is set, and fails MCP alone on a broken file", () => {
    expect(readLocalConfig(cwd, paths())).toEqual({
      skillFolders: { project: [], user: [] },
      mcpNames: { ok: true, local: [], project: [], user: [] },
    });
    write(path.join(cwd, ".mcp.json"), "{ nope");
    skillFolder(cwd, "digest");
    const config = readLocalConfig(cwd, paths());
    expect(config.mcpNames).toEqual({
      ok: false,
      reason: `${path.join(cwd, ".mcp.json")} is not valid JSON`,
    });
    expect(config.skillFolders.project).toEqual(["digest"]);
  });
});

describe("mcpItems", () => {
  const names = (n: Partial<Record<"local" | "project" | "user", string[]>>) => ({
    ok: true as const,
    local: [],
    project: [],
    user: [],
    ...n,
  });

  it("shows the probe's winner and greys the definitions it beat", () => {
    const rows = mcpItems(
      [{ name: "sentry", status: "connected", source: "local" }],
      names({ local: ["sentry"], user: ["sentry"] })
    );
    expect(rows).toEqual([
      {
        name: "sentry",
        status: "connected",
        scope: "local",
        group: "project",
        loaded: true,
        note: "overrides user",
      },
      { name: "sentry", scope: "user", group: "global", loaded: false, note: "overridden by local" },
    ]);
  });

  it("puts the manager's --mcp-config server under This session, marked Multi-Code", () => {
    const rows = mcpItems([{ name: "multi-code", status: "connected", source: "dynamic" }], names({}));
    expect(rows).toEqual([
      {
        name: "multi-code",
        status: "connected",
        scope: "dynamic",
        group: "session",
        loaded: true,
        multiCode: true,
      },
    ]);
  });

  it("reads the real multi-code probe: sentry under Global", () => {
    expect(mcpItems(INIT.mcpServers, names({ user: ["sentry"] }))).toEqual([
      { name: "sentry", status: "connected", scope: "user", group: "global", loaded: true },
    ]);
  });
});

describe("skillItems", () => {
  const omt: SkillsMcpPlugin = {
    id: "omt@m",
    name: "omt",
    version: "3.5.0",
    scope: "project",
    group: "project",
    loaded: true,
  };
  const folders = (f: Partial<LocalConfig["skillFolders"]>) => ({ project: [], user: [], ...f });

  it("gives each kind of skill its scope", () => {
    const rows = skillItems(
      ["work", "notes", "omt:handoff", "dataviz"],
      [omt],
      folders({ project: ["work"], user: ["notes"] })
    );
    expect(rows).toEqual([
      { name: "work", scope: "project", group: "project" },
      { name: "notes", scope: "user", group: "global" },
      { name: "omt:handoff", scope: "project", group: "project" },
      { name: "dataviz", scope: "built-in", group: "builtin" },
    ]);
  });

  it("shows both copies when a name has a folder at both scopes", () => {
    const rows = skillItems(["notes"], [], folders({ project: ["notes"], user: ["notes"] }));
    expect(rows).toEqual([
      { name: "notes", scope: "project", group: "project", note: "which copy loaded is not stated by Claude Code" },
      { name: "notes", scope: "user", group: "global", note: "which copy loaded is not stated by Claude Code" },
    ]);
  });

  it("marks a project skill and a plugin skill of the same name as duplicates", () => {
    const rows = skillItems(["digest", "omt:digest"], [omt], folders({ project: ["digest"] }));
    expect(rows.map((r) => [r.name, r.duplicates])).toEqual([
      ["digest", ["omt:digest"]],
      ["omt:digest", ["digest"]],
    ]);
  });

  it("finds the seven duplicate pairs in multi-code", () => {
    const projectSkills = ["digest", "gaps", "guide", "help", "kanban", "milestone", "prd", "prepare-meeting", "qa", "teach", "work"];
    const rows = skillItems(INIT.skills, [omt], folders({ project: projectSkills }));
    const marked = rows.filter((r) => r.duplicates && !r.name.includes(":")).map((r) => r.name);
    expect(marked).toEqual(["digest", "guide", "kanban", "prd", "qa", "teach", "work"]);
    expect(rows).toHaveLength(40);
    expect(rows.filter((r) => r.group === "project")).toHaveLength(21);
    expect(rows.filter((r) => r.group === "builtin")).toHaveLength(16);
  });

  it("does not guess a plugin skill's scope", () => {
    const user: SkillsMcpPlugin = { ...omt, scope: "user", group: "global" };
    const twoRecords = skillItems(["omt:qa"], [omt, user], folders({}));
    expect(twoRecords.map((r) => [r.scope, r.note])).toEqual([
      ["project", "which copy loaded is not stated by Claude Code"],
      ["user", "which copy loaded is not stated by Claude Code"],
    ]);
    expect(skillItems(["omt:qa"], null, folders({}))).toEqual([
      { name: "omt:qa", scope: "plugin", group: "other", note: "the plugin's scope is unknown" },
    ]);
    expect(skillItems(["gone:qa"], [omt], folders({}))[0].note).toBe(
      "plugin gone is not in the Plugins list"
    );
  });
});
