// Reads the pairing offer the desktop's QR encodes, and remembers it so the phone
// reconnects on its own next time.
//
// The offer arrives in the URL fragment (`<origin>/#pair=<base64url JSON>`). A
// fragment is never sent to a server, which matters because the device token is
// in it: the same reason password-reset flows use fragments. The router strips it
// from the address bar once it is saved.

import { REMOTE_PROTOCOL_VERSION, type PairingOffer } from "../shared/remote-protocol";

const STORAGE_KEY = "multicode.pairing";
const DEVICE_NAME_KEY = "multicode.deviceName";

// What the phone keeps of an offer. The socket always dials the page's own origin,
// so `origin` is only shown (the setup screen's footer).
export type StoredPairing = Omit<PairingOffer, "v">;

export function decodeOffer(code: string): PairingOffer | null {
  try {
    // atob wants standard base64; the desktop encodes base64url.
    const normalized = code.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as PairingOffer;
    return isOffer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isOffer(value: PairingOffer): boolean {
  return (
    value?.v === REMOTE_PROTOCOL_VERSION &&
    typeof value.origin === "string" &&
    typeof value.hostPublicKey === "string" &&
    value.hostPublicKey !== "" &&
    typeof value.deviceToken === "string" &&
    value.deviceToken !== "" &&
    typeof value.hostName === "string"
  );
}

// A pairing link pasted into the setup screen: the whole `#pair=` URL, or the bare
// code. For the Home Screen app, which on iOS may not see what Safari saved (it
// keeps its own storage) and can't be opened from a scanned QR.
export function offerFromText(text: string): PairingOffer | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/#pair=([A-Za-z0-9_-]+)/);
  return decodeOffer(match ? match[1] : trimmed);
}

export function loadPairing(storage: Storage): StoredPairing | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPairing;
    // A pairing from protocol v2 has `endpoints` and no `origin`: that phone pairs
    // again (PRD Story 1), and its stale entry is ignored.
    if (!parsed?.deviceToken || !parsed?.hostPublicKey || typeof parsed.origin !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storedPairing(offer: PairingOffer): StoredPairing {
  return {
    origin: offer.origin,
    hostPublicKey: offer.hostPublicKey,
    deviceToken: offer.deviceToken,
    hostName: offer.hostName,
  };
}

// False when storage is full (store.ts then makes room).
export function savePairing(storage: Storage, pairing: StoredPairing): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pairing));
    return true;
  } catch {
    return false;
  }
}

export function clearPairing(storage: Storage) {
  storage.removeItem(STORAGE_KEY);
}

// A label the desktop's device list tells phones apart by, from the user agent on
// first run and then remembered.
export function deviceName(storage: Storage): string {
  const saved = storage.getItem(DEVICE_NAME_KEY);
  if (saved) return saved;
  const ua = navigator.userAgent;
  let guess = "Phone";
  if (/iPhone/.test(ua)) guess = "iPhone";
  else if (/iPad/.test(ua)) guess = "iPad";
  else if (/Android/.test(ua)) guess = "Android";
  storage.setItem(DEVICE_NAME_KEY, guess);
  return guess;
}
