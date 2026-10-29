// RemoteServer's side of HTTPS through `tailscale serve` (mobile-v2 T-805): it listens
// on 127.0.0.1 only, makes no pairing offer until HTTPS is ready, and its status
// carries the checks. The checker is a stub; tailscale.test.ts covers the real one.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-remote-https-"));

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    getName: () => "Multi-Code",
  },
}));

const { RemoteServer } = await import("./ws-server");
type RemoteChecker = import("./tailscale").RemoteChecker;
type TailnetChecks = import("./tailscale").TailnetChecks;

const DNS = "mac.example.ts.net";
const READY: TailnetChecks = {
  tailscale: { state: "running", dnsName: DNS, ip: "100.64.0.7" },
  https: { state: "ready", origin: `https://${DNS}` },
};

// Answers each check with `stub.checks` and records every call.
function stubChecker(checks: TailnetChecks) {
  const stub = {
    checks,
    checkCalls: [] as number[],
    setupCalls: [] as number[],
    setupResult: { checks: READY } as Awaited<ReturnType<RemoteChecker["setUpHttps"]>>,
    checker: {
      check: async (port: number) => {
        stub.checkCalls.push(port);
        return stub.checks;
      },
      setUpHttps: async (port: number) => {
        stub.setupCalls.push(port);
        return stub.setupResult;
      },
    } as RemoteChecker,
  };
  return stub;
}

const servers: Array<InstanceType<typeof RemoteServer>> = [];

async function startWith(checker?: RemoteChecker) {
  const server = new RemoteServer();
  servers.push(server);
  let pushes = 0;
  server.setStatusListener(() => pushes++);
  if (checker) server.setChecker(checker);
  const status = await server.start(0);
  if (!status.port) throw new Error(status.error ?? "server did not start");
  return { server, port: status.port, pushes: () => pushes };
}

afterEach(async () => {
  vi.useRealTimers();
  while (servers.length) await servers.pop()?.stop();
  fs.rmSync(path.join(userData, "remote-devices.json"), { force: true });
});

function nonLoopbackIPv4(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    // A connect to one of this machine's own addresses takes a millisecond; a VPN tunnel's
    // address can drop the refusal instead of sending it, so give up after 500 ms.
    const timer = setTimeout(() => done(false), 500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

describe("RemoteServer binding", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { server, port } = await startWith(stubChecker(READY).checker);
    const address = (server as any).httpServer.address() as net.AddressInfo;
    expect(address.address).toBe("127.0.0.1");

    const res = await fetch(`http://127.0.0.1:${port}/definitely-not-here.js`);
    expect(res.status).toBe(404);
    // Every other address of this machine refuses: the tailnet gets in only through
    // `tailscale serve`, which dials 127.0.0.1.
    for (const address of nonLoopbackIPv4()) {
      expect(await connects(address, port), address).toBe(false);
    }
  });
});

describe("RemoteServer pairing offer", () => {
  it("is refused unless HTTPS is ready, and writes no device then", async () => {
    const notReady: TailnetChecks["https"][] = [
      { state: "unknown", detail: "Needs Tailscale running." },
      { state: "certs-off", adminUrl: "https://login.tailscale.com/admin/dns" },
      { state: "serve-missing", command: "tailscale serve --bg --https=443 http://127.0.0.1:6768" },
      { state: "serve-conflict", detail: "Port 443 proxies to http://127.0.0.1:3000." },
    ];
    for (const https of notReady) {
      const { server } = await startWith(stubChecker({ tailscale: READY.tailscale, https }).checker);
      expect(server.createPairingOffer(), https.state).toBeNull();
      expect(server.getStatus().devices).toEqual([]);
      await server.stop();
    }
  });

  it("is refused by a server with no checker (nothing known)", async () => {
    const { server } = await startWith();
    expect(server.getStatus().checks.https.state).toBe("unknown");
    expect(server.createPairingOffer()).toBeNull();
  });

  it("carries the HTTPS origin once ready", async () => {
    const { server } = await startWith(stubChecker(READY).checker);
    const offer = server.createPairingOffer();
    expect(offer?.origin).toBe(`https://${DNS}`);
    expect(offer?.v).toBe(3);
    expect(server.getStatus().devices).toHaveLength(1);
  });

  it("is refused after a restart until the new listener's check lands", async () => {
    let answer: TailnetChecks = READY;
    let release: () => void = () => undefined;
    let hold = false;
    const server = new RemoteServer();
    servers.push(server);
    server.setChecker({
      check: () =>
        hold ? new Promise((resolve) => (release = () => resolve(answer))) : Promise.resolve(answer),
      setUpHttps: async () => ({ checks: answer }),
    });
    await server.start(0);
    expect(server.createPairingOffer()).not.toBeNull();
    await server.stop();
    expect(server.getStatus().checks.https.state).toBe("unknown");

    // Restarted while the serve config changed: until the new check lands there is
    // no offer, and no device row is written.
    hold = true;
    answer = { tailscale: READY.tailscale, https: { state: "serve-conflict", detail: "Port 443 proxies elsewhere." } };
    const restarted = server.start(0);
    await vi.waitFor(() => expect(server.isRunning()).toBe(true));
    const devicesBefore = server.getStatus().devices.length;
    expect(server.createPairingOffer()).toBeNull();
    expect(server.getStatus().devices).toHaveLength(devicesBefore);
    release();
    await restarted;
    expect(server.getStatus().checks.https.state).toBe("serve-conflict");
    expect(server.createPairingOffer()).toBeNull();
  });

  it("is refused after the server stops", async () => {
    const { server } = await startWith(stubChecker(READY).checker);
    await server.stop();
    expect(server.createPairingOffer()).toBeNull();
  });
});

