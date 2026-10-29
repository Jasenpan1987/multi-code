// mobile-v2 T-807: placeholder for the session list (mockup 1A), there to show the
// store at work: the Mac's sessions by state, live or from the cache with its age.

import type { RemoteInstance, RemoteSessionState } from "../../shared/remote-protocol";
import { ConnectionBadge, ConnectionBanner } from "../components/Connection";
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
              <section key={state}>
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
  return (
    <button className="srow" data-id={instance.id} onClick={() => navigate({ screen: "session", id: instance.id })}>
      <span className={`av ${instance.backend === "opencode" ? "o" : "c"}`}>{instance.backend === "opencode" ? "O" : "C"}</span>
      <span className="main">
        <span className="line1">
          <span className="name">{instance.name}</span>
          <span className="state">{instance.status === "stopped" ? "stopped" : instance.state}</span>
        </span>
        {instance.preview && <span className="prev">{instance.preview}</span>}
      </span>
    </button>
  );
}
