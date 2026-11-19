import fs from "fs";
import path from "path";
import { app } from "electron";

import type { BackendName } from "./backends";
import type { SessionNote } from "../shared/types";

export interface SavedContact {
  id: string;
  cwd: string;
  alias?: string;
  backend?: BackendName;
  // The session this contact last worked in, which its next start opens again.
  // Absent on contacts saved before it was kept, and on one whose session isn't
  // known yet; those open the directory's most recent session.
  sessionId?: string;
  // The builder's note on this contact (epic session-notes). As read from disk it is
  // unchecked: ProcessManager keeps it only if it has the right shape.
  note?: SessionNote;
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
  // Through a file beside it and a rename, so a write cut short (a full disk, a
  // kill) leaves the old list whole: a torn contacts.json loads as no contacts at
  // all, notes and sessions with them. Named by process, so two apps on one
  // userData (see CLAUDE.md, Data Storage) never rename each other's half-written
  // file into place; within a process saves don't overlap, being synchronous.
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  // The new file takes the old one's mode, as writing over it in place did: a
  // builder who made it owner-only keeps it so.
  const mode = fs.statSync(STORE_PATH, { throwIfNoEntry: false })?.mode ?? 0o644;
  try {
    // A leftover from a crash would keep its own mode through the write.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(contacts, null, 2), { mode: mode & 0o777 });
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    // What didn't go in leaves nothing behind, a refused note included. The
    // caller hears why the save failed, not why the tidying did.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to do: the disk refuses writes by now.
    }
    throw err;
  }
}
