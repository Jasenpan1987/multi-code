// Where each MCP server and skill a Claude session loads is set, and what else
// shares its name (T-604; docs/specs/skills-mcp/prd.md, Stories 2 and 3).
//
// - **MCP.** The probe's `source` names the winner's scope; Claude's own
//   precedence decides it, never this file. Other definitions of the same name are
//   found by key only, in `~/.claude.json` (`mcpServers` for user,
//   `projects[<cwd>].mcpServers` for local) and `<cwd>/.mcp.json` (project). No
//   value under a key is read past its name: a server's env and headers can hold
//   secrets, and none of it may reach the renderer.
// - **Skills.** The init message gives names only, so the scope follows from the
//   name and the folders: a `<plugin>:` prefix is that plugin's scope, a folder
//   under `<cwd>/.claude/skills/` is `project`, under `~/.claude/skills/` is
//   `user`, and anything else ships with the CLI
//   (docs/timeline/2026-10-12_skills-mcp-inventory-investigation.md, "Scope of
//   each kind").
//
// Measured 2026-10-13 on 2.1.296 in a scratch project: a `sentry` in `.mcp.json`
// beat the user's `sentry`, and the probe said `source: "project"`. A plugin's MCP
// server, declared in its `.mcp.json` or its `plugin.json`, did not appear in the
// init message at all, so no source format is assumed for one.

import fs from "fs";
import path from "path";
import { resolvePath } from "../backends/resolvePath";
import type {
  SkillsMcpGroup,
  SkillsMcpPlugin,
  SkillsMcpServer,
  SkillsMcpSkill,
} from "../../shared/types";
import type { InitMcpServer } from "./claudeProbe";

// Where the CLI keeps its user config. `CLAUDE_CONFIG_DIR`, when the env it runs
// with sets it, moves `settings.json`, `skills/` and `.claude.json` into that folder
// (measured 2026-10-13: `CLAUDE_CONFIG_DIR=<dir> claude plugin list` wrote
// `<dir>/.claude.json`). Without it they are `~/.claude/` and `~/.claude.json`. A
// relative one is taken from `cwd`, where the CLI runs.
export interface ClaudeConfigPaths {
  configDir: string;
  claudeJson: string;
}

export function claudeConfigPaths(
  env: Record<string, string | undefined>,
  home: string,
  cwd: string
): ClaudeConfigPaths {
  const dir = env.CLAUDE_CONFIG_DIR && path.resolve(cwd, env.CLAUDE_CONFIG_DIR);
  return dir
    ? { configDir: dir, claudeJson: path.join(dir, ".claude.json") }
    : { configDir: path.join(home, ".claude"), claudeJson: path.join(home, ".claude.json") };
}

// A config file's text, or null when it doesn't exist. Any other failure throws:
// a file that is there but unreadable must fail its part, not read as empty.
export function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(
      `can't read ${file}: ${code ?? (err instanceof Error ? err.message : String(err))}`,
      { cause: err }
    );
  }
}

export type McpNames =
  | { ok: true; local: string[]; project: string[]; user: string[] }
  | { ok: false; reason: string };

export interface LocalConfig {
  // Folder names under `<cwd>/.claude/skills/` and `~/.claude/skills/`.
  skillFolders: { project: string[]; user: string[] };
  mcpNames: McpNames;
}

export function groupOf(scope: string): SkillsMcpGroup {
  switch (scope) {
    case "local":
    case "project":
      return "project";
    case "user":
    case "managed":
    case "enterprise":
    case "claude.ai":
    case "claudeai":
      return "global";
    case "dynamic":
      return "session";
    case "built-in":
      return "builtin";
    default:
      return "other";
  }
}

// A plugin row's group: its record's scope. A plugin with no record goes by what
// its source says it is, and a switch with no record by the file it is in.
export function pluginGroupOf(
  plugin: Pick<SkillsMcpPlugin, "id" | "scope" | "enableSwitch">
): SkillsMcpGroup {
  if (plugin.scope) return groupOf(plugin.scope);
  if (plugin.id.endsWith("@builtin")) return "builtin";
  // `--plugin-dir`, a command-line flag. Multi-Code never passes one to the probe.
  if (plugin.id.endsWith("@inline")) return "session";
  if (plugin.enableSwitch) return groupOf(plugin.enableSwitch.scope);
  return "other";
}

// The skill folders and the MCP names a session in `cwd` could load from.
// Missing files and folders are empty. A config file that can't be read or isn't
// JSON fails the MCP part only.
export function readLocalConfig(cwd: string, paths: ClaudeConfigPaths): LocalConfig {
  return {
    skillFolders: {
      project: skillFolderNames(path.join(cwd, ".claude", "skills")),
      user: skillFolderNames(path.join(paths.configDir, "skills")),
    },
    mcpNames: readMcpNames(cwd, paths.claudeJson),
  };
}