describe("RemoteServer status checks", () => {
  it("are checked before start returns, for the bound port", async () => {
    const stub = stubChecker(READY);
    const { server, port, pushes } = await startWith(stub.checker);
    expect(stub.checkCalls).toEqual([port]);
    const status = server.getStatus();
    expect(status.checks.tailscale).toEqual(READY.tailscale);
    expect(status.checks.https).toEqual(READY.https);
    expect(status.checks.push).toEqual({ state: "ready" });
    expect(pushes()).toBeGreaterThan(0);
  });

  it("say push is ready once its keys load, and why not when they can't be kept", async () => {
    const keys = path.join(userData, "remote-push.json");
    fs.rmSync(keys, { force: true });
    // A folder where the file goes: it can be neither read nor written.
    fs.mkdirSync(keys);
    try {
      const { server } = await startWith(stubChecker(READY).checker);
      expect(server.getStatus().checks.push).toEqual({
        state: "error",
        detail: expect.stringMatching(/^Couldn't save the push keys: /),
      });
    } finally {
      fs.rmSync(keys, { recursive: true, force: true });
    }
    const { server } = await startWith(stubChecker(READY).checker);
    expect(server.getStatus().checks.push).toEqual({ state: "ready" });
  });

  it("refresh on status requests at most every 5 s, and a change is pushed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stub = stubChecker(READY);
    const { server, port, pushes } = await startWith(stub.checker);

    // Within 5 s of the last check: the cached status, no new check.
    expect(server.requestStatus().checks.https.state).toBe("ready");
    expect(stub.checkCalls).toHaveLength(1);

    vi.setSystemTime(Date.now() + 6_000);
    stub.checks = { ...READY, https: { state: "serve-missing", command: `tailscale serve --bg --https=443 http://127.0.0.1:${port}` } };
    const before = pushes();
    // The answer is still the cached one; the refresh lands behind it.
    expect(server.requestStatus().checks.https.state).toBe("ready");
    expect(stub.checkCalls).toHaveLength(2);
    await vi.waitFor(() => expect(server.getStatus().checks.https.state).toBe("serve-missing"));
    expect(pushes()).toBe(before + 1);
    expect(server.createPairingOffer()).toBeNull();
  });

  it("makes no checks once stopped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stub = stubChecker(READY);
    const { server } = await startWith(stub.checker);
    await server.stop();
    vi.setSystemTime(Date.now() + 60_000);
    server.requestStatus();
    expect(stub.checkCalls).toHaveLength(1);
  });
});

describe("RemoteServer.setUpHttps", () => {
  it("runs the checker's setup for the bound port and returns the status after it", async () => {
    const stub = stubChecker({
      tailscale: READY.tailscale,
      https: { state: "serve-missing", command: "tailscale serve --bg --https=443 http://127.0.0.1:1" },
    });
    const { server, port } = await startWith(stub.checker);
    expect(server.createPairingOffer()).toBeNull();

    stub.setupResult = { checks: READY };
    const result = await server.setUpHttps();
    expect(stub.setupCalls).toEqual([port]);
    expect(result.error).toBeUndefined();
    expect(result.status.checks.https).toEqual(READY.https);
    expect(server.createPairingOffer()?.origin).toBe(`https://${DNS}`);
  });

  it("passes on why nothing was changed", async () => {
    const conflict: TailnetChecks = {
      tailscale: READY.tailscale,
      https: { state: "serve-conflict", detail: "Port 443 proxies to http://127.0.0.1:3000." },
    };
    const stub = stubChecker(conflict);
    stub.setupResult = { checks: conflict, error: "Nothing was changed: port 443 already serves something else." };
    const { server } = await startWith(stub.checker);
    const result = await server.setUpHttps();
    expect(result.error).toBe("Nothing was changed: port 443 already serves something else.");
    expect(result.status.checks.https.state).toBe("serve-conflict");
  });

  it("runs nothing while the server is off", async () => {
    const stub = stubChecker(READY);
    const server = new RemoteServer();
    servers.push(server);
    server.setChecker(stub.checker);
    const result = await server.setUpHttps();
    expect(result.error).toBe("Turn the phone link on first.");
    expect(stub.setupCalls).toEqual([]);
  });
});
