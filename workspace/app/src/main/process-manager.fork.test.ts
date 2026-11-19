// Duplicate's choices (docs/specs/duplicate-options/prd.md): a fork of the contact's
// own session, a fresh session, or a fresh session with the other tool. Each makes
// one new contact at the top; the source is left alone.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStart } from "./backends";
import type { SavedContact } from "./store";

const state: {
  saved: SavedContact[];
  spawns: Array<{ backend: string; cwd: string; session?: SessionStart }>;
  // Sessions with a conversation in them, by backend.
  conversations: Set<string>;
  // Sessions whose only entries are local (a `/clear` and nothing since).
  localOnly: Set<string>;
  forks: string[];
  forkResult: (sessionId: string) => Promise<SessionStart>;
  // What the CLI's registry says a running contact is on now: its own entry
  // (shown), and the poll's answer, which may be a guess from the directory (live).
  shown: string | null;
  live: string | null;
  // A spawn the CLI refuses (its fork's transcript went).
  refuse: boolean;
} = {
  saved: [],
  spawns: [],
  conversations: new Set(),
  localOnly: new Set(),
  forks: [],
  forkResult: async () => ({ kind: "fresh" }),
  shown: null,
  live: null,
  refuse: false,
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
  remoteServer: { broadcastExit: () => {}, broadcastInstances: () => {}, broadcastOutput: () => {} },
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
    spawn: (cwd: string, _opts?: unknown, session?: SessionStart) => {
      if (state.refuse) return { command: name, args: [], env: {}, refusal: "The conversation to fork is gone, so no fork was started." };
      state.spawns.push({ backend: name, cwd, session });
      const sessionId =
        session?.kind === "own" ? session.sessionId : `${name}-minted-${state.spawns.length}`;
      return { command: name, args: [], env: {}, sessionId };
    },
    forkSession: (_cwd: string, sessionId: string) => {
      state.forks.push(`${name}:${sessionId}`);
      return state.forkResult(sessionId);
    },
    readRecentTurns: (sessionId: string) => ({
      entries: state.conversations.has(`${name}:${sessionId}`)
        ? [{ kind: "user", text: "hi" }]
        : state.localOnly.has(`${name}:${sessionId}`)
          ? [{ kind: "user", text: "/clear", local: true }]
          : [],
      hasEarlier: false,
    }),
    discoverSessionId: () => ({ cancel: () => {} }),
    createHookAttention: () => ({ handle: () => {}, stop: () => {} }),
    readTranscript: () => [],
    readContextUsage: () => null,
    findLatestSessionId: () => "someone-elses-latest",
    findLiveSessionId: () => state.live,
    shownSessionId: () => state.shown,
    buildResumeCommand: () => "x",
  }),
}));

const { ProcessManager } = await import("./process-manager");

const BILLING: SavedContact = {
  id: "a",
  cwd: "/p/billing",
  alias: "Billing",
  backend: "claude",
  sessionId: "s-a",
};

beforeEach(() => {
  state.saved = [];
  state.spawns = [];
  state.conversations = new Set();
  state.forks = [];
  state.localOnly = new Set();
  state.shown = null;
  state.live = null;
  state.refuse = false;
  state.forkResult = async (sessionId) => ({ kind: "fork", fromSessionId: sessionId });
});

