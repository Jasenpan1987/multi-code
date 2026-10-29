// The phone app's service worker, at the root (`/sw.js`, scope `/`). It keeps the
// page and its files, so the app opens when the Mac can't be reached (PRD Story 1:
// the old phone link didn't load at all then); the content comes from the
// offline cache (cache.ts).
//
// Network first, with a 3 s timeout: a reachable Mac always serves the current
// build, and a phone that can't reach it (asleep, Tailscale off, no network) opens
// from the cache instead of a Safari error page. A response that arrives after
// the timeout still refreshes the cache. The cache is named after the build, so a
// new build starts a new one and the old one is deleted.
//
// It also shows a push that reaches it (PRD Story 7), and opens the session a
// tapped notification is about.
//
// Built by rspack as its own entry (rspack.mobile.config.ts), which defines
// __SW_VERSION__.

declare const __SW_VERSION__: string;

// The service worker globals the DOM lib doesn't declare, as far as this file uses
// them.
export interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

export interface PushEvent extends ExtendableEvent {
  data: { text(): string } | null;
  // WebKit's "proposed notification": set when the push is a Declarative Web Push
  // message the browser shows by itself unless the handler shows another.
  notification?: unknown;
}

export interface NotificationEvent extends ExtendableEvent {
  notification: { data: unknown; close(): void };
}

export interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface ShowOptions {
  body?: string;
  tag?: string;
  // Alert again when it replaces an older one with the same tag (Story 7: every
  // Finished and every Needs you is told).
  renotify?: boolean;
  icon?: string;
  data?: { navigate: string };
}

export interface WorkerScope {
  location: { origin: string };
  caches: CacheStorage;
  fetch: typeof fetch;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  registration: { showNotification(title: string, options: ShowOptions): Promise<void> };
  navigator: { setAppBadge?(count: number): Promise<void>; clearAppBadge?(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
}

export const NETWORK_TIMEOUT_MS = 3000;
const CACHE_PREFIX = "multicode-";

// What the page needs to open: itself and its bundle (the CSS is inside it), the
// manifest and the setup screen's logo. The Home Screen icons are the system's to
// fetch.
export const SHELL = ["./", "bundle.js", "manifest.webmanifest", "icons/icon-180.png"];

// The page is one document at "./" whatever the path: every navigation is answered
// with it.
const INDEX = "./";

export function attachServiceWorker(scope: WorkerScope, version: string) {
  const cacheName = `${CACHE_PREFIX}${version}`;
  const index = new URL(INDEX, `${scope.location.origin}/`).href;

  scope.addEventListener("install", (event) => {
    event.waitUntil(
      scope.caches
        .open(cacheName)
        .then((cache) => cache.addAll(SHELL))
        .then(() => scope.skipWaiting())
    );
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      scope.caches
        .keys()
        .then((names) =>
          Promise.all(
            names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== cacheName).map((n) => scope.caches.delete(n))
          )
        )
        .then(() => scope.clients.claim())
    );
  });

  scope.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    // Only the app's own files. A URL with a query is never one of them: the
    // link's reachability probe (transport.ts) uses one to get past this cache.
    if (url.origin !== scope.location.origin || url.search) return;
    const page = request.mode === "navigate";
    const { response, done } = networkFirst(scope, cacheName, request, page ? index : request.url, page);
    event.respondWith(response);
    // The cache write, and a network answer that comes after the cache has
    // answered, finish after the response: the worker must stay up for them.
    event.waitUntil(done);
  });

  // The Mac sends a Declarative Web Push message (main/remote/push.ts
  // `declarativePayload`). iOS 18.4+ shows it and sets the badge itself, without
  // waking this worker: there is no `mutable` in it. A browser that wakes the worker
  // with a proposed notification shows that one when the handler shows none, so it
  // is left alone. Any other browser hands the JSON over, and it is shown here as the
  // system would: every push must show something, or the browser stops them.
  scope.addEventListener("push", (event) => {
    if (event.notification) return;
    const { title, options, badge } = readPush(event.data, scope.location.origin);
    const shown = scope.registration.showNotification(title, options);
    event.waitUntil(badge === undefined ? shown : Promise.all([shown, setBadge(scope, badge)]));
  });

  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(openApp(scope, targetOf(event.notification.data, scope.location.origin)));
  });
}

export interface ReadPush {
  title: string;
  options: ShowOptions;
  // The Home Screen icon's number; undefined leaves it as it is.
  badge?: number;
}

