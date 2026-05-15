import fs from "fs";
import path from "path";
import { app } from "electron";

export interface SavedContact {
  id: string;
  cwd: string;
  alias?: string;
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
