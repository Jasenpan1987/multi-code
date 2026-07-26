// Persistence for paired phones. Mirrors store.ts (contacts.json) in shape and
// error handling: a corrupt file degrades to "no devices paired" rather than
// crashing the app, since the worst case is re-scanning a QR.

import fs from "fs";
import path from "path";
import { app } from "electron";

export interface StoredDevice {
  id: string;
  name: string;
  token: string;
  pairedAt: number;
  lastSeenAt: number;
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

// Written 0600: the file holds bearer tokens that grant terminal access.
export function saveDevices(devices: StoredDevice[]) {
  const file = storePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(devices, null, 2), { mode: 0o600 });
}
