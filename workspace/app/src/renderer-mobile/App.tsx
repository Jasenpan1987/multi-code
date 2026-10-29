// The phone app's screens, chosen by the route (routes.ts). Each screen is its own
// file under screens/ with its own CSS file; adding one means a case here.

import { useEffect, useState } from "react";
import { openIdOf, useRoute, type Route } from "./routes";
import { ListScreen } from "./screens/ListScreen";
import { SessionScreen } from "./screens/SessionScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { TerminalScreen } from "./screens/TerminalScreen";
import { useActions, useApp } from "./store";

export function App() {
  const actions = useActions();
  const route = useRoute(actions.pair);
  const paired = useApp((s) => s.pairing !== null);

  // The open session follows the route: one subscription for its chat and its
  // terminal, so switching between them doesn't resubscribe.
  const openId = paired ? openIdOf(route) : null;
  useEffect(() => actions.open(openId), [actions, openId]);

  // A terminal, once opened, stays mounted (hidden) while its session's chat is on
  // screen, so going back to it keeps its xterm and scrollback instead of replaying
  // the whole buffer into a new one. It goes when the session is closed.
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const kept = route.screen === "terminal" && paired ? route.id : terminalId === openId ? terminalId : null;
  if (kept !== terminalId) setTerminalId(kept);

  if (!paired) return <SetupScreen />;
  return (
    <>
      {screenOf(route)}
      {kept && <TerminalScreen key={`terminal:${kept}`} id={kept} hidden={route.screen !== "terminal"} />}
    </>
  );
}

function screenOf(route: Route) {
  switch (route.screen) {
    case "setup":
      return <SetupScreen />;
    case "list":
      return <ListScreen />;
    case "session":
      return <SessionScreen key={route.id} id={route.id} />;
    case "terminal":
      return null;
  }
}
