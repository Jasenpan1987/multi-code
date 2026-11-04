// Notifications and the Home Screen hand-off (T-811) in a real browser against the
// running harness, with what a desktop browser can't do stubbed in an init script:
// the Home Screen (standalone), Notification and its permission, the PushManager,
// the clipboard and the app badge. Checks what reaches the Mac in the harness's
// /log, and takes the setup screen's shots.
//   node scripts/mobile-harness/push-check.ts --control <control url> [--user-data <harness userData>]
//                                            [--browser webkit|chromium] [--channel chrome] [--shots <dir>]
// `--user-data` reads the harness's VAPID key (remote-push.json) to check the key
// the phone subscribed with. Nothing is pushed: the subscriptions are made up, and
// their endpoint is never called.
//
// Every context pairs from the harness's one offer, so they are all the same phone
// to the Mac: what one turned on, the next one finds on (auth-ok.pushEnabled).

import fs from "node:fs";
import path from "node:path";
import { chromium, devices, webkit, type BrowserContext, type Page } from "playwright";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const control = option("control") ?? process.env.HARNESS_CONTROL;
if (!control) {
  console.error("usage: node scripts/mobile-harness/push-check.ts --control <control url> [--user-data <dir>] [--shots <dir>]");
  process.exit(2);
}
const userData = option("user-data");
const shots = option("shots");
const engine = option("browser") === "chromium" ? chromium : webkit;

interface Stub {
  standalone: boolean;
  permission: "default" | "granted" | "denied";
  // What requestPermission answers.
  answer: "granted" | "denied";
  // A subscription that exists before the app starts, made for `key` (base64url).
  existing: { endpoint: string; key: string } | null;
  clipboard: string;
}

interface Recorded {
  calls: string[];
  keys: string[];
  // Each made-up subscription's toJSON(), by endpoint: what push-subscribe must carry.
  json: Record<string, string>;
  badges: number[];
  clipboardWrites: string[];
  // WebSockets the page opened: a reconnect opens one more.
  sockets: number;
}

interface LogEntry {
  frame: {
    type: string;
    subscription?: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } } | null;
  };
  ack?: { ok: boolean; reason?: string };
}

// Runs in the page before its scripts.
function install(stub: Stub) {
  const rec: Recorded = { calls: [], keys: [], json: {}, badges: [], clipboardWrites: [], sockets: 0 };
  (window as unknown as { __rec: Recorded }).__rec = rec;
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      rec.sockets += 1;
    }
  };
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64url = (s: string) => {
    const b = s.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), "=")), (c) => c.charCodeAt(0));
  };

  // The Home Screen, or Safari.
  Object.defineProperty(navigator, "standalone", { get: () => stub.standalone, configurable: true });
  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    query.includes("display-mode: standalone")
      ? ({
          matches: stub.standalone,
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        } as MediaQueryList)
      : matchMedia(query);

  // Notification permission.
  class FakeNotification {
    static permission: NotificationPermission = stub.permission;
    static async requestPermission() {
      rec.calls.push("requestPermission");
      FakeNotification.permission = stub.answer;
      return stub.answer;
    }
  }
  Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true, writable: true });
  if (!("PushManager" in window)) Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });

  // The PushManager, behind `navigator.serviceWorker.ready`.
  let made = 0;
  let current: unknown = null;
  const subscription = (endpoint: string, key: Uint8Array) => {
    const json = { endpoint, expirationTime: null, keys: { p256dh: `BPhone-${made}-p256dh`, auth: `auth-${made}` } };
    rec.json[endpoint] = JSON.stringify(json);
    const sub = {
      endpoint,
      options: { applicationServerKey: key.slice().buffer, userVisibleOnly: true },
      toJSON: () => structuredClone(json),
      unsubscribe: async () => {
        rec.calls.push(`unsubscribe ${endpoint}`);
        if (current === sub) current = null;
        return true;
      },
    };
    return sub;
  };
  if (stub.existing) {
    made += 1;
    current = subscription(stub.existing.endpoint, unb64url(stub.existing.key));
  }
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      made += 1;
      const endpoint = `https://push.example/phone-${made}`;
      rec.calls.push(`subscribe ${endpoint}`);
      rec.keys.push(b64url(new Uint8Array(options.applicationServerKey)));
      current = subscription(endpoint, new Uint8Array(options.applicationServerKey));
      return current;
    },
  };
  const registration = { pushManager };
  if (navigator.serviceWorker) {
    Object.defineProperty(navigator.serviceWorker, "ready", { get: () => Promise.resolve(registration), configurable: true });
  } else {
    const container = Object.assign(new EventTarget(), { ready: Promise.resolve(registration), register: async () => registration });
    Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  }

  // The badge and the clipboard.
  Object.assign(navigator, {
    setAppBadge: async (n: number) => void rec.badges.push(n),
    clearAppBadge: async () => void rec.badges.push(0),
  });
  let clip = stub.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      readText: async () => clip,
      writeText: async (text: string) => {
        clip = text;
        rec.clipboardWrites.push(text);
      },
    },
    configurable: true,
  });
}

