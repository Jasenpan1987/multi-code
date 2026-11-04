// The session list (PRD Story 2, mockup 1A): every session the Mac lists, grouped
// Needs you / Working / Finished / Idle with a count, empty groups left out. Live
// while connected; from the cache, with its age in the banner, while not.

import type { RemoteInstance, RemoteSessionState } from "../../shared/remote-protocol";
import { ConnectionBadge, ConnectionBanner } from "../components/Connection";
import { duration, shortAge, useNow } from "../format";
import { navigate } from "../routes";
import { useApp } from "../store";
import "./list.css";

const GROUPS: { state: RemoteSessionState; label: string }[] = [
  { state: "needs-you", label: "NEEDS YOU" },
  { state: "working", label: "WORKING" },
  { state: "finished", label: "FINISHED" },
  { state: "idle", label: "IDLE" },
];

export function ListScreen() {
  const instances = useApp((s) => s.instances);
  const instancesAt = useApp((s) => s.instancesAt);

  return (
    <div className="screen list-screen">
      <div className="topbar">
        <div className="title">Multi-Code</div>
        <ConnectionBadge />
        <a className="tap" href="#/setup" aria-label="Setup">
          ⚙
        </a>
      </div>
      <ConnectionBanner since={instancesAt} />
      <div className="screen-body">
        {instances === null ? (
          <p className="empty">Waiting for your Mac…</p>
        ) : instances.length === 0 ? (
          <p className="empty">No sessions on your Mac.</p>
        ) : (
          GROUPS.map(({ state, label }) => {
            const rows = instances.filter((i) => i.state === state);
            if (rows.length === 0) return null;
            return (
              <section key={state} data-group={state}>
                <div className="group">
                  {label} · {rows.length}
                </div>
                {rows.map((i) => (
                  <Row key={i.id} instance={i} />
                ))}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function Row({ instance }: { instance: RemoteInstance }) {
  const { state } = instance;
  const opencode = instance.backend === "opencode";
  // What waits for the builder reads as unread (mockup 1A's bold rows).
  const unread = state === "needs-you" || state === "finished";
  return (
    <button
      className={unread ? "srow unread" : "srow"}
      data-id={instance.id}
      onClick={() => navigate({ screen: "session", id: instance.id })}
    >
      <span className={`av ${opencode ? "o" : "c"}`} aria-label={opencode ? "OpenCode" : "Claude"}>
        {opencode ? "O" : "C"}
      </span>
      <span className="main">
        <span className="line1">
          <span className="name">{instance.name}</span>
          {state === "needs-you" && <span className="pill need">Needs you</span>}
          {state === "working" && <span className="dot blue pulse" aria-label="Working" />}
          {state === "finished" && <span className="dot green" aria-label="Finished" />}
          {instance.since !== undefined && <Age working={state === "working"} since={instance.since} />}
        </span>
        {instance.preview && (
          <span className="prev">
            <Preview text={instance.preview} state={state} />
          </span>
        )}
      </span>
    </button>
  );
}

// Its own component so only the age re-renders as it ticks: every second for a
// working row ("3m 20s"), every half minute otherwise.
function Age({ working, since }: { working: boolean; since: number }) {
  const now = useNow(working ? 1000 : 30_000);
  return <span className="time">{working ? duration(now - since) : shortAge(since, now)}</span>;
}

// A tool and what it acts on, as the Mac writes a dialog's and a running tool's
// line ("Bash: pnpm test:e2e"), with the subject as code (mockup 1A). Only the tools
// whose subject is a command, path, pattern or URL: a question or a plan's title
// that happens to contain a colon stays prose.
const TOOL_LINE =
  /^(bash|shell|read|write|edit|multiedit|notebookedit|grep|glob|ls|list|patch|apply_patch|webfetch|websearch): (.+)$/i;

function Preview({ text, state }: { text: string; state: RemoteSessionState }) {
  const tool = state === "needs-you" || state === "working" ? TOOL_LINE.exec(text) : null;
  if (!tool) return <>{text}</>;
  // Working reads as what it is doing ("Edit src/pages/Login.tsx"), a dialog as
  // what it asks about ("Bash: pnpm test:e2e").
  return (
    <>
      {tool[1]}
      {state === "needs-you" ? ": " : " "}
      <code>{tool[2]}</code>
    </>
  );
}