// The folders under `dir` that hold a `SKILL.md`, symlinked ones included. A
// folder without one is not a skill, and counting it would invent a second copy.
function skillFolderNames(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      return fs.statSync(path.join(dir, name, "SKILL.md")).isFile();
    } catch {
      return false;
    }
  });
}

function readMcpNames(cwd: string, claudeJson: string): McpNames {
  const projectFile = path.join(cwd, ".mcp.json");
  try {
    const user = readJson(claudeJson);
    const project = readJson(projectFile);
    const projects = isRecord(user?.projects) ? user.projects : {};
    // The CLI keys a project by the path it resolved, so that form comes first;
    // the path as given is the fallback.
    const entry = [resolvePath(cwd), cwd]
      .map((key) => projects[key])
      .find((value) => isRecord(value));
    return {
      ok: true,
      local: keysOf(isRecord(entry) ? entry.mcpServers : undefined),
      project: keysOf(project?.mcpServers),
      user: keysOf(user?.mcpServers),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// One row per server the session starts, then one per other definition of its
// name, greyed, right after it.
export function mcpItems(servers: InitMcpServer[], names: McpNames & { ok: true }): SkillsMcpServer[] {
  const rows: SkillsMcpServer[] = [];
  for (const server of servers) {
    const losers = (["local", "project", "user"] as const).filter(
      (scope) => scope !== server.source && names[scope].includes(server.name)
    );
    rows.push({
      name: server.name,
      status: server.status,
      scope: server.source,
      group: groupOf(server.source),
      loaded: true,
      // The probe's only command-line config is the manager's, which Multi-Code
      // writes, so every `dynamic` server is Multi-Code's.
      ...(server.source === "dynamic" ? { multiCode: true } : {}),
      ...(losers.length ? { note: `overrides ${losers.join(", ")}` } : {}),
    });
    for (const scope of losers) {
      rows.push({
        name: server.name,
        scope,
        group: groupOf(scope),
        loaded: false,
        note: `overridden by ${server.source}`,
      });
    }
  }
  return rows;
}

// One row per skill name, or one per copy when a name has a folder at both
// project and user scope, since the init message doesn't say which loaded.
// `plugins` is null when the Plugins part failed: a plugin's skills then have no
// scope to show.
export function skillItems(
  skills: string[],
  plugins: SkillsMcpPlugin[] | null,
  folders: LocalConfig["skillFolders"]
): SkillsMcpSkill[] {
  const rows: SkillsMcpSkill[] = [];
  for (const name of skills) {
    const duplicates = relatedNames(name, skills);
    const marks = duplicates.length ? { duplicates } : {};
    const colon = name.indexOf(":");

    if (colon > 0) {
      const plugin = name.slice(0, colon);
      const loaded = (plugins ?? []).filter((p) => p.name === plugin && p.loaded);
      if (loaded.length === 0) {
        rows.push({
          name,
          scope: "plugin",
          group: "other",
          ...marks,
          note: plugins ? `plugin ${plugin} is not in the Plugins list` : "the plugin's scope is unknown",
        });
        continue;
      }
      for (const p of loaded) {
        rows.push({
          name,
          scope: p.scope ?? (p.id.endsWith("@builtin") ? "built-in" : "plugin"),
          group: p.group,
          ...marks,
          ...(loaded.length > 1 ? { note: "which copy loaded is not stated by Claude Code" } : {}),
        });
      }
      continue;
    }

    const copies = (["project", "user"] as const).filter((scope) => folders[scope].includes(name));
    if (copies.length === 0) {
      rows.push({ name, scope: "built-in", group: "builtin", ...marks });
      continue;
    }
    for (const scope of copies) {
      rows.push({
        name,
        scope,
        group: groupOf(scope),
        ...marks,
        ...(copies.length > 1 ? { note: "which copy loaded is not stated by Claude Code" } : {}),
      });
    }
  }
  return rows;
}

// The other names in `skills` that end in the same skill: `digest` and
// `omt:digest`, or two plugins' `x`. In Claude these never collide, because plugin
// skills carry the prefix; both load, which is why it is worth a mark.
function relatedNames(name: string, skills: string[]): string[] {
  const base = baseOf(name);
  return skills.filter((other) => other !== name && baseOf(other) === base);
}

function baseOf(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

function readJson(file: string): Record<string, unknown> | null {
  const text = readTextIfPresent(file);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  return isRecord(value) ? value : null;
}

function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
