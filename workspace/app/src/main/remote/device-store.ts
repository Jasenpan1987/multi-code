// Persistence for paired phones. Mirrors store.ts (contacts.json) in shape and
// error handling: a corrupt file degrades to "no devices paired" rather than
// crashing the app, since the worst case is re-scanning a QR.

import fs from "fs";
import path from "path";
import { app } from "electron";
import type { RemotePushSubscription } from "../../shared/remote-protocol";

export interface StoredDevice {
  id: string;
  name: string;
  token: string;
  pairedAt: number;
  lastSeenAt: number;
  // The phone's Web Push subscription, from its `push-subscribe`. Absent:
  // notifications are off on it (or it has never turned them on).
  push?: RemotePushSubscription;
  // The last push to it that failed, and why; cleared by the next one that works.
  lastPushError?: string;
}

function storePath(): string {
  return path.join(app.getPath("userData"), "remote-devices.json");
}

export function loadDevices(): StoredDevice[] {
  try {
    const file = storePath();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore parse errors, return empty
  }
  return [];
}

// Written 0600: the file holds bearer tokens that grant terminal access, and the
// phones' push subscriptions.
export function saveDevices(devices: StoredDevice[]) {
  const file = storePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(devices, null, 2), { mode: 0o600 });
}
