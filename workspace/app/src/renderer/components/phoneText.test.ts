import { describe, expect, it } from "vitest";
import type { PairedDevice, RemoteChecks, RemoteStatus } from "../../shared/remote-protocol";
import { checkRows, deviceLine, firstToFix, pairingIsFor, pairingOrigin } from "./phoneText";

const READY: RemoteChecks = {
  tailscale: { state: "running", dnsName: "mac.example.ts.net", ip: "100.64.0.7" },
  https: { state: "ready", origin: "https://mac.example.ts.net" },
  push: { state: "ready" },
};

const tones = (checks: RemoteChecks) => checkRows(checks).map((r) => r.tone);

describe("checkRows", () => {
  it("passes all three when ready, saying what was found", () => {
    const rows = checkRows(READY);
    expect(rows.map((r) => r.tone)).toEqual(["ok", "ok", "ok"]);
    expect(rows.map((r) => r.text)).toEqual([
      "running · 100.64.0.7",
      "https://mac.example.ts.net",
      "keys ready · every Finished and Needs you",
    ]);
    expect(firstToFix(rows)).toBeNull();
  });

  it("says what a stopped Tailscale means, with Tailscale's own reason", () => {
    const [plain] = checkRows({ ...READY, tailscale: { state: "stopped" } });
    expect(plain.text).toBe("Stopped. Your phone can't reach this Mac.");
    const [login] = checkRows({
      ...READY,
      tailscale: { state: "stopped", detail: "Tailscale needs you to log in." },
    });
    expect(login.text).toBe("Stopped: Tailscale needs you to log in. Your phone can't reach this Mac.");
  });

  it("fails each HTTPS state but ready, and leaves a conflict's detail as it is", () => {
    expect(tones({ ...READY, https: { state: "certs-off", adminUrl: "https://x" } })[1]).toBe("bad");
    expect(tones({ ...READY, https: { state: "serve-missing", command: "tailscale serve" } })[1]).toBe("bad");
    const conflict = checkRows({ ...READY, https: { state: "serve-conflict", detail: "Port 443 serves files." } })[1];
    expect(conflict).toMatchObject({ tone: "bad", text: "Port 443 serves files." });
    expect(tones({ ...READY, https: { state: "unknown" } })[1]).toBe("unknown");
  });

  it("fails push with the keys' error", () => {
    const push = checkRows({ ...READY, push: { state: "error", detail: "Couldn't save the push keys: EACCES." } })[2];
    expect(push.tone).toBe("bad");
    expect(push.text).toMatch(/^Couldn't save the push keys: EACCES\. Phones get no notifications/);
  });

  it("ends the keys' error as a sentence before the advice", () => {
    const push = checkRows({ ...READY, push: { state: "error", detail: "Couldn't save the push keys: EISDIR, open 'x'" } })[2];
    expect(push.text).toMatch(/^Couldn't save the push keys: EISDIR, open 'x'\. Phones get/);
  });
});

describe("firstToFix", () => {
  it("is Tailscale while it is stopped, not the HTTPS it leaves unknown", () => {
    const rows = checkRows({
      tailscale: { state: "stopped" },
      https: { state: "unknown", detail: "Needs Tailscale running." },
      push: { state: "error", detail: "no keys" },
    });
    expect(firstToFix(rows)?.key).toBe("tailscale");
  });

  it("is the first check that doesn't pass", () => {
    expect(firstToFix(checkRows({ ...READY, https: { state: "certs-off", adminUrl: "https://x" } }))?.key).toBe("https");
    expect(firstToFix(checkRows({ ...READY, push: { state: "error", detail: "no keys" } }))?.key).toBe("push");
  });
});

describe("deviceLine", () => {
  const NOW = 10 * 24 * 3_600_000;
  const device = (over: Partial<PairedDevice>): PairedDevice => ({
    id: "d",
    name: "iPhone",
    pairedAt: 0,
    lastSeenAt: 0,
    connected: false,
    pushEnabled: false,
    ...over,
  });

  it("says connected, never connected, or when it was last seen, and whether push is on", () => {
    expect(deviceLine(device({ connected: true, pushEnabled: true }), NOW)).toBe("connected · push on");
    expect(deviceLine(device({}), NOW)).toBe("never connected · push off");
    expect(deviceLine(device({ lastSeenAt: NOW - 20_000 }), NOW)).toBe("seen just now · push off");
    expect(deviceLine(device({ lastSeenAt: NOW - 2 * 60_000 }), NOW)).toBe("seen 2 min ago · push off");
    expect(deviceLine(device({ lastSeenAt: NOW - 3 * 3_600_000 }), NOW)).toBe("seen 3 h ago · push off");
    expect(deviceLine(device({ lastSeenAt: NOW - 2 * 24 * 3_600_000 }), NOW)).toBe("seen 2 d ago · push off");
  });
});

describe("pairing codes", () => {
  const status = (checks: RemoteChecks, enabled = true): RemoteStatus => ({
    enabled,
    port: 6768,
    checks,
    devices: [],
  });

  it("are made for the HTTPS origin only while the link is on and every check passes", () => {
    expect(pairingOrigin(status(READY))).toBe("https://mac.example.ts.net");
    expect(pairingOrigin(status(READY, false))).toBeNull();
    expect(pairingOrigin(null)).toBeNull();
    expect(pairingOrigin(status({ ...READY, push: { state: "error", detail: "no keys" } }))).toBeNull();
    expect(
      pairingOrigin(status({ ...READY, https: { state: "serve-missing", command: "tailscale serve" } }))
    ).toBeNull();
  });

  it("are shown only for the origin they were made for", () => {
    const url = "https://mac.example.ts.net/#pair=abc";
    expect(pairingIsFor(url, "https://mac.example.ts.net")).toBe(true);
    // The Mac's tailnet name changed while the code was up: both origins are ready.
    expect(pairingIsFor(url, "https://renamed.example.ts.net")).toBe(false);
    expect(pairingIsFor(url, "https://mac.example.ts.ne")).toBe(false);
    expect(pairingIsFor(url, null)).toBe(false);
  });
});
