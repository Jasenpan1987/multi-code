// The connection's two faces on every screen: the badge in the top bar (mockup 1A:
// a dot and the Mac's name), and the banner under it while the Mac can't be
// reached or refused this phone (mockup 4.2).

import { ago, macName, useNow } from "../format";
import { navigate } from "../routes";
import { useActions, useApp } from "../store";

export function ConnectionBadge() {
  const connection = useApp((s) => s.connection);
  const dot =
    connection.state === "connected"
      ? "green"
      : connection.state === "connecting"
        ? "amber pulse"
        : connection.state === "offline"
          ? "amber"
          : "red";
  return (
    <span className="conn" data-state={connection.state}>
      <span className={`dot ${dot}`} />
      {macName(connection.hostName)}
    </span>
  );
}

// `since`: when what the screen shows was last current (state.ts's "…At" times),
// for "Showing what it said 3 min ago".
export function ConnectionBanner({ since }: { since: number | null }) {
  const connection = useApp((s) => s.connection);
  const actions = useActions();
  const now = useNow();

  if (connection.state === "refused") {
    // Another protocol version means the Mac was updated, and it serves the phone
    // app that matches it: a reload is the fix, not a new pairing.
    const version = connection.refused === "version";
    const text = version
      ? "Multi-Code on your Mac is a different version."
      : connection.refused === "wrong-key"
        ? "This isn't the Mac this phone was paired with."
        : "Your Mac doesn't know this phone any more.";
    return (
      <div className="banner" role="status" data-state="refused">
        <span className="dot red" />
        <span className="text">
          <b>{text}</b>
        </span>
        <button className="act" onClick={() => (version ? location.reload() : navigate({ screen: "setup" }))}>
          {version ? "Reload" : "Pair again"}
        </button>
      </div>
    );
  }
  if (connection.state !== "offline") return null;

  const headline =
    connection.offline === "no-network"
      ? "This phone is offline."
      : connection.offline === "multi-code-down"
        ? "Your Mac is on, but Multi-Code isn't answering."
        : connection.offline === "link-failed"
          ? "Your Mac answers, but the link won't open."
          : "Can't reach your Mac.";
  const age = since ? `Showing what it said ${ago(since, now)}.` : "Nothing from it saved here yet.";
  return (
    <div className="banner" role="status" data-state="offline" data-reason={connection.offline ?? ""}>
      <span className="dot amber" />
      <span className="text">
        <b>{headline}</b> {age}
      </span>
      <button className="act" disabled={connection.retrying} onClick={actions.retry}>
        {connection.retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
