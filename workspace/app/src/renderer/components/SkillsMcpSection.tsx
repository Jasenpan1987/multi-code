import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  BackendName,
  SkillsMcpGroup,
  SkillsMcpPart,
  SkillsMcpSnapshot,
} from "../../shared/types";

interface SkillsMcpSectionProps {
  instanceId: string;
  backend: BackendName;
  active: boolean;
}

// What the selected instance's agent loads (docs/specs/skills-mcp/prd.md). Main
// does the probing; this asks for a refresh and shows the snapshots it pushes.
export function SkillsMcpSection({
  instanceId,
  backend,
  active,
}: SkillsMcpSectionProps) {
  const [snapshot, setSnapshot] = useState<SkillsMcpSnapshot | null>(null);
  const isClaude = backend === "claude";

  // A refresh when the section expands, and when another instance is selected
  // while it is expanded. Never on a timer (PRD Story 1).
  useEffect(() => {
    if (!active || !isClaude) return;
    let cancelled = false;
    // The refresh's own answer can arrive after a push that is newer, when the
    // probe fails at once. Once a push has come, it is the one to show.
    let heard = false;
    setSnapshot(null);
    const off = window.electronAPI.onSkillsMcpUpdate((next) => {
      if (next.instanceId !== instanceId) return;
      heard = true;
      setSnapshot(next);
    });
    window.electronAPI.refreshSkillsMcp(instanceId).then((current) => {
      if (!cancelled && !heard && current) setSnapshot(current);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [instanceId, active, isClaude]);

  if (!active) return null;

  if (!isClaude) {
    return <div className="toolbox-placeholder">OpenCode comes in M2</div>;
  }

  const running = snapshot?.running ?? true;
  const refreshedAt = snapshot?.refreshedAt ?? null;
  const lastTime = refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : null;

  return (
    <div className="skills-mcp">
      <div className="skills-mcp-note">
        What a Claude Code session started now in this project loads. A running
        session loaded its own list when it started.
      </div>
      <div className="skills-mcp-bar">
        <button
          type="button"
          className="quick-action-btn skills-mcp-btn"
          disabled={running}
          onClick={() => void window.electronAPI.refreshSkillsMcp(instanceId)}
        >
          Refresh
        </button>
        <span className="skills-mcp-time">
          {running
            ? `Refreshing…${lastTime ? ` (last ${lastTime})` : ""}`
            : lastTime && `Refreshed ${lastTime}`}
        </span>
      </div>

      <Part
        title="MCP"
        part={snapshot?.mcp}
        running={running}
        count={(items) => items.filter((s) => s.loaded).length}
      >
        {(server) => (
          <Item
            key={`${server.name}:${server.scope}`}
            name={server.name}
            loaded={server.loaded}
            note={server.note}
          >
            <span className="skills-mcp-scope">{server.scope}</span>
            {server.status && (
              <span className="skills-mcp-status" data-status={server.status}>
                {server.status}
              </span>
            )}
            {server.multiCode && <span className="skills-mcp-tag">Multi-Code</span>}
          </Item>
        )}
      </Part>
      <Part
        title="Skills"
        part={snapshot?.skills}
        running={running}
        count={(items) => new Set(items.map((s) => s.name)).size}
      >
        {(skill) => (
          <Item
            key={`${skill.name}:${skill.scope}`}
            name={skill.name}
            loaded
            note={[
              skill.duplicates && `duplicate of ${skill.duplicates.join(", ")}`,
              skill.note,
            ]
              .filter(Boolean)
              .join("; ")}
          >
            <span className="skills-mcp-scope">{skill.scope}</span>
          </Item>
        )}
      </Part>
      <Part
        title="Plugins"
        part={snapshot?.plugins}
        running={running}
        count={(items) => new Set(items.filter((p) => p.loaded).map((p) => p.id)).size}
      >
        {(plugin) => (
          <Item
            key={`${plugin.id}:${plugin.scope ?? ""}:${plugin.version ?? ""}`}
            name={plugin.name}
            title={plugin.id}
            loaded={plugin.loaded}
            note={plugin.note}
          >
            {plugin.version && <span className="skills-mcp-scope">{plugin.version}</span>}
            <span className="skills-mcp-scope">
              {plugin.scope ?? (plugin.group === "builtin" ? "built-in" : "")}
            </span>
            {plugin.enableSwitch && (
              <span className="skills-mcp-scope">
                {`${plugin.enableSwitch.on ? "enabled" : "disabled"} (${plugin.enableSwitch.scope})`}
              </span>
            )}
          </Item>
        )}
      </Part>
    </div>
  );
}

// PRD Story 2: in this order, empty groups hidden.
const GROUPS: [SkillsMcpGroup, string][] = [
  ["project", "This project"],
  ["global", "Global"],
  ["session", "This session"],
  ["builtin", "Built-in"],
  ["other", "Other"],
];

function Part<T extends { group: SkillsMcpGroup }>({
  title,
  part,
  running,
  count,
  children,
}: {
  title: string;
  part: SkillsMcpPart<T> | undefined;
  running: boolean;
  // What the part's count counts: what the session loads, once per name, so
  // overridden copies don't inflate it.
  count: (items: T[]) => number;
  children: (item: T) => ReactNode;
}) {
  // Nothing to count yet: the first refresh for this instance is still running.
  const waiting = !part || (running && part.items.length === 0 && !part.error);
  return (
    <details className="skills-mcp-part" open>
      <summary className="skills-mcp-part-title">
        {title}{" "}
        {/* A failed part has no count: "0" would read as an empty list. */}
        {!part?.error && (
          <span className="skills-mcp-count">{waiting ? "…" : count(part.items)}</span>
        )}
      </summary>
      {part?.error ? (
        <div className="skills-mcp-error">{part.error}</div>
      ) : waiting ? null : part.items.length === 0 ? (
        <div className="toolbox-placeholder">None</div>
      ) : (
        GROUPS.map(([group, label]) => {
          const items = part.items.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="skills-mcp-group">
              <div className="skills-mcp-group-title">{label}</div>
              {items.map(children)}
            </div>
          );
        })
      )}
    </details>
  );
}

// One row: the name, its labels, and a note line under it. Greyed when the
// session doesn't load it.
function Item({
  name,
  title,
  loaded,
  note,
  children,
}: {
  name: string;
  title?: string;
  loaded: boolean;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <div className={loaded ? undefined : "skills-mcp-unloaded"}>
      <div className="skills-mcp-row" title={title}>
        <span className="skills-mcp-name">{name}</span>
        {children}
      </div>
      {note && <div className="skills-mcp-row-note">{note}</div>}
    </div>
  );
}
