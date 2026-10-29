// Web Push on the phone (PRD Story 7): turning notifications on from the setup
// screen's step 3, keeping the Mac's copy of this phone's subscription right, and
// the Home Screen icon's badge while the app is open. The service worker (sw.ts)
// shows what arrives while it is closed.
//
// iOS drops a subscription silently and never fires `pushsubscriptionchange`, and
// only the Home Screen app can have one (docs/timeline/2026-10-13_mobile-v2-research.md).
// The Mac drops its copy when the push service says it is gone, and forgets every
// copy when it makes new keys. So on every connect the Home Screen app compares what
// it has with what `auth-ok` says, subscribes again when they don't match, and on the
// first connect of a launch sends what it has anyway (the Mac ignores an unchanged
// one; a subscription the browser replaced reaches it that way).

import type { RemotePushSubscription } from "../shared/remote-protocol";
import { clearCache } from "./cache";
import { isStandalone } from "./format";
import { idOf, type OutboxItem } from "./outbox";
import { navigate, parseHash, type Route } from "./routes";
import type { AppState } from "./state";
import type { Store } from "./store";

// Set when the builder turned notifications off on this phone, so the launch check
// doesn't turn them on again behind their back while permission stays granted.
const OFF_KEY = "multicode.push.off";

// A push-subscribe the Mac refused (`failed`: it couldn't save it) is sent again
// after this long, this many times per connection; the next connect's check starts
// over.
export const RESEND_MS = 5000;
export const RESENDS = 3;

// How long to wait for the service worker before giving up on push for now: `ready`
// never settles when it couldn't be registered.
const WORKER_WAIT_MS = 10_000;

// The parts of PushSubscription and PushManager used here, so tests and the
// Playwright stubs can stand in for them.
export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>;
}

export interface PushEnv {
  storage: Storage;
  standalone(): boolean;
  // Null when this browser has no Web Push: an iPhone before 16.4, or Safari's tab.
  permission(): NotificationPermission | null;
  requestPermission(): Promise<NotificationPermission>;
  // Null when there is no service worker to subscribe with.
  pushManager(): Promise<PushManagerLike | null>;
  // The Home Screen icon's number; 0 clears it.
  setBadge(count: number): void;
  // A tapped notification, while the app was open: the URL it opens (sw.ts).
  onNotificationClick(listener: (url: string) => void): () => void;
}

// The store as push uses it: it reads the state and sends through the actions.
export type PushStore = Pick<Store, "getState" | "subscribe" | "actions">;

export const browserEnv: PushEnv = {
  // Read when used: importing this file (tests) must not touch the global.
  get storage() {
    return localStorage;
  },
  standalone: isStandalone,
  permission() {
    if (typeof Notification === "undefined" || !("PushManager" in window) || !("serviceWorker" in navigator)) return null;
    return Notification.permission;
  },
  requestPermission: () => Notification.requestPermission(),
  pushManager() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), WORKER_WAIT_MS)));
    const ready = navigator.serviceWorker.ready.then((r) => r.pushManager as PushManagerLike);
    return Promise.race([ready, late]).finally(() => clearTimeout(timer));
  },
  setBadge(count) {
    if (!("setAppBadge" in navigator)) return;
    (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
  },
  onNotificationClick(listener) {
    if (!("serviceWorker" in navigator)) return () => {};
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === "navigate" && typeof data.url === "string") listener(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  },
};

