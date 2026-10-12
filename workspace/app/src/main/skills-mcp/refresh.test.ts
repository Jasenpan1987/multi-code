// Refreshes with the probe faked: who gets probed, joining a running refresh, and
// what each finished probe shows.

import { describe, expect, it } from "vitest";
import { createSkillsMcp } from "./refresh";
import type { ProbeTarget } from "./refresh";
import type { ClaudeInit, ProbeResult } from "./claudeProbe";
import type { PluginState } from "./claudePlugins";
import type { LocalConfig } from "./claudeScopes";
import type { SkillsMcpSnapshot } from "../../shared/types";

const INIT: ClaudeInit = {
  version: "2.1.296",
  mcpServers: [{ name: "sentry", status: "needs-auth", source: "user" }],
  plugins: [
    { name: "omt", version: "3.5.0", source: "omt@market", path: "/cache/omt/3.5.0" },
    { name: "agents-md", source: "agents-md@builtin", path: "builtin" },
  ],
  skills: ["digest", "omt:digest"],
};

const PLUGINS: PluginState = {
  ok: true,
  records: [{ id: "omt@market", version: "3.5.0", scope: "project", projectPath: "/a" }],
  switches: [{ scope: "project", path: "/a/.claude/settings.json", enabled: { "omt@market": true } }],
};

// `digest` is a project skill folder, and `sentry` is also defined at local scope.
const LOCAL: LocalConfig = {
  skillFolders: { project: ["digest"], user: [] },
  mcpNames: { ok: true, local: ["sentry"], project: [], user: ["sentry"] },
};

