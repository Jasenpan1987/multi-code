// Tests for reading how full a session's context window is, on both backends.
//
// The property that matters most: the figure must be the *input* side of a single
// turn. Both CLIs also publish a pre-summed total that includes output, and
// lifetime cumulative counters that reach millions of tokens. Either would look
// plausible in a UI and be wrong — the total by a little, the cumulative by two
// orders of magnitude.
//
// better-sqlite3 is mocked rather than loaded, matching opencodeDetect.test.ts:
// the installed build targets Electron's ABI, so requiring it under plain-node
// vitest fails. The fake implements only the one statement this reader issues.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

interface MessageRow {
  session_id: string;
  time_updated: number;
  data: string;
}

const mocks = vi.hoisted(() => ({
  stores: new Map<string, MessageRow[]>(),
}));

vi.mock("better-sqlite3", () => {
  class FakeStatement {
    constructor(
      private readonly sql: string,
      private readonly rows: MessageRow[]
    ) {}

    all(...args: unknown[]) {
      if (
        this.sql.includes("SELECT data, time_updated FROM message") &&
        this.sql.includes("ORDER BY time_updated DESC")
      ) {
        const [sessionId] = args as [string];
        return this.rows
          .filter((r) => r.session_id === sessionId)
          .sort((a, b) => b.time_updated - a.time_updated)
          .slice(0, 40)
          .map((r) => ({ data: r.data, time_updated: r.time_updated }));
      }
      throw new Error(`unhandled .all() SQL in fake: ${this.sql}`);
    }
  }

  class FakeDatabase {
    private readonly rows: MessageRow[];
    constructor(dbPath: string | Buffer) {
      const key = String(dbPath);
      // Stands in for better-sqlite3's `fileMustExist: true`, which the reader
      // relies on to fail rather than create an empty database.
      if (key.includes("does-not-exist")) {
        throw new Error("unable to open database file");
      }
      let rows = mocks.stores.get(key);
      if (!rows) {
        rows = [];
        mocks.stores.set(key, rows);
      }
      this.rows = rows;
    }
    prepare(sql: string) {
      return new FakeStatement(sql, this.rows);
    }
    close() {}
  }

  return { default: FakeDatabase };
});

const { readClaudeContextUsage } = await import("./claude");
const { readOpencodeContextUsage } = await import("./opencode");

// ---------------------------------------------------------------- claude

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-ctx-"));
const written: string[] = [];

afterEach(() => {
  for (const f of written.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {
      // already gone
    }
  }
});