const defaults: Stub = { standalone: true, permission: "default", answer: "granted", existing: null, clipboard: "" };

const { url, origin } = (await (await fetch(`${control}/pair`)).json()) as { url: string; origin: string };
const vapid = userData
  ? (JSON.parse(fs.readFileSync(path.join(userData, "remote-push.json"), "utf8")) as { publicKey: string }).publicKey
  : null;
// A key the Mac never had: a subscription made for it must be replaced.
const OLD_KEY = `B${"A".repeat(86)}`;

async function post(p: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${control}${p}`, { method: "POST" });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) throw new Error(`POST ${p}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}
const log = async () => (await (await fetch(`${control}/log`)).json()) as LogEntry[];
const pushes = async () => (await log()).filter((e) => e.frame.type === "push-subscribe");
// The frame carries the subscription the phone made, keys and all, as toJSON() gave it.
const carries = (e: LogEntry | undefined, r: Recorded, endpoint: string | undefined) =>
  !!e && !!endpoint && !!r.json[endpoint] && JSON.stringify(e.frame.subscription) === r.json[endpoint];

let failures = 0;
function check(what: string, ok: boolean, detail: unknown = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
}

// `--channel chrome`: the installed Google Chrome (in a profile of Playwright's own)
// when Playwright's Chromium isn't downloaded.
const channel = option("channel");
const browser = await engine.launch(channel ? { channel } : {});

async function open(
  stub: Partial<Stub>,
  options: { colorScheme?: "dark" | "light"; at?: string } = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...devices["iPhone 15 Pro"],
    viewport: { width: 393, height: 852 },
    colorScheme: options.colorScheme ?? "dark",
  });
  await context.addInitScript(install, { ...defaults, ...stub });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`page error: ${err.message}`));
  await page.goto(options.at ?? url);
  await page.waitForSelector(".setup-screen, .list-screen");
  return { context, page };
}

const rec = (page: Page) => page.evaluate(() => (window as unknown as { __rec: Recorded }).__rec);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Until the harness has logged `count` push-subscribes and answered them all, for at
// most 5 s; then, a little longer, so one more than expected would show too.
async function settled(count: number) {
  for (let i = 0; i < 50; i++) {
    const all = await pushes();
    if (all.length >= count && all.every((e) => e.ack)) break;
    await wait(100);
  }
  await wait(300);
  return pushes();
}
const endpointCalled = (call: string | undefined) => call?.replace(/^(un)?subscribe /, "");

async function shot(page: Page, name: string) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`     ${file}`);
}

