// Toolbox section for the phone link (mobile-v2 Story 9): switch the server on, see
// the three things a phone needs (Tailscale, HTTPS, Push) with each one's fix, pair a
// phone once all three pass, and manage the paired phones.
//
// Unlike the other toolbox sections this is app-wide, not per-instance — one
// server serves every instance — but it lives here because that's where the
// project puts everything that isn't the terminal.
//
// Nothing here changes Tailscale except "Set up HTTPS", which shows its command and
// runs it only on a second press. Multi-Code never removes that serve itself, so the
// section says how to.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RemotePairing, RemoteTestPush } from "../../shared/types";
import type { RemoteChecks, RemoteStatus } from "../../shared/remote-protocol";
import { checkRows, deviceLine, firstToFix, pairingIsFor, pairingOrigin, type CheckRow } from "./phoneText";

const GET_TAILSCALE_URL = "https://tailscale.com/download/mac";
const UNDO_SERVE = "tailscale serve --https=443 off";
const MARKS = { ok: "✓", bad: "✗", unknown: "?" } as const;

interface PhoneSectionProps {
  active: boolean;
}

export function PhoneSection({ active }: PhoneSectionProps) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  // The shown code's link was copied ("Copy pairing link").
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // "Set up HTTPS" was pressed: its command is shown, waiting for "Run it".
  const [confirmServe, setConfirmServe] = useState(false);
  // Why the last action (Set up HTTPS, Open Tailscale, a link, pairing) didn't work.
  const [actionError, setActionError] = useState<string | null>(null);
  // The phone whose Revoke was pressed, waiting for the second press.
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  // Each phone's last "Send test", or "sending" while it runs.
  const [tests, setTests] = useState<Record<string, RemoteTestPush | "sending">>({});
  // For "seen 5 min ago".
  const [now, setNow] = useState(() => Date.now());
  // The checks last shown, so a push that changes them drops the last action's error,
  // which was about a state that is gone.
  const shownChecks = useRef("");
  // Bumped whenever a code being made would no longer be wanted (Done, the checks
  // changed), so its late reply doesn't put it back.
  const pairRequest = useRef(0);

  const show = useCallback((next: RemoteStatus) => {
    shownChecks.current = JSON.stringify(next.checks);
    setStatus(next);
  }, []);

  const refresh = useCallback(() => {
    void window.electronAPI.getRemoteStatus().then(show);
  }, [show]);

  useEffect(() => {
    if (!active) return;
    refresh();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  // Live status pushes (a phone connecting, a check changing) so the section is
  // honest without being reopened.
  useEffect(() => {
    const cleanup = window.electronAPI.onRemoteStatus((next) => {
      if (JSON.stringify(next.checks) !== shownChecks.current) setActionError(null);
      show(next);
    });
    return cleanup;
  }, [show]);

  const rows = status?.enabled ? checkRows(status.checks) : null;
  const blocker = rows ? firstToFix(rows) : null;
  const origin = pairingOrigin(status);
  const ready = origin !== null;

  // A code is shown only while every check passes, and only for the address it was
  // made for: either change has a phone pair with a Mac it can't reach.
  useEffect(() => {
    pairRequest.current++;
    setPairing(null);
  }, [origin]);

  if (!active) return null;

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    setActionError(null);
    setConfirmServe(false);
    try {
      show(await window.electronAPI.setRemoteEnabled(!status.enabled));
    } finally {
      setBusy(false);
    }
  };

  // "Pair a phone", and "New code" with the code it replaces: main revokes that one
  // once the new one is made, unless a phone has used it (its row is that phone's).
  const pairNew = async (replacing?: RemotePairing) => {
    const request = ++pairRequest.current;
    setBusy(true);
    setActionError(null);
    try {
      const next = await window.electronAPI.createRemotePairing(replacing?.deviceId);
      if (request !== pairRequest.current) return;
      setPairing(next);
      setCopied(false);
      if (!next) setActionError("No code was made: HTTPS isn't ready any more. Check again.");
    } finally {
      setBusy(false);
    }
  };

  // The link the QR encodes, for the Home Screen app's "Paste pairing link": that app
  // may not share Safari's storage, so a pairing scanned into Safari may not reach it
  // (G-306), and Universal Clipboard carries this copy to the iPhone.
  const copyLink = async (url: string) => {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch (err) {
      setActionError(`Couldn't copy the link: ${(err as Error)?.message ?? err}`);
    }
  };

  const runServe = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await window.electronAPI.setUpRemoteHttps();
      show(result.status);
      setActionError(result.error ?? null);
      setConfirmServe(false);
    } finally {
      setBusy(false);
    }
  };

  const openTailscale = async () => {
    setActionError(null);
    const result = await window.electronAPI.openTailscale();
    if (!result.ok) setActionError(`Couldn't open Tailscale: ${result.error ?? "unknown error"}`);
  };

  const openUrl = async (url: string) => {
    setActionError(null);
    const result = await window.electronAPI.openExternal(url);
    if (!result.ok) setActionError(`Couldn't open ${url}: ${result.error ?? "unknown error"}`);
  };

  const sendTest = async (deviceId: string) => {
    setTests((prev) => ({ ...prev, [deviceId]: "sending" }));
    const result = await window.electronAPI.sendRemoteTestPush(deviceId);
    setTests((prev) => ({ ...prev, [deviceId]: result }));
  };

  const revoke = async (deviceId: string) => {
    setConfirmRevoke(null);
    show(await window.electronAPI.revokeRemoteDevice(deviceId));
  };

  const fixButton = (label: string, onClick: () => void) => (
    <button className="phone-act" onClick={onClick} disabled={busy}>
      {label}
    </button>
  );

  // The row's fix, at its right, as in the mockup.
  const fixOf = (row: CheckRow, checks: RemoteChecks) => {
    if (row.key === "tailscale") {
      if (checks.tailscale.state === "missing") {
        return fixButton("Get Tailscale", () => void openUrl(GET_TAILSCALE_URL));
      }
      if (checks.tailscale.state !== "running") return fixButton("Open Tailscale", () => void openTailscale());
    }
    if (row.key === "https") {
      const https = checks.https;
      if (https.state === "certs-off") return fixButton("Open admin console", () => void openUrl(https.adminUrl));
      if (https.state === "serve-missing" && !confirmServe) {
        return fixButton("Set up HTTPS", () => setConfirmServe(true));
      }
    }
    return null;
  };

  // What the row says under its text: how to undo the serve, the command before it
  // runs, or why a conflict is left alone.
  const noteOf = (row: CheckRow, checks: RemoteChecks) => {
    if (row.key !== "https") return null;
    const https = checks.https;
    const undo = (
      <>
        To remove it: <code className="phone-code">{UNDO_SERVE}</code>
      </>
    );
    if (https.state === "ready") {
      return <div className="phone-check-note">Stays set up after Multi-Code quits. {undo}</div>;
    }
    if (https.state === "serve-conflict") {
      return (
        <div className="phone-check-note">
          Multi-Code never overwrites it. If you don't need what is there, remove it, then check again.
        </div>
      );
    }
    if (https.state === "serve-missing" && confirmServe) {
      const dnsName = checks.tailscale.state === "running" ? checks.tailscale.dnsName : null;
      return (
        <div className="phone-confirm">
          <div>Multi-Code runs:</div>
          <code className="phone-code">{https.command}</code>
          <div>
            It serves Multi-Code at {dnsName ? `https://${dnsName}` : "this Mac's tailnet address"} to your
            tailnet only, and stays after Multi-Code quits; Multi-Code never removes it. {undo}
          </div>
          <div className="phone-row">
            <button className="phone-btn" onClick={runServe} disabled={busy}>
              {busy ? "Running…" : "Run it"}
            </button>
            <button className="phone-btn" onClick={() => setConfirmServe(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return null;
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
        {status?.port ? <span className="phone-port">port {status.port}</span> : null}
      </div>

      {status?.error ? <div className="phone-error">{status.error}</div> : null}

      {status?.enabled && rows ? (
        <>
          <div className="phone-checks">
            {rows.map((row) => (
              <div key={row.key} className="phone-check" data-check={row.key} data-tone={row.tone}>
                <span className="phone-check-mark">{MARKS[row.tone]}</span>
                <span className="phone-check-label">{row.label}</span>
                <span className="phone-check-text" data-mono={row.tone === "ok" ? "true" : "false"}>
                  {row.text}
                </span>
                {fixOf(row, status.checks)}
                {noteOf(row, status.checks)}
              </div>
            ))}
          </div>

          {actionError ? <div className="phone-error">{actionError}</div> : null}

          {!ready ? (
            <div className="phone-gate">
              <span>
                Pairing needs all three. Fix <b>{blocker?.label}</b> first.
              </span>
              <button className="phone-act" onClick={refresh}>
                Check again
              </button>
            </div>
          ) : pairing && pairingIsFor(pairing.webUrl, origin) ? (
            <div className="phone-pairing">
              {pairing.qrDataUrl ? (
                <img
                  className="phone-qr"
                  src={pairing.qrDataUrl}
                  alt="Pairing QR code"
                  width={240}
                  height={240}
                />
              ) : (
                <code className="phone-code">{pairing.webUrl}</code>
              )}
              <div className="phone-caption">
                Scan with the iPhone camera to pair a new phone, or copy the link and
                paste it in the phone app. Both hold a secret for that one phone. New code
                cancels this one unless a phone has used it; Done keeps it. If it leaks,
                revoke its row below.
              </div>
              <div className="phone-row">
                <button className="phone-btn" onClick={() => void copyLink(pairing.webUrl)}>
                  {copied ? "Copied" : "Copy pairing link"}
                </button>
                <button className="phone-btn" onClick={() => void pairNew(pairing)} disabled={busy}>
                  New code
                </button>
                <button
                  className="phone-btn"
                  onClick={() => {
                    pairRequest.current++;
                    setPairing(null);
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="phone-row">
              <button className="phone-btn" onClick={() => void pairNew()} disabled={busy}>
                Pair a phone
              </button>
              <span className="phone-muted">Shows a code to scan with the iPhone camera.</span>
            </div>
          )}
        </>
      ) : status && !status.enabled ? (
        <div className="phone-hint">
          Turn this on to watch your agents from your phone and answer them there.
          Your phone reaches this Mac only inside your tailnet, over HTTPS from
          tailscale serve, end-to-end encrypted; notifications go through Apple's
          push service, encrypted to the phone.
        </div>
      ) : null}

      {status ? (
        <div className="phone-devices">
          <div className="phone-devices-title">Paired phones</div>
          {status.devices.length === 0 ? <div className="phone-muted">None yet</div> : null}
          {status.devices.map((device) => {
            const test = tests[device.id];
            const testDone = test && test !== "sending" ? test : null;
            // A test that just failed is usually the last push that failed: said once.
            const lastError =
              device.lastPushError && !(testDone && !testDone.ok && testDone.error === device.lastPushError)
                ? device.lastPushError
                : null;
            return (
              <div key={device.id} className="phone-device-item" data-device={device.id}>
                <div className="phone-device">
                  <span
                    className="phone-device-dot"
                    data-connected={device.connected ? "true" : "false"}
                  />
                  <span className="phone-device-name">{device.name}</span>
                  <span className="phone-device-state">{deviceLine(device, now)}</span>
                  {confirmRevoke === device.id ? null : (
                    <>
                      <button
                        className="phone-act"
                        onClick={() => void sendTest(device.id)}
                        disabled={test === "sending"}
                      >
                        {test === "sending" ? "Sending…" : "Send test"}
                      </button>
                      <button className="phone-revoke" onClick={() => setConfirmRevoke(device.id)}>
                        Revoke
                      </button>
                    </>
                  )}
                </div>
                {lastError ? (
                  <div className="phone-device-note" data-tone="bad">
                    Last push failed: {lastError}
                  </div>
                ) : null}
                {testDone ? (
                  <div className="phone-device-note" data-tone={testDone.ok ? "ok" : "bad"}>
                    {testDone.ok
                      ? "Test sent. It shows on the phone in a few seconds."
                      : `Test failed: ${testDone.error}`}
                  </div>
                ) : null}
                {confirmRevoke === device.id ? (
                  <div className="phone-confirm">
                    <div>
                      Revoke {device.name}? It's disconnected at once, its code stops
                      working and it gets no more notifications.
                    </div>
                    <div className="phone-row">
                      <button className="phone-revoke" onClick={() => void revoke(device.id)}>
                        Revoke
                      </button>
                      <button className="phone-act" onClick={() => setConfirmRevoke(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="phone-muted">
            A phone paired with an earlier Multi-Code (an http://…:6768 address) must be
            paired again: remove its old Home Screen icon, then scan a new code.
          </div>
        </div>
      ) : null}
    </div>
  );
}
