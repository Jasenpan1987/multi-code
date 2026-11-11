// Duplicate, and each contact keeping a session of its own.
//
// What the builder asked for: right-click a contact, Duplicate, and get a second
// contact on the same project in a fresh session. What makes that hold past the
// first start: every contact remembers its session in contacts.json and opens it
// again, instead of both taking the directory's newest with `--continue`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStart } from "./backends";
import type { SavedContact } from "./store";

const state: {
  saved: SavedContact[];
  spawns: Array<{ cwd: string; session?: SessionStart }>;
  // What the fake backend says each spawn opened. Claude names every session up
  // front except a `--continue`.
  opened: (session?: SessionStart) => string | undefined;
  latest: string | null;
  discoverCalls: number;
  // Backends that pick the newest session themselves at spawn (OpenCode).
  picksLatest: Set<string>;
  latestLookups: number;
} = {
  saved: [],
  spawns: [],
  opened: () => undefined,
  latest: null,
  discoverCalls: 0,
  picksLatest: new Set(),
  latestLookups: 0,
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
    broadcastInstances: () => {},
    broadcastOutput: () => {},
  },
}));

vi.mock("./shell-manager", () => ({ shellManager: { kill: () => {} } }));

vi.mock("./store", () => ({
  loadContacts: () => state.saved.map((c) => ({ ...c })),
  saveContacts: (contacts: SavedContact[]) => {
    state.saved = contacts.map((c) => ({ ...c }));
  },
}));

vi.mock("./backends", () => ({
  getBackend: (name: string) => ({
    name,
    picksLatestSession: state.picksLatest.has(name),
    spawn: (cwd: string, _opts?: unknown, session?: SessionStart) => {
      state.spawns.push({ cwd, session });
      return { command: name, args: [], env: {}, sessionId: state.opened(session) };
    },
    discoverSessionId: () => {
      state.discoverCalls++;
      return { cancel: () => {} };
    },
    createHookAttention: () => ({ handle: () => {}, stop: () => {} }),
    readTranscript: () => [],
    readContextUsage: () => null,
    findLatestSessionId: () => {
      state.latestLookups++;
      return state.latest;
    },
    findLiveSessionId: () => null,
    buildResumeCommand: () => "x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

const CWD = "/Users/x/code/billing";
let minted = 0;

beforeEach(() => {
  state.saved = [];
  state.spawns = [];
  state.latest = null;
  state.discoverCalls = 0;
  minted = 0;
  // Like claude: resume the own id, or mint one for anything but --continue.
  state.opened = (session) => {
    if (session?.kind === "own") return session.sessionId;
    if (session?.kind === "fresh") return `minted-${++minted}`;
    return undefined;
  };
});

describe("createInstance", () => {
  it("puts a new contact at the top, above the saved ones", () => {
    state.saved = [
      { id: "old-1", cwd: "/Users/x/code/a" },
      { id: "old-2", cwd: "/Users/x/code/b" },
    ];
    const manager = new ProcessManager();
    manager.loadSavedContacts();
    const added = manager.createInstance("/Users/x/code/c");

    expect(manager.listInstances().map((i) => i.id)).toEqual([added.id, "old-1", "old-2"]);
    expect(state.saved.map((c) => c.id)).toEqual([added.id, "old-1", "old-2"]);
  });
});

describe("duplicateInstance", () => {
  it("adds a contact on the same project, in a fresh session, at the top", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD, "Billing");
    const other = manager.createInstance("/Users/x/code/other");
    const copy = manager.duplicateInstance(first.id)!;

    expect(copy.cwd).toBe(CWD);
    expect(copy.backend).toBe(first.backend);
    expect(copy.status).toBe("running");
    expect(state.spawns.at(-1)?.session).toEqual({ kind: "fresh" });
    expect(manager.listInstances().map((i) => i.id)).toEqual([copy.id, other.id, first.id]);
    // Saved in that order too: contacts.json is the list's layout.
    expect(state.saved.map((c) => c.id)).toEqual([copy.id, other.id, first.id]);
  });

  it("names the copy with the first free number", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD, "Billing");
    expect(manager.duplicateInstance(first.id)!.name).toBe("Billing 2");
    expect(manager.duplicateInstance(first.id)!.name).toBe("Billing 3");
  });

  it("counts on from the base name when a copy is duplicated", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD, "Billing");
    const second = manager.duplicateInstance(first.id)!;
    expect(manager.duplicateInstance(second.id)!.name).toBe("Billing 3");
  });

  it("falls back to the folder name for a contact without an alias", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD);
    expect(manager.duplicateInstance(first.id)!.name).toBe("billing 2");
  });

  it("returns null for an unknown contact", () => {
    expect(new ProcessManager().duplicateInstance("nope")).toBeNull();
  });
});

