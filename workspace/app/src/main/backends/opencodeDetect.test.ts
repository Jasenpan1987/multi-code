// Tests for the OpenCode completion/prompt detector.
//
// The important property under test: OpenCode inserts a message row when
// streaming starts (finish unset) and UPDATEs it in place — `finish: "stop"`
// only exists after time_updated moves. A detector that watermarks on
// time_created reads every row once, before its final state exists, and the
// completion notification never fires. These tests pin the time_updated
// behavior down so that regression can't silently return.
//
// better-sqlite3 is mocked rather than loaded: the installed build targets
// Electron's ABI, so requiring it under plain-node vitest would fail, and a
// test that only runs after a native rebuild is one nobody runs. The mock
// implements exactly the statements the detector issues — it is deliberately
// not a general SQL engine.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpencodeCompletionDetector } from "./opencode";

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}
interface PartRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

// Shared between the mock factory (hoisted above the imports it serves) and
// the test body. One store per db path, so the harness and the detector's own
// `openDb(dbPath)` see the same rows.
const mocks = vi.hoisted(() => ({
  stores: new Map<string, { messages: MessageRow[]; parts: PartRow[] }>(),
}));

vi.mock("better-sqlite3", () => {
  class FakeStatement {
    constructor(
      private readonly sql: string,
      private readonly store: { messages: MessageRow[]; parts: PartRow[] }
    ) {}

    all(...args: unknown[]) {
      if (this.sql.includes("SELECT id, time_created, time_updated, data FROM message")) {
        const [sessionId, after] = args as [string, number];
        return this.store.messages
          .filter((m) => m.session_id === sessionId && m.time_updated > after)
          .sort((a, b) => a.time_updated - b.time_updated)
          .map((m) => ({
            id: m.id,
            time_created: m.time_created,
            time_updated: m.time_updated,
            data: m.data,
          }));
      }
      if (this.sql.includes("SELECT data FROM part")) {
        const [sessionId] = args as [string];
        return this.store.parts
          .filter((p) => p.session_id === sessionId)
          .sort((a, b) => b.time_created - a.time_created)
          .slice(0, 60)
          .map((p) => ({ data: p.data }));
      }
      throw new Error(`unhandled .all() SQL in fake: ${this.sql}`);
    }

    get(...args: unknown[]) {
      if (this.sql.includes("SELECT MAX(time_updated)")) {
        const [sessionId] = args as [string];
        const inSession = this.store.messages.filter(
          (m) => m.session_id === sessionId
        );
        const updated = inSession.reduce(
          (acc, m) => Math.max(acc, m.time_updated),
          0
        );
        const created = inSession.reduce(
          (acc, m) => Math.max(acc, m.time_created),
          0
        );
        return { t: updated || null, c: created || null };
      }
      throw new Error(`unhandled .get() SQL in fake: ${this.sql}`);
    }
  }

  class FakeDatabase {
    private readonly store: { messages: MessageRow[]; parts: PartRow[] };
    constructor(dbPath: string | Buffer) {
      const key = String(dbPath);
      let store = mocks.stores.get(key);
      if (!store) {
        store = { messages: [], parts: [] };
        mocks.stores.set(key, store);
      }
      this.store = store;
    }
    prepare(sql: string) {
      return new FakeStatement(sql, this.store);
    }
    close() {}
  }

  return { default: FakeDatabase };
});

interface Harness {
  dbPath: string;
  events: string[];
  detector: OpencodeCompletionDetector;
  insertMessage(params: {
    id: string;
    role: string;
    finish?: string;
    created: number;
    updated: number;
  }): void;
  updateMessage(params: {
    id: string;
    role: string;
    finish?: string;
    updated: number;
  }): void;
  insertRunningToolPart(params: {
    id: string;
    tool: string;
    created: number;
  }): void;
  completeToolPart(id: string, tool: string): void;
}

const SESSION = "ses-test-1";

function makeHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-detect-"));
  const dbPath = path.join(dir, "scratch.db");

  const events: string[] = [];
  // Constructing the detector opens the db through the mocked Database, which
  // registers the store for this path; the harness helpers then reach the
  // rows directly.
  const detector = new OpencodeCompletionDetector(
    SESSION,
    (type) => {
      events.push(type);
    },
    dbPath
  );
  const store = mocks.stores.get(dbPath);
  if (!store) throw new Error("detector did not open the scratch db");

  return {
    dbPath,
    events,
    detector,
    insertMessage({ id, role, finish, created, updated }) {
      const data: Record<string, unknown> = { role };
      if (finish !== undefined) data.finish = finish;
      store.messages.push({
        id,
        session_id: SESSION,
        time_created: created,
        time_updated: updated,
        data: JSON.stringify(data),
      });
    },
    updateMessage({ id, role, finish, updated }) {
      const data: Record<string, unknown> = { role };
      if (finish !== undefined) data.finish = finish;
      const row = store.messages.find((m) => m.id === id);
      if (!row) throw new Error(`no message ${id}`);
      row.time_updated = updated;
      row.data = JSON.stringify(data);
    },
    insertRunningToolPart({ id, tool, created }) {
      store.parts.push({
        id,
        session_id: SESSION,
        time_created: created,
        data: JSON.stringify({ type: "tool", tool, state: { status: "running" } }),
      });
    },
    completeToolPart(id, tool) {
      const row = store.parts.find((p) => p.id === id);
      if (!row) throw new Error(`no part ${id}`);
      row.data = JSON.stringify({ type: "tool", tool, state: { status: "completed" } });
    },
  };
}

function dialogText(subject: string): string {
  return `Permission required\n${subject}\nAllow once Allow always Reject`;
}

describe("OpencodeCompletionDetector completion detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.stores.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires 'waiting' when finish becomes 'stop' via an in-place update", () => {
    const h = makeHarness();
    // Row appears while streaming: finish unset, like OpenCode inserts it.
    h.insertMessage({ id: "m1", role: "assistant", created: 1000, updated: 1000 });

    vi.advanceTimersByTime(500);
    expect(h.events).toEqual([]);

    // The final state lands later as an UPDATE — time_created stays 1000,
    // only time_updated moves. A time_created watermark would never see this.
    h.updateMessage({ id: "m1", role: "assistant", finish: "stop", updated: 5000 });

    vi.advanceTimersByTime(500);
    expect(h.events).toEqual([]); // debounce not elapsed yet

    vi.advanceTimersByTime(2000);
    expect(h.events).toContain("waiting");

    h.detector.stop();
  });

  it("does not re-fire when a completed row is updated again (cost/tokens)", () => {
    const h = makeHarness();
    h.insertMessage({
      id: "m1",
      role: "assistant",
      finish: "stop",
      created: 1000,
      updated: 1000,
    });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(2000);
    expect(h.events).toContain("waiting");

    // OpenCode keeps bumping the row as cost/token counts settle. Each bump
    // re-delivers the row to the detector; the notify must fire only once.
    h.updateMessage({ id: "m1", role: "assistant", finish: "stop", updated: 8000 });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(2000);
    expect(h.events).toEqual(["waiting"]);

    h.detector.stop();
  });

  it("'tool-calls' finish never notifies", () => {
    const h = makeHarness();
    h.insertMessage({
      id: "m1",
      role: "assistant",
      finish: "tool-calls",
      created: 1000,
      updated: 1000,
    });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(4000);
    expect(h.events).toEqual([]);

    h.detector.stop();
  });

  it("cancels a pending notify when a user message appears, but only on first sight", () => {
    const h = makeHarness();
    // Assistant finishes — notify armed (2s debounce).
    h.insertMessage({ id: "m1", role: "assistant", finish: "stop", created: 1000, updated: 1000 });
    vi.advanceTimersByTime(500);
    // User types before the debounce elapses — notify cancelled.
    h.insertMessage({ id: "u1", role: "user", created: 2000, updated: 2000 });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(4000);
    expect(h.events).toEqual([]);

    // A later assistant stop arms again…
    h.insertMessage({ id: "m2", role: "assistant", finish: "stop", created: 7000, updated: 7000 });
    vi.advanceTimersByTime(500);
    // …and a late in-place update to the OLD user row must not cancel it.
    h.updateMessage({ id: "u1", role: "user", updated: 8000 });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(2000);
    expect(h.events).toEqual(["waiting"]);

    h.detector.stop();
  });

  it("ignores rows that finished before the detector attached", () => {
    const h = makeHarness();
    // Pre-existing completed turn — must not beep on startup.
    h.insertMessage({ id: "m0", role: "assistant", finish: "stop", created: 10, updated: 10 });
    const events: string[] = [];
    const late = new OpencodeCompletionDetector(
      SESSION,
      (type) => {
        events.push(type);
      },
      h.dbPath
    );
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(4000);
    expect(events).toEqual([]);

    late.stop();
    h.detector.stop();
  });

  it("does not let a late update to a pre-attach user row cancel the completion notify", () => {
    const h = makeHarness();
    // The user typed before discovery attached (asking a question right
    // after starting the instance): both rows already exist when the
    // detector starts, so the user row was never seen as a "user action".
    h.insertMessage({ id: "u1", role: "user", created: 1000, updated: 1000 });
    h.insertMessage({ id: "m1", role: "assistant", created: 1100, updated: 1100 });

    const events: string[] = [];
    const late = new OpencodeCompletionDetector(
      SESSION,
      (type) => {
        events.push(type);
      },
      h.dbPath
    );
    vi.advanceTimersByTime(500);

    // The turn completes via an in-place update…
    h.updateMessage({ id: "m1", role: "assistant", finish: "stop", updated: 5000 });
    vi.advanceTimersByTime(500);
    // …and only afterwards does OpenCode bump the OLD user row's bookkeeping
    // (cost/tokens). That late update must NOT count as a fresh user action,
    // or it would swallow the pending "waiting" notify.
    h.updateMessage({ id: "u1", role: "user", updated: 6000 });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(2000);
    expect(events).toEqual(["waiting"]);

    late.stop();
    h.detector.stop();
  });
});

