// Session notes (docs/specs/session-notes/prd.md): the builder's own note on a
// contact. It is kept in contacts.json with the contact, outlives every process
// the contact runs, goes with the contact when it is removed, and is not copied
// by Duplicate.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedContact } from "./store";

const state: { saved: SavedContact[]; broadcasts: number; failSave: boolean } = {
  saved: [],
  broadcasts: 0,
  failSave: false,
};

vi.mock("node-pty", () => ({
  spawn: () => ({
    write: () => {},
    onData: () => {},
    onExit: () => {},
    resize: () => {},
    kill: () => {},
    pid: 4242,
  }),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("./remote/ws-server", () => ({
  remoteServer: {
    broadcastExit: () => {},
    broadcastInstances: () => {
      state.broadcasts++;
    },
    broadcastOutput: () => {},
  },
}));

vi.mock("./shell-manager", () => ({ shellManager: { kill: () => {} } }));

vi.mock("./store", () => ({
  loadContacts: () => state.saved.map((c) => ({ ...c })),
  saveContacts: (contacts: SavedContact[]) => {
    if (state.failSave) throw new Error("EROFS: read-only file system");
    state.saved = contacts.map((c) => ({ ...c }));
  },
}));

vi.mock("./backends", () => ({
  getBackend: (name: string) => ({
    name,
    spawn: (_cwd: string, _opts?: unknown, session?: { kind: string; sessionId?: string }) => ({
      command: name,
      args: [],
      env: {},
      sessionId: session?.kind === "own" ? session.sessionId : "minted",
    }),
    discoverSessionId: () => ({ cancel: () => {} }),
    createHookAttention: () => ({ handle: () => {}, stop: () => {} }),
    readTranscript: () => [],
    readContextUsage: () => null,
    findLatestSessionId: () => null,
    findLiveSessionId: () => null,
    buildResumeCommand: () => "x",
  }),
}));

const { ProcessManager } = await import("./process-manager");
const { NOTE_MAX_LENGTH } = await import("../shared/types");

const A: SavedContact = { id: "a", cwd: "/p/billing", backend: "claude", sessionId: "s-a" };
const B: SavedContact = { id: "b", cwd: "/p/portal", backend: "claude", sessionId: "s-b" };

beforeEach(() => {
  state.saved = [];
  state.broadcasts = 0;
  state.failSave = false;
});

describe("setNote", () => {
  it("keeps the note with the contact in contacts.json and in the listing", () => {
    state.saved = [{ ...A }, { ...B }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const before = Date.now();
    const info = pm.setNote("a", "  continue the refund flow tomorrow\n");

    expect(info?.note?.text).toBe("continue the refund flow tomorrow");
    expect(info?.note?.writtenAt).toBeGreaterThanOrEqual(before);
    expect(state.saved.find((c) => c.id === "a")?.note?.text).toBe(
      "continue the refund flow tomorrow"
    );
    expect(state.saved.find((c) => c.id === "b")?.note).toBeUndefined();
    expect(pm.listInstances().find((i) => i.id === "a")?.note?.text).toBe(
      "continue the refund flow tomorrow"
    );
  });

  it("replaces the text and the time on a second save", () => {
    state.saved = [{ ...A, note: { text: "old", writtenAt: 1 } }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const info = pm.setNote("a", "new");

    expect(info?.note?.text).toBe("new");
    expect(info?.note?.writtenAt).toBeGreaterThan(1);
  });

  it("removes the note on blank text, as Got it does", () => {
    state.saved = [{ ...A, note: { text: "old", writtenAt: 1 } }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const info = pm.setNote("a", " \n ");

    expect(info).not.toBeNull();
    expect(info?.note).toBeUndefined();
    expect(state.saved[0].note).toBeUndefined();
  });

  it("refuses text past the limit and keeps what was there", () => {
    state.saved = [{ ...A, note: { text: "old", writtenAt: 1 } }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    expect(pm.setNote("a", "x".repeat(NOTE_MAX_LENGTH))?.note?.text).toHaveLength(
      NOTE_MAX_LENGTH
    );
    expect(pm.setNote("a", "x".repeat(NOTE_MAX_LENGTH + 1))).toBeNull();
    expect(state.saved[0].note?.text).toHaveLength(NOTE_MAX_LENGTH);
  });

  it("keeps the old note, shown and saved, when the save fails", () => {
    state.saved = [{ ...A, note: { text: "old", writtenAt: 1 } }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    state.failSave = true;
    expect(() => pm.setNote("a", "new")).toThrow();
    expect(() => pm.setNote("a", "")).toThrow();
    expect(pm.infoOf("a")?.note).toEqual({ text: "old", writtenAt: 1 });

    // The next save of something else writes the old note, not the failed one.
    state.failSave = false;
    pm.setAlias("a", "Billing");
    expect(state.saved[0].note).toEqual({ text: "old", writtenAt: 1 });
  });

  it("leaves no note behind when the first save fails", () => {
    state.saved = [{ ...A }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    state.failSave = true;
    expect(() => pm.setNote("a", "new")).toThrow();
    expect(pm.infoOf("a")?.note).toBeUndefined();
    expect(pm.takeStartupNotes()).toEqual([]);
  });

  it("returns null for a contact that isn't there", () => {
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    expect(pm.setNote("nobody", "x")).toBeNull();
  });

  it("does not tell the phone", () => {
    state.saved = [{ ...A }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    pm.setNote("a", "x");
    expect(state.broadcasts).toBe(0);
  });
});

describe("a note outlives the contact's processes", () => {
  it("stays through start, kill, restart and a reload of the contacts", () => {
    state.saved = [{ ...A }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    pm.setNote("a", "don't forget the migration");

    expect(pm.startInstance("a")?.note?.text).toBe("don't forget the migration");
    pm.killInstance("a");
    expect(pm.restartInstance("a")?.note?.text).toBe("don't forget the migration");
    expect(state.saved[0].note?.text).toBe("don't forget the migration");

    // A reloaded window loads the contacts again; the note is still there once.
    expect(pm.loadSavedContacts()[0].note?.text).toBe("don't forget the migration");
  });

  it("is read back from contacts.json on the next run", () => {
    state.saved = [{ ...A, note: { text: "from yesterday", writtenAt: 1700000000000 } }];
    const pm = new ProcessManager();
    const [a] = pm.loadSavedContacts();
    expect(a.note).toEqual({ text: "from yesterday", writtenAt: 1700000000000 });
  });

  it("reads a note back as setNote would keep it: trimmed, within the limit", () => {
    state.saved = [
      { ...A, note: { text: "  padded \n", writtenAt: 1 } },
      { ...B, note: { text: "x".repeat(NOTE_MAX_LENGTH + 1), writtenAt: 1 } },
      { id: "c", cwd: "/p/c", backend: "claude", note: { text: "y".repeat(NOTE_MAX_LENGTH), writtenAt: 1 } },
    ];
    const pm = new ProcessManager();
    const [a, b, c] = pm.loadSavedContacts();
    expect(a.note?.text).toBe("padded");
    expect(b.note).toBeUndefined();
    expect(c.note?.text).toHaveLength(NOTE_MAX_LENGTH);
  });

  it("drops a note of the wrong shape in contacts.json", () => {
    state.saved = [
      { ...A, note: { text: 42, writtenAt: 1 } as never },
      { ...B, note: { text: "x" } as never },
    ];
    const pm = new ProcessManager();
    const infos = pm.loadSavedContacts();
    expect(infos.every((i) => i.note === undefined)).toBe(true);
  });
});

describe("remove and duplicate", () => {
  it("removes the note with the contact", () => {
    state.saved = [{ ...A, note: { text: "x", writtenAt: 1 } }, { ...B }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    pm.removeInstance("a");

    expect(state.saved.map((c) => c.id)).toEqual(["b"]);
    expect(pm.takeStartupNotes()).toEqual([]);
  });

  it("does not copy the note to a duplicate", () => {
    state.saved = [{ ...A, note: { text: "x", writtenAt: 1 } }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const copy = pm.duplicateInstance("a");

    expect(copy?.note).toBeUndefined();
    expect(state.saved.find((c) => c.id === copy?.id)?.note).toBeUndefined();
    expect(state.saved.find((c) => c.id === "a")?.note?.text).toBe("x");
  });
});

describe("takeStartupNotes", () => {
  it("gives the contacts with a note once per run, in stored order", () => {
    state.saved = [
      { ...B, note: { text: "b", writtenAt: 2 } },
      { id: "c", cwd: "/p/c", backend: "claude" },
      { ...A, note: { text: "a", writtenAt: 1 } },
    ];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    expect(pm.takeStartupNotes()).toEqual(["b", "a"]);
    pm.setNote("c", "new tonight");
    expect(pm.takeStartupNotes()).toEqual([]);
  });
});