// `auth-ok.vapidPublicKey` (base64url) as `applicationServerKey` wants it.
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// Whether a subscription was made for this key. A browser that doesn't say counts as
// yes: the Mac forgets every subscription when its keys change, and auth-ok then
// says `pushEnabled: false`, which subscribes again all the same.
export function madeFor(subscription: PushSubscriptionLike, key: string): boolean {
  const own = subscription.options?.applicationServerKey;
  if (!own) return true;
  const a = new Uint8Array(own);
  const b = keyBytes(key);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

// What `push-subscribe` carries: `toJSON()`, with only what Web Push uses. Null for
// a subscription without its keys, which the Mac couldn't push to.
export function subscriptionJson(subscription: PushSubscriptionLike): RemotePushSubscription | null {
  const { endpoint, expirationTime, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) return null;
  return { endpoint, expirationTime: expirationTime ?? null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// Turned off on a phone whose storage couldn't keep the flag even without the
// offline cache: off for as long as the app runs, and written as soon as it fits.
const offUnsaved = new WeakSet<Storage>();

export function notificationsOff(storage: Storage): boolean {
  if (offUnsaved.has(storage)) {
    if (writeOff(storage)) offUnsaved.delete(storage);
    return true;
  }
  try {
    return storage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOff(storage: Storage): boolean {
  try {
    storage.setItem(OFF_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

// The flag is what keeps the launch check from turning them on again, so a full
// storage gives up the offline cache for it, as it does for the outbox (store.ts).
function setOff(storage: Storage, off: boolean) {
  if (!off) {
    offUnsaved.delete(storage);
    storage.removeItem(OFF_KEY);
    return;
  }
  if (writeOff(storage)) return;
  clearCache(storage);
  if (writeOff(storage)) return;
  offUnsaved.add(storage);
  console.warn("Multi-Code: no room to remember that notifications are off on this phone after it closes");
}

// The phone's latest push-subscribe still in the outbox: on its way, or refused
// (an acked one leaves it, outbox.ts).
export function pushItem(outbox: OutboxItem[]): OutboxItem | null {
  for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].frame.type === "push-subscribe") return outbox[i];
  return null;
}

export const inFlight = (item: OutboxItem | null) => item?.status === "waiting" || item?.status === "sent";

// The subscription a push-subscribe item carries; null for "off".
export function subscriptionOf(item: OutboxItem): RemotePushSubscription | null {
  return item.frame.type === "push-subscribe" ? item.frame.subscription : null;
}

// Send this phone's subscription (null: off), after forgetting earlier refusals: only
// the latest one is shown, and refused items would otherwise pile up in storage.
function send(store: PushStore, subscription: RemotePushSubscription | null) {
  for (const item of store.getState().outbox) {
    if (item.frame.type === "push-subscribe" && item.status === "refused") store.actions.dismiss(idOf(item));
  }
  return store.actions.pushSubscribe(subscription);
}

// A new subscription for `key`, in place of any this phone has: the one the Mac
// dropped is likely dead, and one made for another key can't be pushed to.
async function subscribeAfresh(manager: PushManagerLike, key: string): Promise<PushSubscriptionLike> {
  const old = await manager.getSubscription();
  if (old) await old.unsubscribe();
  return manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
}

export type TurnOnResult = { ok: true } | { ok: false; denied: boolean; message: string };

// Step 3's button. Must run from the tap: iOS asks for permission only then. The
// service worker is looked up first and awaited after, so nothing comes between the
// tap and the permission request.
export async function turnOn(store: PushStore, env: PushEnv = browserEnv): Promise<TurnOnResult> {
  const { pairing } = store.getState();
  const key = store.getState().push?.vapidPublicKey;
  if (!key) return { ok: false, denied: false, message: "Your Mac can't send notifications right now." };
  const manager = env.pushManager();
  let permission: NotificationPermission;
  try {
    permission = await env.requestPermission();
  } catch (err) {
    return { ok: false, denied: false, message: messageOf(err) };
  }
  if (permission !== "granted") return { ok: false, denied: permission === "denied", message: "" };
  try {
    const pm = await manager;
    if (!pm) return { ok: false, denied: false, message: "The app's service worker isn't running. Close the app and open it again." };
    const json = subscriptionJson(await subscribeAfresh(pm, key));
    if (!json) return { ok: false, denied: false, message: "This phone made a subscription without its keys." };
    // Unpaired meanwhile: there is no Mac to send it to.
    if (store.getState().pairing !== pairing) return { ok: false, denied: false, message: "" };
    setOff(env.storage, false);
    send(store, json);
    return { ok: true };
  } catch (err) {
    return { ok: false, denied: false, message: messageOf(err) };
  }
}

// The settings' "Turn off notifications". The Mac is told first, so it stops even if
// the phone can't reach its push service to drop the subscription.
export async function turnOff(store: PushStore, env: PushEnv = browserEnv) {
  setOff(env.storage, true);
  send(store, null);
  await dropSubscription(env);
}

// Unpairing: the Mac keeps pushing to this phone until told, and the outbox goes with
// the pairing. So the null goes out now on an open link (it is written before the
// socket closes), and the subscription itself is dropped, which the Mac's next push
// finds gone either way. Not "off": a new pairing turns them on again by itself
// while permission stays granted.
export async function unpair(store: PushStore, env: PushEnv = browserEnv) {
  if (store.getState().push?.enabled) store.actions.pushSubscribe(null);
  store.actions.unpair();
  await dropSubscription(env);
}

async function dropSubscription(env: PushEnv) {
  try {
    const subscription = await (await env.pushManager())?.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Offline, most likely. Turning off, the Mac has the null (or gets it from the
    // outbox); unpairing offline, it may go on pushing to this phone until revoked.
  }
}

// The route a tapped notification's URL opens, if it is this app's.
export function routeOf(url: string, origin: string): Route | null {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin ? parseHash(parsed.hash) : null;
  } catch {
    return null;
  }
}

// Started once by index.tsx: on every connect, the launch check; a refused
// push-subscribe sent again; the badge kept at the list's Needs you count while the
// list is live; a notification tapped while the app is open opens its session.
// Returns a stop function (tests).
export function startPush(store: PushStore, env: PushEnv = browserEnv, origin = location.origin): () => void {
  let checked = false;
  let checking = false;
  let sentThisLaunch = false;
  let resends = 0;
  let resendTimer: ReturnType<typeof setTimeout> | null = null;
  let paired = store.getState().pairing !== null;
  // While connected: the list as it stood when the link came up (cached, or from the
  // last connection), which the badge waits past; undefined while not connected.
  let listAtConnect: AppState["instances"] | undefined;
  // What this connection last wrote. Forgotten on every disconnect: while the app was
  // away, a push may have set the badge to something else.
  let badge: number | null = null;

  function onChange() {
    const state = store.getState();
    // Unpaired: no sessions here need the builder, whatever a push last set.
    if (paired && !state.pairing) env.setBadge(0);
    paired = state.pairing !== null;
    if (state.connection.state !== "connected") {
      checked = false;
      resends = 0;
      if (resendTimer) clearTimeout(resendTimer);
      resendTimer = null;
      listAtConnect = undefined;
      badge = null;
      return;
    }
    if (listAtConnect === undefined) listAtConnect = state.instances;
    updateBadge(state);
    if (!env.standalone()) return;
    const item = pushItem(state.outbox);
    // A push-subscribe on its way is settled first: its ack moves `push.enabled`.
    // The check also covers a refusal from an earlier connection.
    if (!checked && !checking && !inFlight(item)) {
      checked = true;
      void check();
    } else if (item?.status === "refused" && item.refusal?.reason === "failed") {
      scheduleResend(idOf(item));
    }
  }

  // Only from a list that came on this connection: the cached one may be older than
  // the last push's badge.
  function updateBadge(state: AppState) {
    if (!state.instances || state.instances === listAtConnect) return;
    const count = state.instances.filter((i) => i.state === "needs-you").length;
    if (count === badge) return;
    badge = count;
    env.setBadge(count);
  }

  async function check() {
    checking = true;
    // After every wait: unpaired or paired anew meanwhile, and what this found is
    // about a pairing that's gone. The next connect's check starts over (and replaces
    // a subscription made here).
    const pairing = store.getState().pairing;
    const gone = () => store.getState().pairing !== pairing;
    try {
      const push = store.getState().push;
      const permission = env.permission();
      if (!push || permission === null) return;
      const off = notificationsOff(env.storage);
      if (off || permission !== "granted") {
        // Turned off here, or blocked in iOS Settings, while the Mac still pushes:
        // it should stop, and its Phone settings should say push is off.
        if (push.enabled && (off || permission === "denied")) send(store, null);
        return;
      }
      if (push.vapidPublicKey === "") return;
      const manager = await env.pushManager();
      if (!manager || gone()) return;
      let subscription = await manager.getSubscription();
      if (gone()) return;
      let fresh = false;
      if (!subscription || !madeFor(subscription, push.vapidPublicKey) || !push.enabled) {
        subscription = await subscribeAfresh(manager, push.vapidPublicKey);
        fresh = true;
      }
      if (!fresh && sentThisLaunch) return;
      // Turned off, or unpaired, while this ran.
      if (notificationsOff(env.storage) || gone()) return;
      const json = subscriptionJson(subscription);
      if (!json) return;
      send(store, json);
      sentThisLaunch = true;
    } catch (err) {
      console.warn(`Multi-Code: couldn't renew this phone's push subscription: ${messageOf(err)}`);
    } finally {
      checking = false;
      // A connect while this ran (after an unpair and a new pairing, say) skipped its
      // own check because this one was running: run it now.
      if (!checked) onChange();
    }
  }

  function scheduleResend(clientMsgId: string) {
    if (resendTimer || resends >= RESENDS) return;
    resends += 1;
    resendTimer = setTimeout(() => {
      resendTimer = null;
      const item = pushItem(store.getState().outbox);
      // Something newer went out meanwhile, or the builder turned them off.
      if (!item || idOf(item) !== clientMsgId || item.status !== "refused") return;
      const subscription = subscriptionOf(item);
      if (subscription && notificationsOff(env.storage)) return;
      send(store, subscription);
    }, RESEND_MS);
  }

  const unsubscribe = store.subscribe(onChange);
  const unlisten = env.onNotificationClick((url) => {
    const route = routeOf(url, origin);
    if (route) navigate(route);
  });
  onChange();
  return () => {
    unsubscribe();
    unlisten();
    if (resendTimer) clearTimeout(resendTimer);
  };
}

function messageOf(err: unknown): string {
  return (err as Error)?.message || String(err);
}