describe("a contact's own session", () => {
  it("is saved as soon as the backend names it, and skips discovery", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD, "Billing");
    const copy = manager.duplicateInstance(first.id)!;
    expect(copy.sessionId).toBe("minted-1");
    expect(state.saved.find((c) => c.id === copy.id)?.sessionId).toBe("minted-1");
    // Only the original, started with --continue, had anything to discover.
    expect(state.discoverCalls).toBe(1);
  });

  it("is what the next start opens, after an app restart too", () => {
    const before = new ProcessManager();
    const first = before.createInstance(CWD, "Billing");
    const copy = before.duplicateInstance(first.id)!;

    const after = new ProcessManager();
    after.loadSavedContacts();
    state.spawns = [];
    after.startInstance(copy.id);
    expect(state.spawns[0].session).toEqual({ kind: "own", sessionId: "minted-1" });
  });

  it("is kept by a restart", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD, "Billing");
    const copy = manager.duplicateInstance(first.id)!;
    state.spawns = [];
    manager.restartInstance(copy.id);
    expect(state.spawns[0].session).toEqual({ kind: "own", sessionId: "minted-1" });
  });

  it("keeps a contact with none on record from continuing into another's", () => {
    // The original predates the field, so it has no session of its own yet, and
    // the directory's newest is the copy's. --continue would put both in it.
    state.saved = [{ id: "old", cwd: CWD, alias: "Billing" }];
    const manager = new ProcessManager();
    manager.loadSavedContacts();
    const copy = manager.duplicateInstance("old")!;
    manager.killInstance(copy.id);
    state.latest = copy.sessionId!;

    state.spawns = [];
    manager.startInstance("old");
    expect(state.spawns[0].session).toEqual({ kind: "fresh" });
  });

  it("still continues the directory's latest when nobody owns it", () => {
    state.saved = [{ id: "old", cwd: CWD, alias: "Billing" }];
    state.latest = "from-before";
    const manager = new ProcessManager();
    manager.loadSavedContacts();
    manager.startInstance("old");
    const session = state.spawns[0].session as { kind: string; isClaimed?: (id: string) => boolean };
    expect(session.kind).toBe("latest");
    // A backend that picks the session itself (OpenCode) checks its pick with this.
    expect(session.isClaimed?.("from-before")).toBe(false);
    const other = manager.createInstance(CWD, "Billing 2");
    expect(session.isClaimed?.(other.sessionId!)).toBe(true);
  });

  it("leaves the pick to a backend that makes it at spawn, held newest or not", () => {
    // OpenCode reads its database from the login shell's env, which the spawn
    // resolves: a look made here could be in another database.
    state.picksLatest = new Set(["opencode"]);
    try {
      state.saved = [{ id: "old", cwd: CWD, alias: "Billing", backend: "opencode" }];
      const manager = new ProcessManager();
      manager.loadSavedContacts();
      const copy = manager.duplicateInstance("old")!;
      manager.killInstance(copy.id);
      state.latest = copy.sessionId!;
      state.latestLookups = 0;
      state.spawns = [];
      manager.startInstance("old");
      const session = state.spawns[0].session as { kind: string; isClaimed?: (id: string) => boolean };
      expect(session.kind).toBe("latest");
      expect(state.latestLookups).toBe(0);
      // The backend's own pick is then checked: the copy's session is held.
      expect(session.isClaimed?.(copy.sessionId!)).toBe(true);
    } finally {
      state.picksLatest = new Set();
    }
  });
});

describe("setAlias", () => {
  it("renames the contact and saves it", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD, "Billing");
    expect(manager.setAlias(first.id, "  Billing review  ")?.name).toBe("Billing review");
    expect(state.saved[0].alias).toBe("Billing review");
  });

  it("goes back to the folder name when blank", () => {
    const manager = new ProcessManager();
    const first = manager.createInstance(CWD, "Billing");
    const renamed = manager.setAlias(first.id, "   ")!;
    expect(renamed.alias).toBeUndefined();
    expect(renamed.name).toBe("billing");
  });
});