describe("canFork", () => {
  it("is true only for the contact's own session with a conversation in it", () => {
    state.saved = [{ ...BILLING }, { id: "b", cwd: "/p/billing", backend: "claude" }];
    state.conversations.add("claude:s-a");
    state.conversations.add("claude:someone-elses-latest");
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    expect(pm.canFork("a")).toBe(true);
    // No session of its own: the directory's latest is someone else's.
    expect(pm.canFork("b")).toBe(false);
    expect(pm.canFork("nobody")).toBe(false);
  });

  it("is false for a session holding only the /clear it opened with", () => {
    state.saved = [{ ...BILLING }];
    state.localOnly.add("claude:s-a");
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    expect(pm.canFork("a")).toBe(false);
  });

  it("is false for an own session nobody has typed in yet", () => {
    state.saved = [{ ...BILLING }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    expect(pm.canFork("a")).toBe(false);
  });
});

describe("forkInstance", () => {
  it("starts a copy of a stopped contact's session as a new contact at the top", async () => {
    state.saved = [{ ...BILLING }, { id: "z", cwd: "/p/z", backend: "claude" }];
    state.conversations.add("claude:s-a");
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const copy = await pm.forkInstance("a");

    expect(state.forks).toEqual(["claude:s-a"]);
    expect(state.spawns).toEqual([
      { backend: "claude", cwd: "/p/billing", session: { kind: "fork", fromSessionId: "s-a" } },
    ]);
    expect(copy.name).toBe("Billing 2");
    expect(copy.backend).toBe("claude");
    expect(state.saved.map((c) => c.id)).toEqual([copy.id, "a", "z"]);
    // The source keeps its own session and stays stopped.
    expect(state.saved.find((c) => c.id === "a")?.sessionId).toBe("s-a");
    expect(pm.infoOf("a")?.status).toBe("stopped");
  });

  it("forks the session a running contact shows now", async () => {
    state.saved = [{ ...BILLING }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    pm.startInstance("a");
    state.conversations.add("claude:s-a");

    await pm.forkInstance("a");

    expect(state.forks).toEqual(["claude:s-a"]);
    expect(pm.infoOf("a")?.status).toBe("running");
  });

  it("opens an OpenCode copy, named by the service, as the new contact's own", async () => {
    state.saved = [{ ...BILLING, backend: "opencode", sessionId: "ses_a" }];
    state.conversations.add("opencode:ses_a");
    state.forkResult = async () => ({ kind: "own", sessionId: "ses_copy" });
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const copy = await pm.forkInstance("a");

    expect(state.spawns[0]).toMatchObject({ backend: "opencode", session: { kind: "own", sessionId: "ses_copy" } });
    expect(state.saved.find((c) => c.id === copy.id)?.sessionId).toBe("ses_copy");
  });

  it("makes no contact when there is nothing to fork, or the fork fails", async () => {
    state.saved = [{ ...BILLING }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    await expect(pm.forkInstance("a")).rejects.toThrow("no conversation to fork");
    state.conversations.add("claude:s-a");
    state.forkResult = async () => {
      throw new Error("OpenCode's background service didn't fork the session.");
    };
    await expect(pm.forkInstance("a")).rejects.toThrow("didn't fork");
    await expect(pm.forkInstance("nobody")).rejects.toThrow();
    expect(state.spawns).toEqual([]);
    expect(state.saved.map((c) => c.id)).toEqual(["a"]);
  });

  it("forks the session the CLI says it is on, not one it just left", async () => {
    state.saved = [{ ...BILLING }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    pm.startInstance("a");
    // `/resume` moved it before the next poll; the old one has a conversation too.
    state.conversations.add("claude:s-a");
    state.conversations.add("claude:s-new");
    state.shown = "s-new";

    await pm.forkInstance("a");

    expect(state.forks).toEqual(["claude:s-new"]);
  });

  it("never forks a session guessed from the directory, and changes nothing on the contact", async () => {
    state.saved = [{ ...BILLING }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    pm.startInstance("a");
    // Its own record can't be read this moment; the directory has another
    // terminal's session the poll's fallback would pick.
    state.conversations.add("claude:s-a");
    state.conversations.add("claude:standalone");
    state.shown = null;
    state.live = "standalone";

    expect(pm.canFork("a")).toBe(true);
    await pm.forkInstance("a");

    expect(state.forks).toEqual(["claude:s-a"]);
    expect(pm.infoOf("a")?.sessionId).toBe("s-a");
  });

  it("makes no contact when the CLI refuses the fork at launch", async () => {
    state.saved = [{ ...BILLING }];
    state.conversations.add("claude:s-a");
    state.refuse = true;
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    await expect(pm.forkInstance("a")).rejects.toThrow("gone");
    expect(state.saved.map((c) => c.id)).toEqual(["a"]);
  });

  it("keeps an OpenCode copy as a stopped contact when its start is refused", async () => {
    state.saved = [{ ...BILLING, backend: "opencode", sessionId: "ses_a" }];
    state.conversations.add("opencode:ses_a");
    state.forkResult = async () => ({ kind: "own", sessionId: "ses_copy" });
    state.refuse = true;
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const copy = await pm.forkInstance("a");

    expect(copy.status).toBe("stopped");
    expect(copy.startError).toMatch(/gone|refused|fork/);
    expect(state.saved.find((c) => c.id === copy.id)?.sessionId).toBe("ses_copy");
  });

  it("still gives the copy a contact when the source is removed while the fork runs", async () => {
    state.saved = [{ ...BILLING }];
    state.conversations.add("claude:s-a");
    let release!: () => void;
    state.forkResult = (sessionId) =>
      new Promise((resolve) => {
        release = () => resolve({ kind: "fork", fromSessionId: sessionId });
      });
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const forking = pm.forkInstance("a");
    pm.removeInstance("a");
    release();

    const copy = await forking;
    expect(copy.name).toBe("Billing 2");
    expect(state.saved.map((c) => c.id)).toEqual([copy.id]);
  });
});

describe("duplicateInstance with the other tool", () => {
  it("starts a fresh session on the backend named, on the same project", () => {
    state.saved = [{ ...BILLING }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();

    const copy = pm.duplicateInstance("a", "opencode");

    expect(state.spawns).toEqual([
      { backend: "opencode", cwd: "/p/billing", session: { kind: "fresh" } },
    ]);
    expect(copy?.backend).toBe("opencode");
    expect(copy?.name).toBe("Billing 2");
    expect(state.saved.find((c) => c.id === copy?.id)?.backend).toBe("opencode");
  });

  it("stays on the source's backend when none is named", () => {
    state.saved = [{ ...BILLING, backend: "opencode" }];
    const pm = new ProcessManager();
    pm.loadSavedContacts();
    expect(pm.duplicateInstance("a")?.backend).toBe("opencode");
  });
});