describe("OpencodeCompletionDetector permission prompt detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.stores.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires 'prompt' for a permission dialog after it settles", () => {
    const h = makeHarness();
    // A tool in flight is what keeps the dialog latched.
    h.insertRunningToolPart({ id: "p1", tool: "bash", created: 1000 });

    h.detector.onPtyData(dialogText("Access external directory /tmp"));
    vi.advanceTimersByTime(500); // latch observed
    vi.advanceTimersByTime(3500); // settle delay passes
    expect(h.events).toEqual(["prompt"]);

    // Spinner repaints of the same dialog must not re-fire.
    h.detector.onPtyData(dialogText("Access external directory /tmp"));
    vi.advanceTimersByTime(4000);
    expect(h.events).toEqual(["prompt"]);

    h.detector.stop();
  });

  it("fires again for a second dialog raised while tools never went idle", () => {
    const h = makeHarness();
    h.insertRunningToolPart({ id: "p1", tool: "bash", created: 1000 });

    h.detector.onPtyData(dialogText("Access external directory /tmp"));
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(3500);
    expect(h.events).toEqual(["prompt"]);

    // The user answered, but the released tool is still running, so the
    // in-flight condition that clears the latch never goes false. A second,
    // different dialog must still be reported.
    h.detector.onPtyData(dialogText("Run shell command: rm -rf build"));
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(3500);
    expect(h.events).toEqual(["prompt", "prompt"]);

    h.detector.stop();
  });

  it("emits 'prompt-cleared' once the blocking tool leaves 'running'", () => {
    const h = makeHarness();
    h.insertRunningToolPart({ id: "p1", tool: "bash", created: 1000 });

    h.detector.onPtyData(dialogText("Access external directory /tmp"));
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(3500);
    expect(h.events).toEqual(["prompt"]);

    // Answering releases the tool: its part row leaves "running".
    h.completeToolPart("p1", "bash");
    vi.advanceTimersByTime(500);
    expect(h.events).toEqual(["prompt", "prompt-cleared"]);

    h.detector.stop();
  });
});