function setup(
  targets: Record<string, ProbeTarget>,
  plugins: PluginState = PLUGINS,
  local: LocalConfig = LOCAL
) {
  const probes: { cwd: string; mcpConfigPath?: string; answer: (r: ProbeResult) => void }[] = [];
  const listed: string[] = [];
  const sent: SkillsMcpSnapshot[] = [];
  const skillsMcp = createSkillsMcp({
    targetOf: (id) => targets[id] ?? null,
    probe: (cwd, mcpConfigPath) =>
      new Promise((answer) => probes.push({ cwd, mcpConfigPath, answer })),
    pluginState: (cwd) => {
      listed.push(cwd);
      return Promise.resolve(plugins);
    },
    localConfig: () => local,
    send: (snapshot) => sent.push(snapshot),
    now: () => 1_000,
  });
  return { skillsMcp, probes, listed, sent };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Skills and MCP refresh", () => {
  it("probes the instance's cwd with its --mcp-config", () => {
    const { skillsMcp, probes } = setup({
      mgr: { cwd: "/m", backend: "claude", mcpConfigPath: "/u/manager-mcp.json" },
    });
    skillsMcp.refresh("mgr");
    expect(probes).toEqual([
      { cwd: "/m", mcpConfigPath: "/u/manager-mcp.json", answer: expect.any(Function) },
    ]);
  });

  it("joins a running refresh instead of probing again", () => {
    const { skillsMcp, probes, listed, sent } = setup({ a: { cwd: "/a", backend: "claude" } });
    const first = skillsMcp.refresh("a");
    const second = skillsMcp.refresh("a");
    expect(probes).toHaveLength(1);
    expect(listed).toEqual(["/a"]);
    expect(sent).toHaveLength(1);
    expect(first?.running).toBe(true);
    expect(second).toEqual(first);
  });

  it("refreshes two instances side by side", () => {
    const { skillsMcp, probes } = setup({
      a: { cwd: "/a", backend: "claude" },
      b: { cwd: "/b", backend: "claude" },
    });
    skillsMcp.refresh("a");
    skillsMcp.refresh("b");
    expect(probes.map((p) => p.cwd)).toEqual(["/a", "/b"]);
  });

  it("pushes the probe's answer, then probes again on the next refresh", async () => {
    const { skillsMcp, probes, sent } = setup({ a: { cwd: "/a", backend: "claude" } });
    skillsMcp.refresh("a");
    probes[0].answer({ ok: true, init: INIT });
    await settle();
    expect(sent.at(-1)).toEqual({
      instanceId: "a",
      refreshedAt: 1_000,
      running: false,
      mcp: {
        items: [
          {
            name: "sentry",
            status: "needs-auth",
            scope: "user",
            group: "global",
            loaded: true,
            note: "overrides local",
          },
          { name: "sentry", scope: "local", group: "project", loaded: false, note: "overridden by user" },
        ],
      },
      skills: {
        items: [
          { name: "digest", scope: "project", group: "project", duplicates: ["omt:digest"] },
          { name: "omt:digest", scope: "project", group: "project", duplicates: ["digest"] },
        ],
      },
      plugins: {
        items: [
          {
            id: "omt@market",
            name: "omt",
            version: "3.5.0",
            scope: "project",
            group: "project",
            loaded: true,
            enableSwitch: { on: true, scope: "project" },
          },
          { id: "agents-md@builtin", name: "agents-md", group: "builtin", loaded: true },
        ],
      },
    });

    // The next refresh keeps the last answer on show while it runs.
    const again = skillsMcp.refresh("a");
    expect(probes).toHaveLength(2);
    expect(again?.running).toBe(true);
    expect(again?.refreshedAt).toBe(1_000);
    expect(again?.skills.items).toHaveLength(2);
  });

  it("fails all three parts with the probe's reason", async () => {
    const { skillsMcp, probes, sent } = setup({ a: { cwd: "/a", backend: "claude" } });
    skillsMcp.refresh("a");
    probes[0].answer({ ok: false, reason: "timed out after 30 s" });
    await settle();
    const last = sent.at(-1);
    for (const part of [last?.mcp, last?.skills, last?.plugins]) {
      expect(part).toEqual({ items: [], error: "timed out after 30 s" });
    }
    expect(last?.running).toBe(false);
    expect(last?.refreshedAt).toBe(1_000);
  });

  it("fails only the Plugins part when the records can't be read", async () => {
    const { skillsMcp, probes, sent } = setup(
      { a: { cwd: "/a", backend: "claude" } },
      { ok: false, reason: "claude plugin list failed: Error: nope" }
    );
    skillsMcp.refresh("a");
    probes[0].answer({ ok: true, init: INIT });
    await settle();
    const last = sent.at(-1);
    expect(last?.plugins).toEqual({ items: [], error: "claude plugin list failed: Error: nope" });
    expect(last?.mcp.items).toHaveLength(2);
    // A plugin's skill has no scope to show without the plugin rows.
    expect(last?.skills.items[1]).toMatchObject({
      name: "omt:digest",
      group: "other",
      note: "the plugin's scope is unknown",
    });
  });

  it("fails only the MCP part when its config can't be read", async () => {
    const { skillsMcp, probes, sent } = setup({ a: { cwd: "/a", backend: "claude" } }, PLUGINS, {
      ...LOCAL,
      mcpNames: { ok: false, reason: "/home/.claude.json is not valid JSON" },
    });
    skillsMcp.refresh("a");
    probes[0].answer({ ok: true, init: INIT });
    await settle();
    const last = sent.at(-1);
    expect(last?.mcp).toEqual({ items: [], error: "/home/.claude.json is not valid JSON" });
    expect(last?.skills.items).toHaveLength(2);
    expect(last?.plugins.items).toHaveLength(2);
  });

  it("never sends a server's env, headers or any other config value", async () => {
    const { skillsMcp, probes, sent } = setup({ a: { cwd: "/a", backend: "claude" } });
    skillsMcp.refresh("a");
    probes[0].answer({ ok: true, init: INIT });
    await settle();
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(sent.at(-1));
    for (const forbidden of ["env", "environment", "headers", "command", "args", "url"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("never stays running when a source rejects", async () => {
    const sent: SkillsMcpSnapshot[] = [];
    const skillsMcp = createSkillsMcp({
      targetOf: () => ({ cwd: "/a", backend: "claude" }),
      probe: () => Promise.reject(new Error("boom")),
      pluginState: () => Promise.reject(new Error("bang")),
      localConfig: () => LOCAL,
      send: (snapshot) => sent.push(snapshot),
    });
    skillsMcp.refresh("a");
    await settle();
    expect(sent.at(-1)?.running).toBe(false);
    expect(sent.at(-1)?.mcp.error).toBe("boom");
  });

  it("answers null for an unknown instance and for OpenCode", () => {
    const { skillsMcp, probes, sent } = setup({ oc: { cwd: "/o", backend: "opencode" } });
    expect(skillsMcp.refresh("nobody")).toBeNull();
    expect(skillsMcp.refresh("oc")).toBeNull();
    expect(probes).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
