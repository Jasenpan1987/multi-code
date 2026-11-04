// Notifications on the phone over the real store and a fake link, with a fake
// PushManager: what step 3's tap sends, what every connect checks and sends again,
// turning off, unpairing, the badge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthOkFrame,
  ClientFrame,
  PairingOffer,
  PushSubscribeFrame,
  RemoteInstance,
  ServerFrame,
} from "../shared/remote-protocol";
import {
  RESENDS,
  RESEND_MS,
  keyBytes,
  madeFor,
  routeOf,
  startPush,
  turnOff,
  turnOn,
  unpair,
  type PushEnv,
  type PushManagerLike,
  type PushSubscriptionLike,
} from "./push";
import { createStore, type LinkLike, type Store } from "./store";
import { MemoryStorage } from "./test-storage";
import type { LinkStatus } from "./transport";

const ORIGIN = "https://mac.tailnet.ts.net";
const base64url = (bytes: number[]) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// Two VAPID public keys: 65-byte uncompressed points, as push.ts on the Mac makes.
const KEY = base64url([4, ...Array.from({ length: 64 }, (_, i) => i)]);
const NEW_KEY = base64url([4, ...Array.from({ length: 64 }, (_, i) => 255 - i)]);

const offer: PairingOffer = {
  v: 3,
  origin: ORIGIN,
  hostPublicKey: "host-key",
  deviceToken: "token",
  hostName: "Multi-Code on MacBook Air",
};
const authOk = (change: Partial<AuthOkFrame> = {}): AuthOkFrame => ({
  type: "auth-ok",
  hostName: offer.hostName,
  vapidPublicKey: KEY,
  pushEnabled: false,
  ...change,
});

class FakeLink implements LinkLike {
  sent: ClientFrame[] = [];
  open = false;
  constructor(private readonly handlers: { onStatus: (s: LinkStatus) => void; onFrame: (f: ServerFrame) => void }) {}
  start() {}
  stop() {
    this.open = false;
  }
  send(frame: ClientFrame) {
    if (!this.open) return false;
    this.sent.push(frame);
    return true;
  }
  retryNow() {}
  up(ok: AuthOkFrame = authOk()) {
    this.open = true;
    this.handlers.onStatus({ state: "connected", authOk: ok });
  }
  down() {
    this.open = false;
    this.handlers.onStatus({ state: "offline", reason: "mac-unreachable", retrying: false });
  }
  frame(frame: ServerFrame) {
    this.handlers.onFrame(frame);
  }
  pushes(): PushSubscribeFrame[] {
    return this.sent.filter((f): f is PushSubscribeFrame => f.type === "push-subscribe");
  }
  ack(frame: PushSubscribeFrame, ok = true) {
    this.frame(
      ok
        ? { type: "ack", clientMsgId: frame.clientMsgId, ok: true }
        : { type: "ack", clientMsgId: frame.clientMsgId, ok: false, reason: "failed", message: "Couldn't save it" }
    );
  }
}

class FakeSubscription implements PushSubscriptionLike {
  readonly options: { applicationServerKey: ArrayBuffer };
  constructor(
    readonly endpoint: string,
    key: Uint8Array<ArrayBuffer>,
    private readonly manager: FakePushManager
  ) {
    this.options = { applicationServerKey: key.slice().buffer };
  }
  toJSON(): PushSubscriptionJSON {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: `p256dh ${this.endpoint}`, auth: "auth" } };
  }
  async unsubscribe() {
    if (this.manager.current === this) this.manager.current = null;
    this.manager.log.push(`unsubscribe ${this.endpoint}`);
    return true;
  }
}

class FakePushManager implements PushManagerLike {
  current: FakeSubscription | null = null;
  made = 0;
  log: string[] = [];
  async getSubscription() {
    return this.current;
  }
  async subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }) {
    this.made += 1;
    this.current = new FakeSubscription(`https://push.example/${this.made}`, options.applicationServerKey, this);
    this.log.push(`subscribe ${this.current.endpoint}`);
    return this.current;
  }
  // A subscription that exists before the app starts.
  existing(key = KEY) {
    this.made += 1;
    this.current = new FakeSubscription(`https://push.example/${this.made}`, keyBytes(key), this);
    return this.current;
  }
}

let storage: MemoryStorage;
let links: FakeLink[];
let manager: FakePushManager;
let permission: NotificationPermission | null;
let answer: NotificationPermission;
let standalone: boolean;
let badges: number[];
let stops: (() => void)[];
// Set to hold the service worker back: `pushManager()` waits for it.
let workerReady: Promise<void> | null;

