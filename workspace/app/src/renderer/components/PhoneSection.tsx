// Toolbox section for the phone link: switch the server on, show a pairing QR,
// and manage paired devices.
//
// Unlike the other toolbox sections this is app-wide, not per-instance — one
// server serves every instance — but it lives here because that's where the
// project puts everything that isn't the terminal.

import { useCallback, useEffect, useState } from "react";
import type { RemotePairing } from "../../shared/types";
import type { EndpointKind, RemoteStatus } from "../../shared/remote-protocol";

// Spells out what each address can actually do, so the reason a phone fails to
// connect from outside is visible before pairing rather than after.
const ENDPOINT_LABEL: Record<EndpointKind, string> = {
  tailscale: "works anywhere",
  lan: "this network only",
  vpn: "VPN — phone can't use this",
};

interface PhoneSectionProps {
  active: boolean;
}

export function PhoneSection({ active }: PhoneSectionProps) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [hasTailscale, setHasTailscale] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void window.electronAPI.getRemoteStatus().then(setStatus);
    void window.electronAPI.hasTailscale().then(setHasTailscale);
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
          {hasTailscale === false ? (
            <div className="phone-warn">
              <strong>Same-network only.</strong> Every address below is private,
              so your phone can only connect while it&apos;s on this same Wi-Fi.
              It will <em>not</em> work over cellular.
              <br />
              To reach this desktop from anywhere, install{" "}
              <a
                href="https://tailscale.com/download"
                onClick={(e) => {
                  e.preventDefault();
                  void window.electronAPI.openExternal(
                    "https://tailscale.com/download"
                  );
                }}
              >
                Tailscale
              </a>{" "}
              on this Mac and on your phone, signed into the same account. A{" "}
              <code>100.x</code> address will appear here and be used first.
            </div>
          ) : (
            <div className="phone-ok">
              Tailscale detected — your phone can reach this desktop from
              anywhere, not just this network.
            </div>
          )}

          <div className="phone-endpoints">
            {status.endpoints.length === 0 ? (
              <span className="phone-muted">No network address available</span>
            ) : (
              status.endpoints.map((endpoint) => (
                <code
                  key={endpoint.url}
                  className="phone-endpoint"
                  data-kind={endpoint.kind}
                >
                  {endpoint.url}
                  <span className="phone-endpoint-tag">
                    {ENDPOINT_LABEL[endpoint.kind]}
                  </span>
                </code>
              ))
            )}
          </div>

          <button className="phone-btn" onClick={pairNew} disabled={busy}>
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
          questions remotely. It opens a port on your local network; traffic is
          end-to-end encrypted and never passes through any server.
        </div>
      )}
    </div>
  );
}
