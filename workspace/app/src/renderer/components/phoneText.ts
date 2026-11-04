// The Phone section's words for its three checks and its paired phones, kept out of
// the component like secretaryText.ts so the wording lives in one place and is
// unit-testable. The fixes (buttons, links) are the component's.

import type { PairedDevice, RemoteChecks, RemoteStatus } from "../../shared/remote-protocol";

export type CheckKey = keyof RemoteChecks;

// "unknown": not known yet, or waiting on an earlier check (HTTPS while Tailscale is
// stopped). It blocks pairing like "bad".
export type CheckTone = "ok" | "bad" | "unknown";

export interface CheckRow {
  key: CheckKey;
  label: string;
  tone: CheckTone;
  // What was found: an address or state when ok (shown monospace), else a sentence
  // saying what it means.
  text: string;
}

export const CHECK_LABELS: Record<CheckKey, string> = {
  tailscale: "Tailscale",
  https: "HTTPS",
  push: "Push",
};

function tailscaleRow(check: RemoteChecks["tailscale"]): CheckRow {
  const row = { key: "tailscale", label: CHECK_LABELS.tailscale } as const;
  switch (check.state) {
    case "running":
      return { ...row, tone: "ok", text: `running · ${check.ip ?? check.dnsName}` };
    case "stopped":
      return {
        ...row,
        tone: "bad",
        text: `Stopped${check.detail ? `: ${check.detail}` : "."} Your phone can't reach this Mac.`,
      };
    case "missing":
      return { ...row, tone: "bad", text: "Not installed. Your phone reaches this Mac through Tailscale." };
    default:
      return { ...row, tone: "unknown", text: check.detail ?? "Not checked yet." };
  }
}

function httpsRow(check: RemoteChecks["https"]): CheckRow {
  const row = { key: "https", label: CHECK_LABELS.https } as const;
  switch (check.state) {
    case "ready":
      return { ...row, tone: "ok", text: check.origin };
    case "certs-off":
      return {
        ...row,
        tone: "bad",
        text: "HTTPS Certificates are off for your tailnet. Turn them on in the admin console's DNS page, then check again.",
      };
    case "serve-missing":
      return { ...row, tone: "bad", text: "Not set up: nothing serves Multi-Code on this Mac's HTTPS address yet." };
    case "serve-conflict":
      return { ...row, tone: "bad", text: check.detail };
    default:
      return { ...row, tone: "unknown", text: check.detail ?? "Not checked yet." };
  }
}

function pushRow(check: RemoteChecks["push"]): CheckRow {
  const row = { key: "push", label: CHECK_LABELS.push } as const;
  if (check.state === "ready") {
    return { ...row, tone: "ok", text: "keys ready · every Finished and Needs you" };
  }
  return {
    ...row,
    tone: "bad",
    text: `${sentence(check.detail || "The push keys couldn't be loaded")} Phones get no notifications until it works; check that Multi-Code's data folder is writable, then check again.`,
  };
}

// An error from main as a sentence, so the advice after it doesn't run on.
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

// In the order they depend on each other, which is the order to fix them in.
export function checkRows(checks: RemoteChecks): CheckRow[] {
  return [tailscaleRow(checks.tailscale), httpsRow(checks.https), pushRow(checks.push)];
}

// The check to fix before a phone can be paired, or null when all three pass. The
// first that doesn't pass, in order: HTTPS waits on Tailscale, so Tailscale stopped
// comes before the HTTPS it leaves unknown.
export function firstToFix(rows: CheckRow[]): CheckRow | null {
  return rows.find((r) => r.tone !== "ok") ?? null;
}

// The origin a pairing code is made for: the HTTPS origin while the link is on and all
// three checks pass. Null: no code is shown.
export function pairingOrigin(status: RemoteStatus | null): string | null {
  if (!status?.enabled || status.checks.https.state !== "ready") return null;
  return firstToFix(checkRows(status.checks)) === null ? status.checks.https.origin : null;
}

// Whether a code's link (`<origin>/#pair=…`) is for `origin`. One made for an address
// the Mac no longer has would pair a phone with nothing.
export function pairingIsFor(webUrl: string, origin: string | null): boolean {
  return origin !== null && webUrl.startsWith(`${origin}/`);
}

// "connected", "seen 5 min ago" or "never connected", then whether push is on.
export function deviceLine(device: PairedDevice, now: number): string {
  const seen = device.connected
    ? "connected"
    : device.lastSeenAt
      ? `seen ${ago(now - device.lastSeenAt)}`
      : "never connected";
  return `${seen} · push ${device.pushEnabled ? "on" : "off"}`;
}

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
