import fs from "fs";
import path from "path";
import { app } from "electron";

import type { BackendName } from "./backends";

export interface SavedContact {
  id: string;
  cwd: string;
  alias?: string;
  backend?: BackendName;
  // The session this contact last worked in, which its next start opens again.
  // Absent on contacts saved before it was kept, and on one whose session isn't
  // known yet; those open the directory's most recent session.
  sessionId?: string;
}

const STORE_PATH = path.join(app.getPath("userData"), "contacts.json");

export function loadContacts(): SavedContact[] {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = fs.readFileSync(STORE_PATH, "utf8");
      return withoutManager(JSON.parse(data));
    }
  } catch {
    // Ignore parse errors, return empty
  }
  return [];
}

// The manager agent was retired on 2026-11-01. Its contact, marked `isManager`, is
// left out, and the next save drops it from the file. Its directory under userData
// is never touched: the builder kept their own files in it.
function withoutManager(contacts: (SavedContact & { isManager?: boolean })[]): SavedContact[] {
  return contacts.filter((c) => !c.isManager);
}

export function saveContacts(contacts: SavedContact[]) {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(contacts, null, 2));
}
