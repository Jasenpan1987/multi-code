// mobile-v2 T-807: placeholder for the session chat (mockups 2.1–2.3), there to
// show the store at work: the transcript's size, the open dialog, and the outbox
// with a bare compose box.

import { useState } from "react";
import { ConnectionBanner } from "../components/Connection";
import { canCancel, instanceOf, type OutboxItem } from "../outbox";
import { navigate } from "../routes";
import { shallowEqual, useActions, useApp } from "../store";
import { sessionOf } from "../state";
import "./session.css";

export function SessionScreen({ id }: { id: string }) {
  const actions = useActions();
  const instance = useApp((s) => s.instances?.find((i) => i.id === id));
  const session = useApp((s) => sessionOf(s, id));
  const outbox = useApp((s) => s.outbox.filter((i) => instanceOf(i) === id), shallowEqual);
  const [text, setText] = useState("");

  const send = () => {
    if (!text.trim()) return;
    actions.sendPrompt(id, text);
    setText("");
  };

  return (
    <div className="screen session-screen">
      <div className="topbar">
        <a className="tap back" href="#/" aria-label="Back">
          ‹
        </a>
        <div className="title">
          {instance?.name ?? id}
          {instance && <span className="sub">{instance.backend === "opencode" ? "OpenCode" : "Claude"}</span>}
        </div>
        {instance && <span className="state">{instance.state}</span>}
        <button className="tap" aria-label="Terminal" onClick={() => navigate({ screen: "terminal", id })}>
          <span className="mono-icon">&gt;_</span>
        </button>
      </div>
      <ConnectionBanner since={session.refreshedAt} />
      <div className="screen-body">
        <div className="facts">
          <p className="entries">
            {session.transcript === null
              ? "No transcript yet."
              : `${session.transcript.length} entries${session.hasEarlier ? " · earlier turns on the Mac" : ""}`}
          </p>
          {session.hasEarlier && (
            <button className="btn ghost" onClick={() => actions.loadEarlier(id)}>
              Earlier turns
            </button>
          )}
          {session.dialog && <p className="dialog">Needs you: {session.dialog.summary}</p>}
          {outbox.map((item) => (
            <Sent key={item.frame.clientMsgId} item={item} />
          ))}
        </div>
      </div>
      <div className="screen-foot compose">
        <textarea value={text} rows={1} placeholder={`Reply to ${instance?.name ?? id}…`} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" disabled={!text.trim()} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}

const STATUS: Record<OutboxItem["status"], string> = {
  waiting: "Waiting to send",
  sent: "Sending…",
  acked: "Arrived",
  refused: "Refused",
  unknown: "May not have arrived: check the session",
};

function Sent({ item }: { item: OutboxItem }) {
  const actions = useActions();
  const { frame } = item;
  const what = frame.type === "prompt" ? frame.text : frame.type;
  return (
    <div className="sent" data-status={item.status}>
      <span className="what">{what}</span>
      <span className="status">
        {STATUS[item.status]}
        {item.refusal && `: ${item.refusal.message}`}
        {canCancel(item) && (
          <button className="link" onClick={() => actions.cancelPrompt(frame.clientMsgId)}>
            Cancel
          </button>
        )}
      </span>
    </div>
  );
}