const env = (): PushEnv => ({
  storage,
  standalone: () => standalone,
  permission: () => permission,
  requestPermission: async () => (permission = answer),
  pushManager: async () => {
    await workerReady;
    return manager;
  },
  setBadge: (count) => void badges.push(count),
  onNotificationClick: () => () => {},
});

function make(): { store: Store; link: () => FakeLink } {
  const store = createStore({
    storage,
    createLink: (_pairing, handlers) => {
      const l = new FakeLink(handlers);
      links.push(l);
      return l;
    },
  });
  stops.push(startPush(store, env(), ORIGIN));
  store.actions.pair(offer);
  return { store, link: () => links[links.length - 1] };
}

// The check's awaits, on promises that are already settled.
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const endpoints = (frames: PushSubscribeFrame[]) => frames.map((f) => f.subscription?.endpoint ?? null);

const instance = (id: string, state: RemoteInstance["state"]): RemoteInstance => ({
  id,
  name: id,
  cwd: `/code/${id}`,
  backend: "claude",
  status: "running",
  state,
});

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  links = [];
  manager = new FakePushManager();
  permission = "default";
  answer = "granted";
  standalone = true;
  badges = [];
  stops = [];
  workerReady = null;
});

afterEach(() => {
  for (const stop of stops) stop();
  vi.useRealTimers();
});

describe("turning notifications on (step 3)", () => {
  it("asks, subscribes with the Mac's key, and sends the subscription; the ack turns the step done", async () => {
    const { store, link } = make();
    link().up();
    await settle();
    // Never asked: the connect leaves it alone.
    expect(link().pushes()).toEqual([]);

    expect(await turnOn(store, env())).toEqual({ ok: true });
    expect(manager.log).toEqual(["subscribe https://push.example/1"]);
    expect(manager.current!.options.applicationServerKey).toEqual(keyBytes(KEY).buffer);
    const [frame] = link().pushes();
    expect(frame.subscription).toEqual({
      endpoint: "https://push.example/1",
      expirationTime: null,
      keys: { p256dh: "p256dh https://push.example/1", auth: "auth" },
    });
    expect(store.getState().push?.enabled).toBe(false);
    link().ack(frame);
    expect(store.getState().push?.enabled).toBe(true);
  });

  it("sends nothing when permission is refused, and says it was denied", async () => {
    const { store, link } = make();
    link().up();
    answer = "denied";
    expect(await turnOn(store, env())).toEqual({ ok: false, denied: true, message: "" });
    expect(manager.made).toBe(0);
    expect(link().pushes()).toEqual([]);
  });

  it("can't without the Mac's key (push unavailable there)", async () => {
    const { store, link } = make();
    link().up(authOk({ vapidPublicKey: "" }));
    expect(await turnOn(store, env())).toMatchObject({ ok: false, denied: false });
    expect(manager.made).toBe(0);
  });

  it("replaces a subscription it already has: the Mac said it holds none", async () => {
    const { store, link } = make();
    manager.existing();
    permission = "granted";
    link().up(authOk({ pushEnabled: true }));
    await settle();
    link().ack(link().pushes()[0]);
    await turnOn(store, env());
    expect(manager.log).toEqual(["unsubscribe https://push.example/1", "subscribe https://push.example/2"]);
  });
});

