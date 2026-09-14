import fs from "fs";
import path from "path";
import { app } from "electron";

import type { BackendName } from "./backends";

export interface SavedContact {
  id: string;
  cwd: string;
  alias?: string;
  backend?: BackendName;
  // The coordinator instance. At most one exists, and it is spawned differently:
  // it gets the manager MCP tools and its cwd is a directory Multi-Code owns
  // rather than one of the user's projects.
  isManager?: boolean;
}

const STORE_PATH = path.join(app.getPath("userData"), "contacts.json");

export function loadContacts(): SavedContact[] {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = fs.readFileSync(STORE_PATH, "utf8");
      return JSON.parse(data);
    }
  } catch {
    // Ignore parse errors, return empty
  }
  return [];
}

export function saveContacts(contacts: SavedContact[]) {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(contacts, null, 2));
}
