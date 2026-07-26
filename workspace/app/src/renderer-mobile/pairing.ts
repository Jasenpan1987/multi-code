// Reads the pairing payload the desktop QR encodes, and remembers it so the
// phone reconnects on its own next time.
//
// The payload arrives in the URL fragment (`#<base64url>`). A fragment is never
// sent to a server, which matters because the device token is in it — the same
// reason password-reset flows use fragments.

import type { PairingOffer } from "../shared/remote-protocol";
import { REMOTE_PROTOCOL_VERSION, type StoredPairing } from "./types";

const STORAGE_KEY = "multicode.pairing";
const DEVICE_NAME_KEY = "multicode.deviceName";

function decodePayload(code: string): PairingOffer | null {
  try {
    // atob wants standard base64; the desktop encodes base64url.
    const normalized = code.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const parsed = JSON.parse(
      decodeURIComponent(escape(atob(padded)))
    ) as PairingOffer;

    if (parsed.v !== REMOTE_PROTOCOL_VERSION) return null;
    if (!Array.isArray(parsed.endpoints) || parsed.endpoints.length === 0) {
      return null;
    }
    if (typeof parsed.hostPublicKey !== "string" || !parsed.hostPublicKey) {
      return null;
    }
    if (typeof parsed.deviceToken !== "string" || !parsed.deviceToken) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// A pairing offer present in the current URL fragment, if any. Also accepts the
// `multicode://pair?code=…` form so a scanned QR that opens as a custom scheme
// still works when pasted in.
export function pairingFromLocation(): PairingOffer | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash) {
    const offer = decodePayload(hash);
    if (offer) return offer;
  }
  return null;
}

export function pairingFromText(text: string): PairingOffer | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Accept a full URL (either scheme) or a bare code.
  const match = trimmed.match(/(?:code=|#)([A-Za-z0-9_-]+)/);
  if (match) {
    const offer = decodePayload(match[1]);
    if (offer) return offer;
  }
  return decodePayload(trimmed);
}

export function loadPairing(): StoredPairing | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPairing;
    if (!parsed?.deviceToken || !parsed?.hostPublicKey) return null;
    if (!Array.isArray(parsed.endpoints) || parsed.endpoints.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePairing(offer: PairingOffer) {
  const stored: StoredPairing = {
    endpoints: offer.endpoints,
    hostPublicKey: offer.hostPublicKey,
    deviceToken: offer.deviceToken,
    hostName: offer.hostName,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export function clearPairing() {
  localStorage.removeItem(STORAGE_KEY);
}

// A stable label so the desktop's device list distinguishes phones. Derived from
// the UA on first run and then remembered, since the user can rename it.
export function getDeviceName(): string {
  const saved = localStorage.getItem(DEVICE_NAME_KEY);
  if (saved) return saved;

  const ua = navigator.userAgent;
  let guess = "Phone";
  if (/iPhone/.test(ua)) guess = "iPhone";
  else if (/iPad/.test(ua)) guess = "iPad";
  else if (/Android/.test(ua)) guess = "Android";
  localStorage.setItem(DEVICE_NAME_KEY, guess);
  return guess;
}

export function setDeviceName(name: string) {
  localStorage.setItem(DEVICE_NAME_KEY, name);
}