function writeJsonl(...records: unknown[]): string {
  const file = path.join(tmpDir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  written.push(file);
  return file;
}

function assistant(
  usage: Record<string, number>,
  opts: { model?: string; timestamp?: string } = {}
) {
  const message: Record<string, unknown> = { usage };
  if (opts.model !== undefined) message.model = opts.model;
  return {
    type: "assistant",
    message,
    timestamp: opts.timestamp ?? "2026-09-01T00:00:01.000Z",
  };
}

const userTurn = {
  type: "user",
  message: { content: "hello" },
  timestamp: "2026-09-01T00:00:00.000Z",
};

describe("readClaudeContextUsage", () => {
  it("sums the three input fields and excludes output", () => {
    const file = writeJsonl(
      userTurn,
      assistant(
        {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 5000,
        },
        { model: "claude-opus-5" }
      )
    );
    expect(readClaudeContextUsage(file)).toEqual({
      inputTokens: 330,
      updatedAt: Date.parse("2026-09-01T00:00:01.000Z"),
      model: "claude-opus-5",
    });
  });

  it("reads the newest assistant turn, not the first", () => {
    const file = writeJsonl(
      assistant({ input_tokens: 1, cache_read_input_tokens: 99 }),
      userTurn,
      assistant({ input_tokens: 2, cache_read_input_tokens: 4000 })
    );
    expect(readClaudeContextUsage(file)?.inputTokens).toBe(4002);
  });

  it("walks back past an assistant turn with no usage", () => {
    const file = writeJsonl(
      assistant({ input_tokens: 5, cache_read_input_tokens: 500 }),
      { type: "assistant", message: { model: "x" }, timestamp: "2026-09-01T01:00:00.000Z" }
    );
    expect(readClaudeContextUsage(file)?.inputTokens).toBe(505);
  });

  it("walks back past an all-zero turn, which says nothing about fullness", () => {
    const file = writeJsonl(
      assistant({ input_tokens: 7, cache_read_input_tokens: 700 }),
      assistant({
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      })
    );
    expect(readClaudeContextUsage(file)?.inputTokens).toBe(707);
  });

  it("returns null when the session has no assistant turn yet", () => {
    // Distinct from zero on purpose: a fresh session's usage is unknown, and
    // rendering 0 would read as "plenty of room".
    expect(readClaudeContextUsage(writeJsonl(userTurn))).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(readClaudeContextUsage(path.join(tmpDir, "nope.jsonl"))).toBeNull();
  });

  it("returns null for an empty file", () => {
    const file = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(file, "");
    written.push(file);
    expect(readClaudeContextUsage(file)).toBeNull();
  });

  it("skips malformed lines", () => {
    const file = path.join(tmpDir, "broken.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify(assistant({ input_tokens: 3, cache_read_input_tokens: 30 })) +
        "\n{not json\n"
    );
    written.push(file);
    expect(readClaudeContextUsage(file)?.inputTokens).toBe(33);
  });

  it("omits model when the record didn't name one", () => {
    const file = writeJsonl(assistant({ input_tokens: 100 }));
    expect(readClaudeContextUsage(file)?.model).toBeUndefined();
  });

  it("reports updatedAt 0 rather than now when the timestamp is unusable", () => {
    const file = writeJsonl({
      type: "assistant",
      message: { usage: { input_tokens: 50 } },
      timestamp: "not-a-date",
    });
    expect(readClaudeContextUsage(file)?.updatedAt).toBe(0);
  });

  it("tolerates non-numeric usage values", () => {
    const file = writeJsonl({
      type: "assistant",
      message: { usage: { input_tokens: "12", cache_read_input_tokens: 88 } },
      timestamp: "2026-09-01T00:00:01.000Z",
    });
    expect(readClaudeContextUsage(file)?.inputTokens).toBe(88);
  });
});

// -------------------------------------------------------------- opencode

let dbSeq = 0;
// `data` is excluded from the Partial before being re-declared as unknown:
// intersecting `data?: string` with `data: unknown` collapses back to string, so
// callers couldn't pass the message object they actually want to store.
function seedDb(
  rows: Array<Partial<Omit<MessageRow, "data">> & { data: unknown }>
): string {
  const dbPath = `/fake/opencode-${dbSeq++}.db`;
  mocks.stores.set(
    dbPath,
    rows.map((r, i) => ({
      session_id: r.session_id ?? "s1",
      time_updated: r.time_updated ?? 1000 + i,
      data: typeof r.data === "string" ? r.data : JSON.stringify(r.data),
    }))
  );
  return dbPath;
}

function ocAssistant(
  tokens: Record<string, unknown>,
  opts: { modelID?: string } = {}
) {
  const msg: Record<string, unknown> = { role: "assistant", tokens };
  if (opts.modelID !== undefined) msg.modelID = opts.modelID;
  return msg;
}

describe("readOpencodeContextUsage", () => {
  it("sums input plus both cache sides, ignoring the pre-summed total", () => {
    // total is deliberately absurd here: if the reader used it, this test fails.
    const dbPath = seedDb([
      {
        time_updated: 5000,
        data: ocAssistant(
          {
            total: 999999,
            input: 10,
            output: 7,
            reasoning: 0,
            cache: { read: 300, write: 20 },
          },
          { modelID: "gpt-5.6-sol" }
        ),
      },
    ]);
    expect(readOpencodeContextUsage("s1", dbPath)).toEqual({
      inputTokens: 330,
      updatedAt: 5000,
      model: "gpt-5.6-sol",
    });
  });

  it("walks back past the trailing user message", () => {
    // Observed on the real store: the newest row is routinely a user message
    // with no tokens at all, so LIMIT 1 would report nothing.
    const dbPath = seedDb([
      { time_updated: 9000, data: { role: "user" } },
      {
        time_updated: 8000,
        data: ocAssistant({ input: 5, cache: { read: 1000, write: 0 } }),
      },
    ]);
    expect(readOpencodeContextUsage("s1", dbPath)?.inputTokens).toBe(1005);
  });

  it("takes the newest assistant message", () => {
    const dbPath = seedDb([
      { time_updated: 100, data: ocAssistant({ input: 1, cache: { read: 1 } }) },
      { time_updated: 900, data: ocAssistant({ input: 2, cache: { read: 4000 } }) },
    ]);
    expect(readOpencodeContextUsage("s1", dbPath)?.inputTokens).toBe(4002);
  });

  it("ignores messages from other sessions", () => {
    const dbPath = seedDb([
      {
        session_id: "other",
        time_updated: 9999,
        data: ocAssistant({ input: 500000, cache: { read: 0 } }),
      },
      {
        session_id: "s1",
        time_updated: 100,
        data: ocAssistant({ input: 42, cache: { read: 0 } }),
      },
    ]);
    expect(readOpencodeContextUsage("s1", dbPath)?.inputTokens).toBe(42);
  });

  it("returns null for a session with no assistant message", () => {
    const dbPath = seedDb([{ data: { role: "user" } }]);
    expect(readOpencodeContextUsage("s1", dbPath)).toBeNull();
  });

  it("returns null for an unknown session", () => {
    const dbPath = seedDb([
      { data: ocAssistant({ input: 10, cache: { read: 10 } }) },
    ]);
    expect(readOpencodeContextUsage("no-such-session", dbPath)).toBeNull();
  });

  it("returns null when the database can't be opened", () => {
    expect(readOpencodeContextUsage("s1", "/fake/does-not-exist.db")).toBeNull();
  });

  it("skips a message whose data isn't valid JSON", () => {
    const dbPath = seedDb([
      { time_updated: 200, data: "{not json" },
      {
        time_updated: 100,
        data: ocAssistant({ input: 3, cache: { read: 30 } }),
      },
    ]);
    expect(readOpencodeContextUsage("s1", dbPath)?.inputTokens).toBe(33);
  });

  it("tolerates a missing cache object", () => {
    const dbPath = seedDb([{ data: ocAssistant({ input: 77 }) }]);
    expect(readOpencodeContextUsage("s1", dbPath)?.inputTokens).toBe(77);
  });

  it("walks back past an all-zero turn", () => {
    const dbPath = seedDb([
      {
        time_updated: 100,
        data: ocAssistant({ input: 9, cache: { read: 90 } }),
      },
      {
        time_updated: 200,
        data: ocAssistant({ input: 0, output: 0, cache: { read: 0, write: 0 } }),
      },
    ]);
    expect(readOpencodeContextUsage("s1", dbPath)?.inputTokens).toBe(99);
  });

  it("omits model when the message didn't name one", () => {
    const dbPath = seedDb([{ data: ocAssistant({ input: 60 }) }]);
    expect(readOpencodeContextUsage("s1", dbPath)?.model).toBeUndefined();
  });
});
