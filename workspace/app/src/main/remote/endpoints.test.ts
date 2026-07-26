import { afterEach, describe, expect, it, vi } from "vitest";
import os from "os";
import {
  buildEndpointUrls,
  buildEndpoints,
  hasTailscaleEndpoint,
  listEndpointCandidates,
} from "./endpoints";

type Nics = ReturnType<typeof os.networkInterfaces>;

function mockNics(nics: Nics) {
  vi.spyOn(os, "networkInterfaces").mockReturnValue(nics);
}

const v4 = (address: string, internal = false) => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4" as const,
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listEndpointCandidates", () => {
  it("puts Tailscale addresses ahead of LAN ones", () => {
    // Order is what the phone races through, and Tailscale is the only path that
    // still works away from home, so it has to come first.
    mockNics({
      en0: [v4("192.168.1.20")],
      utun3: [v4("100.101.102.103")],
    });

    const candidates = listEndpointCandidates();
    expect(candidates[0]).toEqual({ host: "100.101.102.103", kind: "tailscale" });
    expect(candidates[1]).toEqual({ host: "192.168.1.20", kind: "lan" });
  });

  it("classifies a corporate VPN tunnel as vpn and ranks it last", () => {
    // A GlobalProtect address looks like an ordinary private address but a
    // personal phone is never on that network, so racing it first would stall
    // the connection on a dead candidate.
    mockNics({
      utun5: [v4("10.128.4.37")],
      en0: [v4("192.168.0.114")],
    });

    expect(listEndpointCandidates()).toEqual([
      { host: "192.168.0.114", kind: "lan" },
      { host: "10.128.4.37", kind: "vpn" },
    ]);
  });

  it("still calls a Tailscale address on utun 'tailscale', not 'vpn'", () => {
    // Tailscale rides a utun interface too, so the CGNAT check has to win.
    mockNics({ utun4: [v4("100.90.80.70")] });
    expect(listEndpointCandidates()).toEqual([
      { host: "100.90.80.70", kind: "tailscale" },
    ]);
  });

  it("orders all three classes tailscale -> lan -> vpn", () => {
    mockNics({
      utun5: [v4("10.128.4.37")],
      en0: [v4("192.168.0.114")],
      utun3: [v4("100.101.102.103")],
    });
    expect(listEndpointCandidates().map((c) => c.kind)).toEqual([
      "tailscale",
      "lan",
      "vpn",
    ]);
  });

  it("skips loopback and internal interfaces", () => {
    mockNics({
      lo0: [v4("127.0.0.1", true)],
      en0: [v4("10.0.0.5")],
    });
    expect(listEndpointCandidates()).toEqual([
      { host: "10.0.0.5", kind: "lan" },
    ]);
  });

  it("skips IPv6 addresses", () => {
    mockNics({
      en0: [
        {
          address: "fe80::1",
          netmask: "ffff::",
          family: "IPv6" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 1,
        },
        v4("192.168.0.9"),
      ],
    });
    expect(listEndpointCandidates()).toEqual([
      { host: "192.168.0.9", kind: "lan" },
    ]);
  });

  it("classifies the whole 100.64/10 CGNAT range as Tailscale", () => {
    mockNics({
      a: [v4("100.64.0.1")],
      b: [v4("100.127.255.254")],
    });
    expect(listEndpointCandidates().every((c) => c.kind === "tailscale")).toBe(
      true
    );
  });

  it("does not mistake neighbouring 100.x addresses for Tailscale", () => {
    // 100.63 and 100.128 sit just outside the CGNAT block and are ordinary
    // public addresses; calling them Tailscale would promise off-LAN reach that
    // doesn't exist.
    mockNics({
      a: [v4("100.63.0.1")],
      b: [v4("100.128.0.1")],
    });
    expect(listEndpointCandidates().every((c) => c.kind === "lan")).toBe(true);
  });

  it("skips 169.254 link-local addresses", () => {
    // A self-assigned address appears when DHCP fails and is never reachable
    // from a phone; offering it only slows down the client's endpoint race.
    mockNics({
      en0: [v4("169.254.206.49")],
      en1: [v4("192.168.0.114")],
    });
    expect(listEndpointCandidates()).toEqual([
      { host: "192.168.0.114", kind: "lan" },
    ]);
  });

  it("returns nothing when there is no usable interface", () => {
    mockNics({ lo0: [v4("127.0.0.1", true)] });
    expect(listEndpointCandidates()).toEqual([]);
    expect(hasTailscaleEndpoint()).toBe(false);
  });
});

describe("buildEndpointUrls", () => {
  it("formats candidates as ws URLs on the given port", () => {
    mockNics({ en0: [v4("192.168.1.20")], utun3: [v4("100.90.80.70")] });
    expect(buildEndpointUrls(6768)).toEqual([
      "ws://100.90.80.70:6768",
      "ws://192.168.1.20:6768",
    ]);
  });
});

describe("buildEndpoints", () => {
  it("carries the reachability class alongside each URL", () => {
    // The desktop UI needs the kind to explain why an address won't work from
    // outside; the renderer can't derive it from the IP alone.
    mockNics({
      en0: [v4("192.168.0.114")],
      utun5: [v4("10.128.4.37")],
      utun3: [v4("100.90.80.70")],
    });
    expect(buildEndpoints(6768)).toEqual([
      { url: "ws://100.90.80.70:6768", kind: "tailscale" },
      { url: "ws://192.168.0.114:6768", kind: "lan" },
      { url: "ws://10.128.4.37:6768", kind: "vpn" },
    ]);
  });
});
