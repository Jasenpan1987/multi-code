// Figures out which addresses a phone can use to reach this desktop.
//
// Ordering matters: the pairing QR carries the list best-first and the phone
// keeps the first endpoint that answers. Tailscale addresses come first because
// they keep working after the phone leaves the house, which is the whole point
// of the feature — a plain 192.168.x address only works while both are home.

import os from "os";
import type { EndpointKind, RemoteEndpoint } from "../../shared/remote-protocol";

// Tailscale hands out addresses from the 100.64.0.0/10 CGNAT range. Matching the
// range (rather than shelling out to the `tailscale` binary) means we detect it
// without depending on the CLI being installed or on PATH.
function isTailscaleV4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (first !== 100) return false;
  return second >= 64 && second <= 127;
}

// 169.254.0.0/16 is what an interface self-assigns when DHCP fails. It's never
// routable to a phone, so including it would just waste a slot in the client's
// connection race and slow down the real endpoint.
function isLinkLocalV4(address: string): boolean {
  return address.startsWith("169.254.");
}

// Corporate VPN tunnels (GlobalProtect, Cisco AnyConnect, …) also show up as
// non-internal interfaces with private addresses. They look reachable but are
// not: the address only means anything inside that corporate network, which a
// personal phone will never be on. Keeping them ahead of the real LAN address
// would just stall the phone's connection race on a dead candidate, so they go
// last. Detected by interface name, since the address ranges are ordinary
// RFC1918 ones indistinguishable from a home LAN.
const VPN_INTERFACE = /^(utun|ipsec|ppp|gpd|tun|tap)/i;

export interface EndpointCandidate {
  host: string;
  kind: EndpointKind;
}

// All non-loopback IPv4 addresses on this machine, best-first: Tailscale (works
// anywhere), then LAN (works at home), then VPN tunnels (never from a phone).
// IPv6 is skipped deliberately: link-local addresses need a scope id that
// doesn't survive a QR round-trip, and every practical path here (home LAN,
// Tailscale) offers a v4 address.
export function listEndpointCandidates(): EndpointCandidate[] {
  const tailscale: EndpointCandidate[] = [];
  const lan: EndpointCandidate[] = [];
  const vpn: EndpointCandidate[] = [];

  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;
    for (const address of addresses) {
      if (address.family !== "IPv4") continue;
      if (address.internal) continue;
      if (isLinkLocalV4(address.address)) continue;
      if (isTailscaleV4(address.address)) {
        // Tailscale rides a utun interface too, so this check must come before
        // the VPN one.
        tailscale.push({ host: address.address, kind: "tailscale" });
      } else if (VPN_INTERFACE.test(name)) {
        vpn.push({ host: address.address, kind: "vpn" });
      } else {
        lan.push({ host: address.address, kind: "lan" });
      }
    }
  }

  return [...tailscale, ...lan, ...vpn];
}

// URLs only, in priority order — this is what goes into the pairing offer for
// the phone to race.
export function buildEndpointUrls(port: number): string[] {
  return listEndpointCandidates().map((c) => `ws://${c.host}:${port}`);
}

// URLs plus their reachability class, for the desktop UI.
export function buildEndpoints(port: number): RemoteEndpoint[] {
  return listEndpointCandidates().map((c) => ({
    url: `ws://${c.host}:${port}`,
    kind: c.kind,
  }));
}

// Shown in the desktop UI so the user can tell whether the off-LAN path is
// actually available before they walk out the door.
export function hasTailscaleEndpoint(): boolean {
  return listEndpointCandidates().some((c) => c.kind === "tailscale");
}