// A push's JSON as the notification to show. Whatever doesn't read right still
// shows one, opening the list.
export function readPush(data: { text(): string } | null, origin: string): ReadPush {
  let payload: { notification?: Record<string, unknown>; app_badge?: unknown } = {};
  try {
    const parsed = JSON.parse(data?.text() ?? "") as unknown;
    if (parsed && typeof parsed === "object") payload = parsed as typeof payload;
  } catch {
    // Not JSON: the fallback below.
  }
  const n = payload.notification && typeof payload.notification === "object" ? payload.notification : {};
  const title = typeof n.title === "string" && n.title ? n.title : "Multi-Code";
  const tag = typeof n.tag === "string" && n.tag ? n.tag : undefined;
  const options: ShowOptions = {
    ...(typeof n.body === "string" && n.body ? { body: n.body } : {}),
    ...(tag ? { tag, renotify: true } : {}),
    icon: `${origin}/icons/icon-192.png`,
    data: { navigate: targetOf({ navigate: n.navigate }, origin) },
  };
  // A number at the top level (WebKit 295319@main); the standard allows a numeric
  // string too.
  const raw = typeof payload.app_badge === "string" ? Number(payload.app_badge) : payload.app_badge;
  const badge = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  return { title, options, ...(badge !== undefined ? { badge } : {}) };
}

// The URL a notification opens: its `navigate` when that is this app's, else the list.
export function targetOf(data: unknown, origin: string): string {
  const navigate = (data as { navigate?: unknown } | null)?.navigate;
  if (typeof navigate === "string") {
    try {
      const url = new URL(navigate, `${origin}/`);
      if (url.origin === origin) return url.href;
    } catch {
      // Not a URL: the list.
    }
  }
  return `${origin}/#/`;
}

function setBadge(scope: WorkerScope, count: number): Promise<void> {
  const { navigator } = scope;
  const set = count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
  return (set ?? Promise.resolve()).catch(() => {});
}

// The app's window brought forward and told where to go (push.ts follows it to the
// route), or a new one opened at the URL. A message rather than
// `WindowClient.navigate`, which may reload the page to change only its hash.
async function openApp(scope: WorkerScope, url: string): Promise<void> {
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const app = windows.find((w) => sameOrigin(w.url, scope.location.origin));
  if (!app) {
    await scope.clients.openWindow(url);
    return;
  }
  try {
    await app.focus();
  } catch {
    // Focus can be refused; the app still goes to the session when next seen.
  }
  app.postMessage({ type: "navigate", url });
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

// `response`: the network's if it comes within NETWORK_TIMEOUT_MS and isn't a
// server error, else the cached one; the network's after all if nothing is
// cached. A server error is what `tailscale serve` answers (502) when Multi-Code
// isn't running: the app should still open, from the cache, and say so.
// `done`: settles once the network has answered and a 200 has been cached. Under
// the page's key (`page`) only an HTML answer is kept, so a window that navigated
// to bundle.js can't replace the app.
export function networkFirst(
  scope: WorkerScope,
  cacheName: string,
  request: Request,
  key: string,
  page = false
): { response: Promise<Response>; done: Promise<void> } {
  let copy: Response | null = null;
  // Cloned as it arrives, before the page can start reading the body.
  const fromNetwork = scope.fetch(request).then((response) => {
    const html = (response.headers.get("content-type") ?? "").startsWith("text/html");
    if (response.status === 200 && (!page || html)) copy = response.clone();
    return response;
  });
  const done = fromNetwork
    .then(async () => {
      if (!copy) return;
      const cache = await scope.caches.open(cacheName);
      await cache.put(key, copy);
    })
    .catch(() => {});
  return { response: respond(scope, fromNetwork, key), done };
}

async function respond(scope: WorkerScope, fromNetwork: Promise<Response>, key: string): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), NETWORK_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([fromNetwork, timedOut]);
    if (first !== "timeout" && first.status < 500) return first;
  } catch {
    // Offline, or the Mac's address doesn't answer: the cache, below.
  } finally {
    clearTimeout(timer);
  }
  const cached = await scope.caches.match(key);
  if (cached) return cached;
  // Nothing cached (a first visit): the network's answer after all, error or not.
  return fromNetwork;
}

// Inside a service worker, `registration` is a global; in a test importing this
// file it isn't, and the test attaches a fake scope itself.
if (typeof self !== "undefined" && "registration" in self && typeof __SW_VERSION__ === "string") {
  attachServiceWorker(self as unknown as WorkerScope, __SW_VERSION__);
}