try {
  await post("/scenario/home?live=0");

  // --- Step 3 from the tap -------------------------------------------------
  for (const colorScheme of ["dark", "light"] as const) {
    await post("/log/clear");
    const { context, page } = await open({}, { colorScheme });
    await page.waitForSelector("text=Connected to MacBook Air");
    if (colorScheme === "dark") {
      // A launch with permission never asked sends nothing.
      await wait(500);
      check("a launch before step 3 sends no push-subscribe", (await pushes()).length === 0, await pushes());
    }
    await shot(page, `setup-step3-${colorScheme}`);
    await page.getByRole("button", { name: "Turn on notifications" }).tap();
    await page.getByRole("button", { name: "Turn off notifications" }).waitFor();
    const sent = await settled(1);
    const r = await rec(page);
    check(`[${colorScheme}] step 3 asks for permission, then subscribes`, r.calls[0] === "requestPermission" && r.calls.at(-1)?.startsWith("subscribe") === true, r.calls);
    if (vapid) check(`[${colorScheme}] subscribed with the Mac's VAPID key`, r.keys.at(-1) === vapid, r.keys);
    const last = sent.at(-1);
    check(
      `[${colorScheme}] step 3 sends that subscription, acked ok`,
      sent.length === 1 && last?.ack?.ok === true && carries(last, r, endpointCalled(r.calls.at(-1))),
      sent
    );
    await shot(page, `settings-on-${colorScheme}`);
    if (colorScheme === "light") {
      await page.getByRole("button", { name: "Unpair from MacBook Air" }).tap();
      await shot(page, "settings-unpair-confirm-light");
    }
    await context.close();
  }

  // --- Every launch --------------------------------------------------------
  // Permission granted, the Mac holds this phone's subscription, the phone lost it.
  await post("/log/clear");
  {
    const { context, page } = await open({ permission: "granted", existing: null });
    const sent = await settled(1);
    const r = await rec(page);
    check("launch, subscription missing: subscribes and sends it", r.calls.length === 1 && r.calls[0].startsWith("subscribe") && sent.length === 1 && carries(sent[0], r, endpointCalled(r.calls[0])), { calls: r.calls, sent });
    await context.close();
  }

  // A subscription made for a key the Mac no longer has.
  await post("/log/clear");
  {
    const { context, page } = await open({ permission: "granted", existing: { endpoint: "https://push.example/old-key", key: OLD_KEY } });
    const sent = await settled(1);
    const r = await rec(page);
    check(
      "launch, key changed: unsubscribes, subscribes with the Mac's key, sends the new one",
      r.calls[0] === "unsubscribe https://push.example/old-key" &&
        r.calls[1]?.startsWith("subscribe") &&
        (!vapid || r.keys[0] === vapid) &&
        sent.length === 1 &&
        carries(sent[0], r, endpointCalled(r.calls[1])),
      { calls: r.calls, sent }
    );
    await context.close();
  }

  // Everything in order: the subscription it has, sent once. Made for the key the
  // phone subscribed with, which is the Mac's whether or not --user-data was given.
  await post("/log/clear");
  const { known, macKey } = await (async () => {
    const { context, page } = await open({ permission: "granted", existing: null });
    await settled(1);
    const r = await rec(page);
    await context.close();
    return { known: endpointCalled(r.calls[0]) ?? "", macKey: r.keys[0] };
  })();
  await post("/log/clear");
  {
    const { context, page } = await open({ permission: "granted", existing: { endpoint: known, key: macKey } });
    const sent = await settled(1);
    const r = await rec(page);
    check("launch, all in order: no new subscription, the one it has sent once", r.calls.length === 0 && sent.length === 1 && carries(sent[0], r, known), { calls: r.calls, sent });
    // Turning off from the settings: null, acked, and the subscription dropped.
    await post("/log/clear");
    await page.getByRole("button", { name: "Turn off notifications" }).tap();
    await page.getByRole("button", { name: "Turn on notifications" }).waitFor();
    const off = await settled(1);
    const after = await rec(page);
    check("turning off sends push-subscribe null, acked, and unsubscribes", off.length === 1 && off[0].frame.subscription === null && off[0].ack?.ok === true && after.calls.includes(`unsubscribe ${known}`), { off, calls: after.calls });
    // A reconnect while off doesn't turn them on again: a new socket, authenticated
    // (the setup screen says Connected again), and still nothing sent.
    await post("/log/clear");
    const socketsBefore = (await rec(page)).sockets;
    const { dropped } = await post("/drop");
    await page.waitForFunction((n) => (window as unknown as { __rec: Recorded }).__rec.sockets > n, socketsBefore);
    await page.waitForSelector("text=Connected to MacBook Air");
    await wait(800);
    check("a reconnect while off sends nothing", (dropped as number) >= 1 && (await pushes()).length === 0, { dropped, sent: await pushes() });
    await context.close();
  }

  // The Mac holds none (turned off above) while this phone still has one and permission.
  await post("/log/clear");
  {
    const { context, page } = await open({ permission: "granted", existing: { endpoint: "https://push.example/kept", key: macKey } });
    const sent = await settled(1);
    const r = await rec(page);
    check(
      "launch, pushEnabled false: subscribes again and sends the new one",
      r.calls[0] === "unsubscribe https://push.example/kept" && r.calls[1]?.startsWith("subscribe") && sent.length === 1 && carries(sent[0], r, endpointCalled(r.calls[1])),
      { calls: r.calls, sent }
    );

    // The badge: the home scenario's two Needs you, then one answered at the desk.
    check("badge set to the Needs you count", r.badges.at(-1) === 2, r.badges);
    await post("/desk-answer/multi-code");
    await wait(800);
    check("badge follows a Needs you answered at the desk", (await rec(page)).badges.at(-1) === 1, (await rec(page)).badges);

    // A notification tapped while the app is open (sw.ts posts this).
    await page.evaluate((o) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "navigate", url: `${o}/#/s/${encodeURIComponent("multi-code")}` } }));
    }, origin);
    await wait(300);
    check("a tapped notification opens its session", (await page.evaluate(() => location.hash)) === "#/s/multi-code", await page.evaluate(() => location.hash));
    await context.close();
  }

  // Denied.
  for (const colorScheme of ["dark", "light"] as const) {
    await post("/log/clear");
    await post("/scenario/home?live=0");
    // Off at the Mac first, so step 3 offers the button.
    const { context, page } = await open({ permission: "default", answer: "denied" }, { colorScheme });
    await page.waitForSelector("text=Connected to MacBook Air");
    const offButton = page.getByRole("button", { name: "Turn off notifications" });
    if (await offButton.count()) {
      await offButton.tap();
      await page.getByRole("button", { name: "Turn on notifications" }).waitFor();
    }
    await post("/log/clear");
    await page.getByRole("button", { name: "Turn on notifications" }).tap();
    await page.waitForSelector("text=Settings › Notifications › Multi-Code");
    check(`[${colorScheme}] denied: says how to allow it, sends nothing`, (await pushes()).length === 0, await pushes());
    await shot(page, `setup-denied-${colorScheme}`);
    await context.close();
  }

  // --- Unpairing from the settings ------------------------------------------
  await post("/log/clear");
  {
    const { context, page } = await open({ permission: "granted" });
    await page.getByRole("button", { name: "Turn off notifications" }).waitFor();
    await settled(1);
    await post("/log/clear");
    await page.getByRole("button", { name: "Unpair from MacBook Air" }).tap();
    await shot(page, "settings-unpair-confirm-dark");
    await page.locator(".confirm").getByRole("button", { name: "Unpair" }).tap();
    await page.waitForSelector("text=Pair with your Mac");
    const sent = await settled(1);
    const r = await rec(page);
    check("unpairing tells the Mac (null) and drops the subscription", sent.length === 1 && sent[0].frame.subscription === null && r.calls.some((c) => c.startsWith("unsubscribe")), { sent, calls: r.calls });
    await context.close();
  }

  // --- The hand-off (the Mac holds no subscription now: a first setup) ------
  for (const colorScheme of ["dark", "light"] as const) {
    // Safari, after the scan: copy.
    const safari = await open({ standalone: false }, { colorScheme });
    await safari.page.waitForSelector("text=Connected to MacBook Air");
    await shot(safari.page, `safari-step2-copy-${colorScheme}`);
    await safari.page.getByRole("button", { name: "Copy pairing link" }).tap();
    await safari.page.getByRole("button", { name: "Copied ✓" }).waitFor();
    const copied = (await rec(safari.page)).clipboardWrites.at(-1) ?? "";
    const decode = (link: string) => JSON.parse(Buffer.from(link.split("#pair=")[1] ?? "", "base64url").toString("utf8")) as unknown;
    check(`[${colorScheme}] Safari copies the pairing link it was opened with`, copied.startsWith(`${origin}/#pair=`) && JSON.stringify(decode(copied)) === JSON.stringify(decode(url)), copied);
    check(`[${colorScheme}] Safari's step 3 stays disabled`, await safari.page.getByRole("button", { name: /notifications/i }).isDisabled());
    await safari.context.close();

    // The Home Screen app, unpaired: paste.
    const home = await open({ standalone: true, clipboard: copied }, { colorScheme, at: `${origin}/` });
    await home.page.waitForSelector("text=Pair with your Mac");
    await shot(home.page, `home-unpaired-paste-${colorScheme}`);
    await home.page.getByRole("button", { name: "Paste pairing link" }).tap();
    await home.page.waitForSelector("text=Connected to MacBook Air");
    const writes = (await rec(home.page)).clipboardWrites;
    check(`[${colorScheme}] the Home Screen app pairs from the clipboard, then clears it`, writes.at(-1) === "", writes);
    await home.context.close();
  }

  // A link for another address, or no link at all.
  {
    const other = url.replace(/#pair=.*/, "#pair=") + Buffer.from(JSON.stringify({ v: 3, origin: "https://other.tailnet.ts.net", hostPublicKey: "k", deviceToken: "t", hostName: "x" })).toString("base64url");
    const home = await open({ standalone: true, clipboard: other }, { at: `${origin}/` });
    await home.page.getByRole("button", { name: "Paste pairing link" }).tap();
    await home.page.waitForSelector("text=That link is for other.tailnet.ts.net");
    check("a pasted link for another address is refused, the clipboard kept", (await rec(home.page)).clipboardWrites.length === 0);
    await shot(home.page, "home-paste-wrong-origin-dark");
    await home.context.close();
  }

  // The settings place, reached from the list's ⚙ with everything on.
  for (const colorScheme of ["dark", "light"] as const) {
    const { context, page } = await open({ permission: "granted" }, { colorScheme });
    await page.getByRole("button", { name: "Turn off notifications" }).waitFor();
    await page.evaluate(() => (location.hash = "#/"));
    await page.locator('a[href="#/setup"]').tap();
    await page.getByRole("button", { name: "Turn off notifications" }).waitFor();
    await shot(page, `settings-${colorScheme}`);
    await context.close();
  }
  // --- The real service worker (Chromium only: CDP delivers a push to it) ---
  if (engine === chromium) await realWorker();
} finally {
  await browser.close();
}

