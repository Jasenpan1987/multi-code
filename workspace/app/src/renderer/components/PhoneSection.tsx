// Toolbox section for the phone link: switch the server on, show a pairing QR,
// and manage paired devices.
//
// Unlike the other toolbox sections this is app-wide, not per-instance — one
// server serves every instance — but it lives here because that's where the
// project puts everything that isn't the terminal.

import { useCallback, useEffect, useState } from "react";
import type { RemotePairing } from "../../shared/types";
import type { RemoteChecks, RemoteStatus } from "../../shared/remote-protocol";

// mobile-v2 T-812: the checks shown plainly, one line each; T-812 replaces this with
// the mockup's rows.
function describeTailscale(check: RemoteChecks["tailscale"]): string {
  if (check.state === "running") return `running · ${check.ip ?? check.dnsName}`;
  return check.detail ? `${check.state} · ${check.detail}` : check.state;
}

function describeHttps(check: RemoteChecks["https"]): string {
  switch (check.state) {
    case "ready":
      return check.origin;
    case "certs-off":
      return "certificates are off for this tailnet";
    case "serve-missing":
      return "tailscale serve isn't set up";
    case "serve-conflict":
      return `conflict · ${check.detail}`;
    default:
      return check.detail ? `unknown · ${check.detail}` : "unknown";
  }
}

interface PhoneSectionProps {
  active: boolean;
}

export function PhoneSection({ active }: PhoneSectionProps) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [busy, setBusy] = useState(false);
  // Why "Set up HTTPS" or "Open Tailscale" didn't work.
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.electronAPI.getRemoteStatus().then(setStatus);
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
  }, [active, refresh]);

  // Live status pushes (device connected / disconnected) so the list is honest
  // without the user reopening the section.
  useEffect(() => {
    const cleanup = window.electronAPI.onRemoteStatus((next) => {
      setStatus(next);
    });
    return cleanup;
  }, []);

  if (!active) return null;

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    try {
      const next = await window.electronAPI.setRemoteEnabled(!status.enabled);
      setStatus(next);
      // A stale QR points at a closed port, so drop it when turning off.
      if (!next.enabled) setPairing(null);
    } finally {
      setBusy(false);
    }
  };

  const pairNew = async () => {
    setBusy(true);
    try {
      setPairing(await window.electronAPI.createRemotePairing());
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (deviceId: string) => {
    setStatus(await window.electronAPI.revokeRemoteDevice(deviceId));
  };

  const setUpHttps = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await window.electronAPI.setUpRemoteHttps();
      setStatus(result.status);
      setActionError(result.error ?? null);
    } finally {
      setBusy(false);
    }
  };

  const openTailscale = async () => {
    setActionError(null);
    const result = await window.electronAPI.openTailscale();
    if (!result.ok) setActionError(`Couldn't open Tailscale: ${result.error ?? "unknown error"}`);
  };

  const openLink = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void window.electronAPI.openExternal(e.currentTarget.href);
  };

  const checks = status?.checks;
  const httpsReady = checks?.https.state === "ready";

  return (
    <div className="phone-section">
      <div className="phone-row">
        <button
          className="phone-toggle"
          onClick={toggle}
          disabled={busy || !status}
          data-on={status?.enabled ? "true" : "false"}
        >
          {status?.enabled ? "Phone link: ON" : "Phone link: OFF"}
        </button>
        {status?.port ? (
          <span className="phone-port">port {status.port}</span>
        ) : null}
      </div>

      {status?.error ? <div className="phone-error">{status.error}</div> : null}

      {status?.enabled ? (
        <>
          {checks ? (
            <div className={httpsReady ? "phone-ok" : "phone-warn"}>
              <div>
                Tailscale: {describeTailscale(checks.tailscale)}{" "}
                {checks.tailscale.state === "missing" ? (
                  <a href="https://tailscale.com/download/mac" onClick={openLink}>
                    Get Tailscale
                  </a>
                ) : checks.tailscale.state !== "running" ? (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void openTailscale();
                    }}
                  >
                    Open Tailscale
                  </a>
                ) : null}
              </div>
              <div>
                HTTPS: {describeHttps(checks.https)}{" "}
                {checks.https.state === "certs-off" ? (
                  <a href={checks.https.adminUrl} onClick={openLink}>
                    Open the admin console
                  </a>
                ) : null}
              </div>
              {checks.https.state === "serve-missing" ? (
                <div>
                  <code className="phone-url">{checks.https.command}</code>
                  <button className="phone-btn" onClick={setUpHttps} disabled={busy}>
                    Set up HTTPS
                  </button>
                </div>
              ) : null}
              <div>
                Push: {checks.push.state === "ready" ? "ready" : `error · ${checks.push.detail}`}
              </div>
            </div>
          ) : null}
          {actionError ? <div className="phone-error">{actionError}</div> : null}

          <button className="phone-btn" onClick={pairNew} disabled={busy || !httpsReady}>
            {pairing ? "New pairing code" : "Pair a phone"}
          </button>

          {pairing ? (
            <div className="phone-pairing">
              {pairing.qrDataUrl ? (
                <img
                  className="phone-qr"
                  src={pairing.qrDataUrl}
                  alt="Pairing QR code"
                  width={240}
                  height={240}
                />
              ) : null}
              <div className="phone-hint">
                Scan with your phone camera, then add the page to your home
                screen. This code contains a device secret, so treat it like a
                password and generate a new one if it leaks.
              </div>
              {pairing.webUrl ? (
                <code className="phone-url">{pairing.webUrl}</code>
              ) : null}
            </div>
          ) : null}

          <div className="phone-devices">
            <div className="phone-devices-title">Paired devices</div>
            {status.devices.length === 0 ? (
              <div className="phone-muted">None yet</div>
            ) : (
              status.devices.map((device) => (
                <div key={device.id} className="phone-device">
                  <span
                    className="phone-device-dot"
                    data-connected={device.connected ? "true" : "false"}
                  />
                  <span className="phone-device-name">{device.name}</span>
                  <span className="phone-device-state">
                    {device.connected
                      ? "connected"
                      : device.lastSeenAt
                        ? "offline"
                        : "never connected"}
                  </span>
                  <button
                    className="phone-revoke"
                    onClick={() => revoke(device.id)}
                    title="Revoke this device"
                  >
                    Revoke
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <div className="phone-hint">
          Turn this on to watch your agents from your phone and answer their
          questions remotely. Your phone reaches this Mac over Tailscale, through
          HTTPS from tailscale serve; traffic is end-to-end encrypted and never
          passes through any server of ours.
        </div>
      )}
    </div>
  );
}
