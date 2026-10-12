// Why each Claude plugin loads or not, for the Plugins part (T-603). A plugin loads
// only with both an install record (which version, at which scope) and an enable
// switch (`enabledPlugins: { "<id>": true }` in a settings file that applies), and
// the two can sit at different scopes
// (docs/timeline/2026-10-12_skills-mcp-inventory-investigation.md, "Override and
// the enable switch").
//
// - **Records** come from `claude plugin list --json`, which lists every project's
//   records. Only `user` rows and rows whose `projectPath` is this cwd apply. Its
//   `enabled` field is not used: it answers for the directory the command runs in,
//   and says nothing about where the switch is.
// - **Switches** come from the `enabledPlugins` key of the three settings files a
//   session in the cwd reads. The most specific file that names an id decides it.
// - **The winner** is the record whose version the probe says loaded. Multi-Code
//   never works out precedence by its own rules (PRD Story 3).

import { execFile as nodeExecFile } from "child_process";
import os from "os";
import path from "path";
import { claudeCliCommand } from "../backends/claude";
import { samePath } from "../backends/resolvePath";
import type { SkillsMcpPlugin } from "../../shared/types";
import { clipReason } from "./claudeProbe";
import type { InitPlugin } from "./claudeProbe";
import { claudeConfigPaths, pluginGroupOf, readTextIfPresent } from "./claudeScopes";

// 0.17 s measured in `multi-code` on 2026-10-12.
export const PLUGIN_LIST_TIMEOUT_MS = 15_000;

export interface PluginRecord {
  id: string;
  version: string;
  scope: string;
  // Set for `project` and `local` records.
  projectPath?: string;
}

export type SwitchScope = "local" | "project" | "user";

export interface EnableSwitches {
  scope: SwitchScope;
  path: string;
  enabled: Record<string, boolean>;
}

export type PluginState =
  | { ok: true; records: PluginRecord[]; switches: EnableSwitches[] }
  | { ok: false; reason: string };

export type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeout: number; maxBuffer: number },
  callback: (err: Error | null, stdout: string, stderr: string) => void
) => void;

export interface PluginStateOptions {
  // Where user `settings.json` lives. Defaults to what the CLI's env says.
  configDir?: string;
  // For tests. Production runs the real binary with an instance's env.
  exec?: ExecFn;
  command?: { command: string; env: Record<string, string> };
}

// The records and switches that apply to a session in `cwd`. Never rejects.
export function readPluginState(
  cwd: string,
  options: PluginStateOptions = {}
): Promise<PluginState> {
  const { command, env } = options.command ?? claudeCliCommand();
  let switches: EnableSwitches[];
  try {
    const configDir = options.configDir ?? claudeConfigPaths(env, os.homedir(), cwd).configDir;
    switches = readEnableSwitches(cwd, configDir);
  } catch (err) {
    return Promise.resolve({ ok: false, reason: messageOf(err) });
  }
  const exec = options.exec ?? (nodeExecFile as unknown as ExecFn);
  return new Promise((resolve) => {
    exec(
      command,
      ["plugin", "list", "--json"],
      { cwd, env, timeout: PLUGIN_LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? "").trim() || err.message;
          resolve({ ok: false, reason: `claude plugin list failed: ${clipReason(detail)}` });
          return;
        }
        try {
          const records = parsePluginList(String(stdout)).filter(
            (r) => r.scope === "user" || (r.projectPath !== undefined && samePath(r.projectPath, cwd))
          );
          resolve({ ok: true, records, switches });
        } catch (e) {
          resolve({ ok: false, reason: messageOf(e) });
        }
      }
    );
  });
}

// Every record `claude plugin list --json` prints. Throws on output it can't read,
// for the same reason as parseInit: a renamed field must not show as no plugins.
export function parsePluginList(stdout: string): PluginRecord[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    throw new Error("claude plugin list printed no JSON");
  }
  if (!Array.isArray(rows)) throw new Error("claude plugin list printed no list");
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.version !== "string" ||
      typeof row.scope !== "string" ||
      (row.projectPath !== undefined && typeof row.projectPath !== "string") ||
      // Without its project, a project or local record can't be matched to the
      // cwd, and would drop out of the list unseen.
      ((row.scope === "project" || row.scope === "local") && row.projectPath === undefined)
    ) {
      throw new Error("claude plugin list printed an entry it doesn't explain");
    }
    return {
      id: row.id,
      version: row.version,
      scope: row.scope,
      ...(typeof row.projectPath === "string" ? { projectPath: row.projectPath } : {}),
    };
  });
}