// The built sw.js, unstubbed: a push delivered by CDP (no push service, nothing
// leaves this Mac) with the Mac's payload (main/remote/push.ts declarativePayload)
// must end in the notification the system would show, its URL kept for the tap.
async function realWorker() {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  await context.grantPermissions(["notifications"], { origin });
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  // `ready` never settles when sw.js couldn't register: bounded, so the check fails
  // and the browser closes instead of the script hanging.
  await within(10_000, "the service worker to be ready", page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)));
  const cdp = await context.newCDPSession(page);
  const registrationId = await within(
    10_000,
    "the service worker's registration",
    new Promise<string>((resolve, reject) => {
      cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }: { registrations: { registrationId: string; scopeURL: string }[] }) => {
        const mine = registrations.find((r) => r.scopeURL === `${origin}/`);
        if (mine) resolve(mine.registrationId);
      });
      cdp.send("ServiceWorker.enable").catch(reject);
    })
  );
  const data = JSON.stringify({
    web_push: 8030,
    notification: {
      title: "multi-code · Needs you",
      body: "Bash: pnpm test:e2e",
      navigate: `${origin}/#/s/${encodeURIComponent("multi-code")}`,
      tag: "multi-code",
    },
    app_badge: 2,
  });
  await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId, data });
  let shown: { title: string; body: string; tag: string; data: unknown }[] = [];
  for (let i = 0; i < 30 && shown.length === 0; i++) {
    await wait(100);
    shown = await page.evaluate(async () =>
      (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data as unknown }))
    );
  }
  check(
    "the real worker shows a delivered push with its title, body, tag and URL",
    shown.length === 1 &&
      shown[0].title === "multi-code · Needs you" &&
      shown[0].body === "Bash: pnpm test:e2e" &&
      shown[0].tag === "multi-code" &&
      JSON.stringify(shown[0].data) === JSON.stringify({ navigate: `${origin}/#/s/multi-code` }),
    shown
  );
  await context.close();
}

// A wait that gives up, so a broken build fails the check rather than hanging it.
function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up waiting ${ms / 1000} s for ${what}`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
