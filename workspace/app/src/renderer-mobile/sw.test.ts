// The service worker on a fake scope: network first with a 3 s timeout, the cache
// when the Mac can't be reached, and only the app's own files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_TIMEOUT_MS, SHELL, attachServiceWorker, type ExtendableEvent, type FetchEvent, type WorkerScope } from "./sw";

const ORIGIN = "https://mac.tailnet.ts.net";

// Caches keyed by URL, as CacheStorage's are.
class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  async open(name: string) {
    let store = this.stores.get(name);
    if (!store) this.stores.set(name, (store = new Map()));
    return {
      addAll: async (urls: string[]) => {
        for (const url of urls) store.set(new URL(url, `${ORIGIN}/sw.js`).href, new Response(`shell ${url}`));
      },
      put: async (key: string, response: Response) => void store.set(key, response),
    };
  }
  async match(key: string) {
    for (const store of this.stores.values()) {
      const hit = store.get(key);
      if (hit) return hit.clone();
    }
    return undefined;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

let caches: FakeCaches;
let network: (request: Request) => Promise<Response>;
let listeners: Record<string, (event: never) => void>;
let skipped: boolean;
let claimed: boolean;

function attach(version = "1") {
  const scope = {
    location: { origin: ORIGIN },
    caches: caches as unknown as CacheStorage,
    fetch: ((request: Request) => network(request)) as typeof fetch,
    skipWaiting: async () => void (skipped = true),
    clients: { claim: async () => void (claimed = true) },
    addEventListener: (type: string, listener: (event: never) => void) => (listeners[type] = listener),
  } as WorkerScope;
  attachServiceWorker(scope, version);
}

function lifecycle(type: "install" | "activate"): Promise<unknown> {
  let wait: Promise<unknown> = Promise.resolve();
  const event = { waitUntil: (p: Promise<unknown>) => (wait = p) } as unknown as ExtendableEvent;
  (listeners[type] as (e: ExtendableEvent) => void)(event);
  return wait;
}

// What the worker asked the browser to stay up for, from the last fetch event.
let waited: Promise<unknown>[];

// The response the worker gives, or null when it leaves the request to the browser.
function fetchEvent(url: string, init: { mode?: RequestMode; method?: string } = {}): Promise<Response> | null {
  let responded: Promise<Response> | null = null;
  waited = [];
  const request = { url, method: init.method ?? "GET", mode: init.mode ?? "no-cors" } as Request;
  const event = {
    request,
    respondWith: (r: Response | Promise<Response>) => (responded = Promise.resolve(r)),
    waitUntil: (p: Promise<unknown>) => waited.push(p),
  } as unknown as FetchEvent;
  (listeners.fetch as (e: FetchEvent) => void)(event);
  return responded;
}

const settled = () => Promise.all(waited);
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

beforeEach(() => {
  vi.useFakeTimers();
  caches = new FakeCaches();
  listeners = {};
  skipped = claimed = false;
  network = async (request) => new Response(`network ${request.url}`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("service worker", () => {
  it("keeps the app shell on install and takes over at once", async () => {
    attach("7");
    await lifecycle("install");
    expect([...caches.stores.get("multicode-7")!.keys()]).toEqual(SHELL.map((f) => new URL(f, `${ORIGIN}/`).href));
    expect(skipped).toBe(true);
  });

  it("deletes the caches of earlier builds when it activates", async () => {
    await caches.open("multicode-old");
    await caches.open("someone-else");
    attach("new");
    await lifecycle("install");
    await lifecycle("activate");
    expect(await caches.keys()).toEqual(["someone-else", "multicode-new"]);
    expect(claimed).toBe(true);
  });

  it("serves the network's answer, and keeps it while the browser waits for it", async () => {
    attach();
    const response = await fetchEvent(`${ORIGIN}/bundle.js`)!;
    expect(await response.text()).toBe(`network ${ORIGIN}/bundle.js`);
    expect(waited).toHaveLength(1);
    await settled();
    expect(await (await caches.match(`${ORIGIN}/bundle.js`))!.text()).toBe(`network ${ORIGIN}/bundle.js`);
  });

  it("opens from the cache when Multi-Code is down behind tailscale serve (a fast 502)", async () => {
    attach();
    await lifecycle("install");
    network = async () => new Response("Bad Gateway", { status: 502 });
    const page = await fetchEvent(`${ORIGIN}/`, { mode: "navigate" })!;
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("shell ./");
    expect(await (await fetchEvent(`${ORIGIN}/bundle.js`)!).text()).toBe("shell bundle.js");
    await settled();
    expect(await (await caches.match(`${ORIGIN}/bundle.js`))!.text()).toBe("shell bundle.js");
  });

  it("keeps only an HTML answer as the page, so a window on bundle.js can't replace the app", async () => {
    attach();
    network = async (request) =>
      request.url.endsWith("/") ? html("the app") : new Response("js", { headers: { "content-type": "text/javascript" } });
    await fetchEvent(`${ORIGIN}/bundle.js`, { mode: "navigate" });
    await settled();
    expect(await caches.match(`${ORIGIN}/`)).toBeUndefined();
    await fetchEvent(`${ORIGIN}/`, { mode: "navigate" });
    await settled();
    expect(await (await caches.match(`${ORIGIN}/`))!.text()).toBe("the app");
  });

  it("answers every navigation with the one page, from the cache when the Mac can't be reached", async () => {
    attach();
    await lifecycle("install");
    network = async () => {
      throw new TypeError("Load failed");
    };
    const response = await fetchEvent(`${ORIGIN}/`, { mode: "navigate" })!;
    expect(await response.text()).toBe("shell ./");
    const deep = await fetchEvent(`${ORIGIN}/index.html`, { mode: "navigate" })!;
    expect(await deep.text()).toBe("shell ./");
  });

  it("gives up on a network that takes over 3 s, and still keeps what it brings", async () => {
    attach();
    await lifecycle("install");
    let arrive: (r: Response) => void = () => {};
    network = () => new Promise((resolve) => (arrive = resolve));
    const pending = fetchEvent(`${ORIGIN}/bundle.js`)!;
    await vi.advanceTimersByTimeAsync(NETWORK_TIMEOUT_MS);
    expect(await (await pending).text()).toBe("shell bundle.js");

    arrive(new Response("late build"));
    await settled();
    expect(await (await caches.match(`${ORIGIN}/bundle.js`))!.text()).toBe("late build");
  });

  it("waits for the network after all when nothing is cached", async () => {
    attach();
    let arrive: (r: Response) => void = () => {};
    network = () => new Promise((resolve) => (arrive = resolve));
    const pending = fetchEvent(`${ORIGIN}/icons/icon-512.png`)!;
    await vi.advanceTimersByTimeAsync(NETWORK_TIMEOUT_MS + 1000);
    arrive(new Response("icon"));
    expect(await (await pending).text()).toBe("icon");
  });

  it("passes an error on when nothing is cached, and doesn't keep it", async () => {
    attach();
    network = async () => new Response("Bad Gateway", { status: 502 });
    expect((await fetchEvent(`${ORIGIN}/bundle.js`)!).status).toBe(502);
    await settled();
    expect(await caches.match(`${ORIGIN}/bundle.js`)).toBeUndefined();
  });

  it("leaves alone what isn't the app's own file", () => {
    attach();
    expect(fetchEvent(`${ORIGIN}/manifest.webmanifest?reach=1`)).toBeNull();
    expect(fetchEvent("https://elsewhere.example/x.js")).toBeNull();
    expect(fetchEvent(`${ORIGIN}/bundle.js`, { method: "POST" })).toBeNull();
  });
});
