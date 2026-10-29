// mobile-v2 T-809: placeholder for the terminal fallback (mockup 4.1), there to
// show the terminal sink at work: the PTY's size and what has streamed in.

import { useEffect, useState } from "react";
import { ConnectionBanner } from "../components/Connection";
import { navigate } from "../routes";
import { useActions, useApp } from "../store";
import { sessionOf } from "../state";
import "./terminal.css";

export function TerminalScreen({ id }: { id: string }) {
  const actions = useActions();
  const name = useApp((s) => s.instances?.find((i) => i.id === id)?.name ?? id);
  const session = useApp((s) => sessionOf(s, id));
  const [received, setReceived] = useState({ snapshots: 0, chars: 0 });

  useEffect(
    () =>
      actions.attachTerminal(id, {
        snapshot: (data) => setReceived((r) => ({ snapshots: r.snapshots + 1, chars: data.length })),
        output: (data) => setReceived((r) => ({ ...r, chars: r.chars + data.length })),
        resize: () => {},
      }),
    [actions, id]
  );

  return (
    <div className="screen terminal-screen">
      <div className="topbar">
        <div className="title">{name}</div>
        <button className="tap" aria-label="Chat" onClick={() => navigate({ screen: "session", id })}>
          ☰
        </button>
      </div>
      <ConnectionBanner since={session.refreshedAt} />
      <div className="screen-body">
        <p className="facts">
          {session.terminal ? `${session.terminal.cols} × ${session.terminal.rows}` : "No terminal yet"} ·{" "}
          {received.snapshots} snapshots · {received.chars} characters
        </p>
      </div>
    </div>
  );
}
