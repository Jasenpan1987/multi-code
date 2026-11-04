import { createRoot } from "react-dom/client";
import { App, ErrorScreen } from "./App";
import { deviceName } from "./pairing";
import { startPush } from "./push";
import { takePairing } from "./routes";
import { StoreContext, createStore } from "./store";
import { Link, socketUrl } from "./transport";
import "./base.css";

const store = createStore({
  storage: localStorage,
  createLink: (pairing, handlers) =>
    new Link({ url: socketUrl(location), pairing, deviceName: deviceName(localStorage), ...handlers }),
});

// A scanned QR opens the app at `#pair=<offer>`.
const offer = takePairing();
if (offer) store.actions.pair(offer);

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StoreContext.Provider value={store}>
      <ErrorScreen>
        <App />
      </ErrorScreen>
    </StoreContext.Provider>
  );
}
// After the first render, so the cached content is on screen before anything dials.
requestAnimationFrame(() => store.start());
// Notifications: the subscription checked on every connect, the badge (push.ts).
startPush(store);

// The page may never run again once hidden (iOS kills background web apps), so
// the cache is written now rather than after its usual delay.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") store.flush();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((err: Error) => {
    console.warn(`Multi-Code: no service worker, so no offline start: ${err.message}`);
  });
}