describe("the check on every connect", () => {
  it("subscribes again when the phone lost its subscription (iOS drops them silently)", async () => {
    permission = "granted";
    const { link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    expect(manager.log).toEqual(["subscribe https://push.example/1"]);
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1"]);
  });

  it("subscribes again with the new key when the Mac's key changed", async () => {
    permission = "granted";
    manager.existing(KEY);
    const { link } = make();
    link().up(authOk({ vapidPublicKey: NEW_KEY, pushEnabled: true }));
    await settle();
    expect(manager.log).toEqual(["unsubscribe https://push.example/1", "subscribe https://push.example/2"]);
    expect(madeFor(manager.current!, NEW_KEY)).toBe(true);
    expect(endpoints(link().pushes())).toEqual(["https://push.example/2"]);
  });

  it("subscribes again when the Mac holds none for this phone (pushEnabled false)", async () => {
    permission = "granted";
    manager.existing();
    const { link } = make();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(manager.log).toEqual(["unsubscribe https://push.example/1", "subscribe https://push.example/2"]);
    expect(endpoints(link().pushes())).toEqual(["https://push.example/2"]);
  });

  it("sends a subscription in order once per launch, and nothing on later connects", async () => {
    permission = "granted";
    manager.existing();
    const { link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    expect(manager.log).toEqual([]);
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1"]);
    link().ack(link().pushes()[0]);

    link().down();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    expect(link().pushes()).toHaveLength(1);
  });

  it("waits for a push-subscribe still on its way, then checks with what its ack says", async () => {
    permission = "granted";
    const { store, link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    // Sent, and the socket dropped before the ack: it goes again on the next connect.
    link().down();
    expect(store.getState().outbox.map((i) => i.status)).toEqual(["waiting"]);
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1", "https://push.example/1"]);
    expect(manager.made).toBe(1);
    link().ack(link().pushes()[1]);
    await settle();
    expect(store.getState().push?.enabled).toBe(true);
    expect(manager.made).toBe(1);
  });

  it("does nothing outside the Home Screen app, or when the Mac has no key", async () => {
    permission = "granted";
    standalone = false;
    const { link } = make();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    standalone = true;
    link().down();
    link().up(authOk({ vapidPublicKey: "", pushEnabled: false }));
    await settle();
    expect(manager.made).toBe(0);
    expect(link().pushes()).toEqual([]);
  });

  it("tells the Mac when notifications were blocked in iOS Settings", async () => {
    permission = "denied";
    const { link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    expect(endpoints(link().pushes())).toEqual([null]);
    expect(manager.made).toBe(0);
  });

  it("sends a push-subscribe the Mac failed to save again, a few times per connection", async () => {
    permission = "granted";
    const { store, link } = make();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    for (let i = 0; i <= RESENDS; i++) {
      const sent = link().pushes();
      link().ack(sent[sent.length - 1], false);
      await vi.advanceTimersByTimeAsync(RESEND_MS);
    }
    const sent = link().pushes();
    expect(sent).toHaveLength(1 + RESENDS);
    expect(new Set(endpoints(sent))).toEqual(new Set(["https://push.example/1"]));
    expect(new Set(sent.map((f) => f.clientMsgId)).size).toBe(sent.length);
    // The last refusal stays for the setup screen to show; the earlier ones went.
    expect(store.getState().outbox.map((i) => i.status)).toEqual(["refused"]);

    // The next connect starts over: a fresh subscription, since the Mac holds none.
    link().down();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(endpoints(link().pushes().slice(sent.length))).toEqual(["https://push.example/2"]);
    expect(store.getState().outbox.map((i) => i.status)).toEqual(["sent"]);
  });
});

describe("turning off and unpairing", () => {
  it("turns off: the Mac first, then the subscription; a later connect doesn't turn them on again", async () => {
    permission = "granted";
    manager.existing();
    const { store, link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    link().ack(link().pushes()[0]);

    await turnOff(store, env());
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1", null]);
    expect(manager.current).toBeNull();
    link().ack(link().pushes()[1]);
    expect(store.getState().push?.enabled).toBe(false);

    link().down();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(link().pushes()).toHaveLength(2);
    expect(manager.made).toBe(1);

    // The Mac still pushing (its null was lost): told again.
    link().down();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1", null, null]);

    // On again from the tap.
    link().ack(link().pushes()[2]);
    await turnOn(store, env());
    expect(endpoints(link().pushes()).at(-1)).toBe("https://push.example/2");
  });

  it("remembers being turned off when storage is full, giving up the offline cache for it", async () => {
    permission = "granted";
    manager.existing();
    const { store, link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    link().ack(link().pushes()[0]);
    link().frame({ type: "instances", instances: Array.from({ length: 20 }, (_, i) => instance(`s${i}`, "idle")) });
    store.flush();
    expect(storage.getItem("multicode.cache")).not.toBeNull();
    storage.quota = storage.used();

    await turnOff(store, env());
    expect(storage.getItem("multicode.push.off")).toBe("1");
    link().ack(link().pushes()[1]);
    link().down();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1", null]);
    expect(manager.made).toBe(1);
  });

  it("stays off for the run when even without the cache there is no room for the flag", async () => {
    permission = "granted";
    manager.existing();
    const { store, link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    link().ack(link().pushes()[0]);
    storage.setItem("multicode.drafts", "x".repeat(1000));
    expect(storage.getItem("multicode.cache")).toBeNull();
    storage.quota = storage.used();

    await turnOff(store, env());
    expect(storage.getItem("multicode.push.off")).toBeNull();
    link().ack(link().pushes()[1]);
    link().down();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1", null]);
    expect(manager.made).toBe(1);
    // Written once there is room.
    storage.removeItem("multicode.drafts");
    link().down();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(storage.getItem("multicode.push.off")).toBe("1");
    expect(manager.made).toBe(1);
  });

  it("runs the check of a new pairing once one left waiting by an unpair has ended", async () => {
    permission = "granted";
    let release = () => {};
    workerReady = new Promise((resolve) => (release = resolve));
    const { store, link } = make();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    store.actions.unpair();
    store.actions.pair(offer);
    link().up(authOk({ pushEnabled: false }));
    await settle();
    expect(link().pushes()).toEqual([]);
    release();
    await settle();
    await settle();
    expect(endpoints(link().pushes())).toEqual(["https://push.example/1"]);
  });

  it("unpairing tells the Mac on the open link and drops the subscription", async () => {
    permission = "granted";
    manager.existing();
    const { store, link } = make();
    link().up(authOk({ pushEnabled: true }));
    await settle();
    link().ack(link().pushes()[0]);
    const before = link();

    await unpair(store, env());
    expect(endpoints(before.pushes())).toEqual(["https://push.example/1", null]);
    expect(store.getState().pairing).toBeNull();
    expect(manager.current).toBeNull();
  });

  it("clears the badge when unpaired, whatever this run last wrote", async () => {
    const { store, link } = make();
    link().up();
    link().frame({ type: "instances", instances: [instance("a", "idle")] });
    // Offline, after a push set the badge while the app was away.
    link().down();
    await unpair(store, env());
    expect(badges).toEqual([0, 0]);
  });

  it("drops a check still waiting when the phone is unpaired: nothing is queued for the next pairing", async () => {
    permission = "granted";
    let release = () => {};
    workerReady = new Promise((resolve) => (release = resolve));
    const { store, link } = make();
    link().up(authOk({ pushEnabled: false }));
    await settle();
    const unpairing = unpair(store, env());
    release();
    await unpairing;
    await settle();
    expect(link().pushes()).toEqual([]);
    expect(store.getState().outbox).toEqual([]);
    expect(storage.getItem("multicode.outbox")).toBeNull();
  });
});

describe("the badge", () => {
  it("follows the live list's Needs you count, and clears at 0", async () => {
    const { link } = make();
    const list = (states: RemoteInstance["state"][]) =>
      link().frame({ type: "instances", instances: states.map((s, i) => instance(`s${i}`, s)) });
    link().up();
    list(["needs-you", "working", "needs-you"]);
    list(["needs-you", "working", "needs-you", "idle"]);
    list(["needs-you", "finished"]);
    list(["idle"]);
    expect(badges).toEqual([2, 1, 0]);
  });

  it("never sets it from the cached list, which may be older than the last push", async () => {
    const first = make();
    first.link().up();
    first.link().frame({ type: "instances", instances: [instance("a", "needs-you")] });
    first.store.flush();
    badges = [];

    const again = createStore({
      storage,
      createLink: (_pairing, handlers) => {
        const l = new FakeLink(handlers);
        links.push(l);
        return l;
      },
    });
    stops.push(startPush(again, env(), ORIGIN));
    expect(again.getState().instances).toHaveLength(1);
    again.start();
    const link = links[links.length - 1];
    link.up();
    // auth-ok comes before the Mac's list: the cached one is still on screen.
    expect(badges).toEqual([]);
    link.frame({ type: "instances", instances: [] });
    expect(badges).toEqual([0]);
  });

  it("writes it again on every connection: a push may have changed it while the app was away", async () => {
    const { link } = make();
    link().up();
    link().frame({ type: "instances", instances: [] });
    link().down();
    // A push set the badge to 1 meanwhile; the session was answered at the desk.
    link().up();
    link().frame({ type: "instances", instances: [] });
    expect(badges).toEqual([0, 0]);
  });
});

describe("routeOf", () => {
  it("opens this app's routes only", () => {
    expect(routeOf(`${ORIGIN}/#/s/multi%20code%2F1`, ORIGIN)).toEqual({ screen: "session", id: "multi code/1" });
    expect(routeOf(`${ORIGIN}/#/`, ORIGIN)).toEqual({ screen: "list" });
    expect(routeOf("https://evil.example/#/s/a", ORIGIN)).toBeNull();
  });
});
