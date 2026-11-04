// Hash routing. One page, so the URL's fragment says which screen is on it:
//   #/                list
//   #/s/<id>          a session's chat
//   #/s/<id>/term     its terminal
//   #/setup           pairing, Home Screen and notifications (mockup 5.1)
//   #pair=<offer>     a scanned QR: saved, then replaced by #/setup
// A screen added later gets a case in `Route`, `parseHash` and `hashOf`, and one in
// App.tsx's switch.

import { useEffect, useState } from "react";
import type { PairingOffer } from "../shared/remote-protocol";
import { decodeOffer } from "./pairing";

export type Route =
  | { screen: "list" }
  | { screen: "session"; id: string }
  | { screen: "terminal"; id: string }
  | { screen: "setup" };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "/setup") return { screen: "setup" };
  const session = path.match(/^\/s\/([^/]+)(\/term)?$/);
  if (session) {
    let id: string;
    try {
      id = decodeURIComponent(session[1]);
    } catch {
      return { screen: "list" };
    }
    return session[2] ? { screen: "terminal", id } : { screen: "session", id };
  }
  return { screen: "list" };
}

export function hashOf(route: Route): string {
  switch (route.screen) {
    case "list":
      return "#/";
    case "setup":
      return "#/setup";
    case "session":
      return `#/s/${encodeURIComponent(route.id)}`;
    case "terminal":
      return `#/s/${encodeURIComponent(route.id)}/term`;
  }
}

// The instance id the route has open, if any: the chat and the terminal of one
// session share one subscription.
export function openIdOf(route: Route): string | null {
  return route.screen === "session" || route.screen === "terminal" ? route.id : null;
}

const listeners = new Set<() => void>();

// A new screen, as a history entry (the back gesture returns), or in place of the
// current one.
export function navigate(route: Route, options: { replace?: boolean } = {}) {
  const hash = hashOf(route);
  if (options.replace) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
    // replaceState fires no hashchange.
    for (const listener of listeners) listener();
  } else {
    location.hash = hash;
  }
}

// A pairing offer in the address bar (`#pair=`), taken out of it: the device token
// shouldn't stay in the history or a bookmark. Leaves the setup screen in its place.
// Null when there's none; a code that doesn't decode is stripped all the same.
export function takePairing(): PairingOffer | null {
  const match = location.hash.match(/^#pair=(.*)$/);
  if (!match) return null;
  const offer = decodeOffer(match[1]);
  navigate({ screen: "setup" }, { replace: true });
  return offer;
}

// The route on screen. `onPair` gets an offer that arrives while the app is open
// (a pairing link opened in this tab).
export function useRoute(onPair: (offer: PairingOffer) => void): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const update = () => {
      const offer = takePairing();
      if (offer) onPair(offer);
      setRoute(parseHash(location.hash));
    };
    window.addEventListener("hashchange", update);
    listeners.add(update);
    // The hash may have changed between the first render and this effect.
    update();
    return () => {
      window.removeEventListener("hashchange", update);
      listeners.delete(update);
    };
  }, [onPair]);
  return route;
}
