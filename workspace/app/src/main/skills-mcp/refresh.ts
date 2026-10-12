// The Skills and MCP section's refreshes (docs/specs/skills-mcp/prd.md, Story 1).
// One starts only when the renderer asks: the section expanding, its Refresh button,
// or another instance selected while it is expanded. Nothing here runs on a timer.
// Kept apart from index.ts, which wires in Electron and the process manager, so
// tests load this alone.

import type { BackendName } from "../backends/types";
import type {
  SkillsMcpPart,
  SkillsMcpPlugin,
  SkillsMcpSnapshot,
} from "../../shared/types";
import type { ProbeResult } from "./claudeProbe";
import { mergePlugins } from "./claudePlugins";
import type { PluginState } from "./claudePlugins";
import { mcpItems, skillItems } from "./claudeScopes";
import type { LocalConfig } from "./claudeScopes";

// Where to probe for an instance: its cwd, and the `--mcp-config` it was spawned
// with. Only the manager has one.
export interface ProbeTarget {
  cwd: string;
  backend: BackendName;
  mcpConfigPath?: string;
}

export interface SkillsMcpDeps {
  targetOf: (instanceId: string) => ProbeTarget | null;
  probe: (cwd: string, mcpConfigPath?: string) => Promise<ProbeResult>;
  pluginState: (cwd: string) => Promise<PluginState>;
  // Read after the probe answers, so it describes the files the probe just saw.
  localConfig: (cwd: string) => LocalConfig;
  send: (snapshot: SkillsMcpSnapshot) => void;
  now?: () => number;
}

export function createSkillsMcp(deps: SkillsMcpDeps) {
  const now = deps.now ?? Date.now;
  const snapshots = new Map<string, SkillsMcpSnapshot>();

  const publish = (snapshot: SkillsMcpSnapshot) => {
    snapshots.set(snapshot.instanceId, snapshot);
    deps.send(snapshot);
  };

  return {
    // Starts a refresh, or joins the one already running for the instance, and
    // returns the snapshot as it stands. Null for an unknown id, and for OpenCode
    // until M2.
    refresh(instanceId: string): SkillsMcpSnapshot | null {
      const target = deps.targetOf(instanceId);
      if (!target || target.backend !== "claude") return null;
      const current = snapshots.get(instanceId);
      if (current?.running) return current;

      const started: SkillsMcpSnapshot = {
        ...(current ?? emptySnapshot(instanceId)),
        running: true,
      };
      publish(started);
      // Every part waits for both sources. Skills and Plugins need the probe and
      // the install records alike; only MCP could show sooner, and only when
      // `plugin list` (0.17 s measured) is slower than the probe (3 s).
      const finish = async () => {
        const [probe, plugins] = await Promise.all([
          deps.probe(target.cwd, target.mcpConfigPath),
          deps.pluginState(target.cwd),
        ]);
        const local = probe.ok ? deps.localConfig(target.cwd) : null;
        return snapshotOf(instanceId, probe, plugins, local, now());
      };
      // No source rejects. The catch is there because a refresh stuck at
      // `running` would turn every later one into a join, for good.
      void finish()
        .catch((err: unknown) => snapshotOf(instanceId, failure(err), failure(err), null, now()))
        .then(publish);
      return started;
    },
  };
}

// What a finished refresh shows. Every part rests on the probe, so a failed probe
// fails all three with its reason. Plugins also need the install records and
// switches, and MCP the other definitions' names; each fails alone without them.
// Skills fall back to no plugin scopes when Plugins fails.
export function snapshotOf(
  instanceId: string,
  result: ProbeResult,
  plugins: PluginState,
  local: LocalConfig | null,
  refreshedAt: number
): SkillsMcpSnapshot {
  // `local` is read only after a probe that answered.
  if (!result.ok || !local) {
    const reason = result.ok ? "the local config was not read" : result.reason;
    return {
      instanceId,
      refreshedAt,
      running: false,
      mcp: failed(reason),
      skills: failed(reason),
      plugins: failed(reason),
    };
  }
  const { init } = result;
  const pluginPart: SkillsMcpPart<SkillsMcpPlugin> = plugins.ok
    ? { items: mergePlugins(plugins.records, plugins.switches, init.plugins) }
    : failed(plugins.reason);
  return {
    instanceId,
    refreshedAt,
    running: false,
    mcp: local.mcpNames.ok
      ? { items: mcpItems(init.mcpServers, local.mcpNames) }
      : failed(local.mcpNames.reason),
    skills: {
      items: skillItems(init.skills, plugins.ok ? pluginPart.items : null, local.skillFolders),
    },
    plugins: pluginPart,
  };
}

function failure(err: unknown): { ok: false; reason: string } {
  return { ok: false, reason: err instanceof Error ? err.message : String(err) };
}

function emptySnapshot(instanceId: string): SkillsMcpSnapshot {
  return {
    instanceId,
    refreshedAt: null,
    running: false,
    mcp: { items: [] },
    skills: { items: [] },
    plugins: { items: [] },
  };
}

function failed<T>(reason: string): SkillsMcpPart<T> {
  return { items: [], error: reason };
}