// The `enabledPlugins` of each settings file a session in `cwd` reads, most
// specific first. A missing file has none. A file that can't be read or isn't JSON
// fails the part: guessing its switches would be wrong.
export function readEnableSwitches(cwd: string, configDir: string): EnableSwitches[] {
  const files: [SwitchScope, string][] = [
    ["local", path.join(cwd, ".claude", "settings.local.json")],
    ["project", path.join(cwd, ".claude", "settings.json")],
    ["user", path.join(configDir, "settings.json")],
  ];
  const found: EnableSwitches[] = [];
  for (const [scope, file] of files) {
    const text = readTextIfPresent(file);
    if (text === null) continue;
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
    const enabledPlugins = isRecord(settings) ? settings.enabledPlugins : undefined;
    const enabled: Record<string, boolean> = {};
    if (isRecord(enabledPlugins)) {
      for (const [id, value] of Object.entries(enabledPlugins)) {
        if (typeof value === "boolean") enabled[id] = value;
      }
    }
    found.push({ scope, path: file, enabled });
  }
  return found;
}

// One row per install record, plus one per loaded plugin that has none (built-in,
// `--plugin-dir`) and one per switch that names a plugin with no record. Loaded
// plugins come first, in the probe's order, then the rest.
export function mergePlugins(
  records: PluginRecord[],
  switches: EnableSwitches[],
  loaded: InitPlugin[]
): SkillsMcpPlugin[] {
  const ids: string[] = [];
  const addId = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const plugin of loaded) addId(plugin.source);
  for (const record of records) addId(record.id);
  for (const s of switches) {
    for (const [id, on] of Object.entries(s.enabled)) if (on) addId(id);
  }

  const rows: Omit<SkillsMcpPlugin, "group">[] = [];
  for (const id of ids) {
    const name = loaded.find((p) => p.source === id)?.name ?? id.split("@")[0];
    const applies = switches.find((s) => id in s.enabled);
    const enableSwitch = applies ? { on: applies.enabled[id], scope: applies.scope } : undefined;
    const sw = enableSwitch ? { enableSwitch } : {};
    const ofId = records.filter((r) => r.id === id);
    const plugin = loaded.find((p) => p.source === id);

    if (ofId.length === 0) {
      if (plugin) {
        // Built-in, `--plugin-dir` and skills-dir plugins have no record by nature.
        const recordless = /@(builtin|inline|skills-dir)$/.test(id);
        rows.push({
          id,
          name,
          ...(plugin.version ? { version: plugin.version } : {}),
          loaded: true,
          ...sw,
          ...(recordless ? {} : { note: "no install record for this project" }),
        });
      } else if (enableSwitch?.on) {
        rows.push({ id, name, loaded: false, ...sw, note: "enabled, not installed" });
      }
      continue;
    }

    if (!plugin) {
      for (const r of ofId) {
        rows.push({
          id,
          name,
          version: r.version,
          scope: r.scope,
          loaded: false,
          ...sw,
          note: enableSwitch?.on ? "enabled, not loaded" : "installed, not enabled",
        });
      }
      continue;
    }

    const winners = ofId.filter((r) => r.version === plugin.version);
    const others = ofId.filter((r) => r.version !== plugin.version);
    const winner = winners.length === 1 ? winners[0] : null;
    for (const r of winners) {
      const overrides = others.map((o) => `${o.scope} ${o.version}`).join(", ");
      rows.push({
        id,
        name,
        version: r.version,
        scope: r.scope,
        loaded: true,
        ...sw,
        ...(winner
          ? overrides
            ? { note: `overrides ${overrides}` }
            : {}
          : { note: "which of these records loaded is not stated by Claude Code" }),
      });
    }
    if (winners.length === 0) {
      rows.push({
        id,
        name,
        ...(plugin.version ? { version: plugin.version } : {}),
        loaded: true,
        ...sw,
        note: "loaded, but matches no install record for this project",
      });
    }
    for (const o of others) {
      rows.push({
        id,
        name,
        version: o.version,
        scope: o.scope,
        loaded: false,
        ...sw,
        note: winner
          ? `overridden by ${groupOf(winner.scope)} ${winner.version}`
          : `overridden by the loaded ${plugin.version ?? "copy"}`,
      });
    }
  }
  return rows.map((row) => ({ ...row, group: pluginGroupOf(row) }));
}

// The words for a scope's group (PRD Definitions), as an override note uses them.
function groupOf(scope: string): string {
  return scope === "local" || scope === "project" ? "this project's" : "global";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
