// The phone app's screens, chosen by the route (routes.ts). Each screen is its own
// file under screens/ with its own CSS file; adding one means a case here.

import { useEffect } from "react";
import { openIdOf, useRoute } from "./routes";
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

  if (!paired) return <SetupScreen />;
  switch (route.screen) {
    case "setup":
      return <SetupScreen />;
    case "list":
      return <ListScreen />;
    case "session":
      return <SessionScreen key={route.id} id={route.id} />;
    case "terminal":
      return <TerminalScreen key={route.id} id={route.id} />;
  }
}
