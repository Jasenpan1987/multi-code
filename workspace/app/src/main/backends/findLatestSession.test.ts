// Finding the session a directory last worked on, from what is on disk.
//
// This is the lookup that makes a *stopped* instance readable. A stopped contact has
// no session id in memory at all after an app restart — contacts.json doesn't store
// one — so before this existed the manager could not read the history of any session
// it hadn't personally watched run, and every stopped contact showed
// `context=unknown`.
//
// better-sqlite3 is mocked rather than loaded, for the same reason as
// contextUsage.test.ts: the installed build targets Electron's ABI and won't require
// under plain-node vitest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

interface SessionRow {
  id: string;
  directory: string;
  time_created: number;
}

const mocks = vi.hoisted(() => ({
  stores: new Map<string, SessionRow[]>(),
}));

vi.mock("better-sqlite3", () => {
  class FakeStatement {
    constructor(
      private readonly sql: string,
      private readonly rows: SessionRow[]
    ) {}

    all(...args: unknown[]) {
      if (
        this.sql.includes("SELECT id, directory FROM session") &&
        this.sql.includes("ORDER BY time_created DESC")
      ) {
        const [cwd, resolved] = args as [string, string];
        return this.rows
          .filter((r) => r.directory === cwd || r.directory === resolved)
          .sort((a, b) => b.time_created - a.time_created)
          .slice(0, 8)
          .map((r) => ({ id: r.id, directory: r.directory }));
      }
      throw new Error(`unhandled .all() SQL in fake: ${this.sql}`);
    }
  }

  class FakeDatabase {
    private readonly rows: SessionRow[];
    constructor(dbPath: string | Buffer) {
      const key = String(dbPath);
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

const { findLatestJsonlSessionId, encodeProjectDir } = await import("./claude");
const { findLatestSessionForCwd } = await import("./opencode");

// ---------------------------------------------------------------- claude

let projectsRoot = "";

beforeEach(() => {
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-projects-"));
});

afterEach(() => {
  fs.rmSync(projectsRoot, { recursive: true, force: true });
  mocks.stores.clear();
});

// Writes a transcript for `cwd` with an explicit mtime, since mtime is what decides
// which session is the most recent.
function writeTranscript(cwd: string, sessionId: string, mtimeMs: number) {
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '{"type":"user"}\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("claude: findLatestJsonlSessionId", () => {
  const cwd = "/Users/x/code/msk";

  it("finds the only session in a directory", () => {
    writeTranscript(cwd, "ses-only", Date.now());
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-only");
  });

  // mtime, not creation order or filename: a session's transcript is touched on
  // every turn, so the most recently written one is the most recently worked in.
  it("picks the most recently written of several", () => {
    const now = Date.now();
    writeTranscript(cwd, "ses-old", now - 200_000);
    writeTranscript(cwd, "ses-newest", now);
    writeTranscript(cwd, "ses-middle", now - 100_000);
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-newest");
  });

  it("returns null for a directory that has never been used", () => {
    expect(findLatestJsonlSessionId("/Users/x/code/never", projectsRoot)).toBe(
      null
    );
  });

  it("returns null for a project directory with no transcripts in it", () => {
    fs.mkdirSync(path.join(projectsRoot, encodeProjectDir(cwd)), {
      recursive: true,
    });
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe(null);
  });

  it("ignores files that are not transcripts", () => {
    const dir = path.join(projectsRoot, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.md"), "hello");
    fs.writeFileSync(path.join(dir, ".DS_Store"), "");
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe(null);
  });

  it("keeps transcripts of different directories apart", () => {
    const other = "/Users/x/code/other";
    writeTranscript(cwd, "ses-msk", Date.now());
    writeTranscript(other, "ses-other", Date.now());
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-msk");
    expect(findLatestJsonlSessionId(other, projectsRoot)).toBe("ses-other");
  });

  it("does not throw when the projects root itself is missing", () => {
    expect(findLatestJsonlSessionId(cwd, "/nope/not/here")).toBe(null);
  });
});

// ---------------------------------------------------------------- opencode

describe("opencode: findLatestSessionForCwd", () => {
  const dbPath = "/tmp/fake-opencode.db";
  const cwd = "/Users/x/code/api";

  function seed(...rows: SessionRow[]) {
    mocks.stores.set(dbPath, rows);
  }

  it("finds the newest session for the directory", () => {
    seed(
      { id: "s-old", directory: cwd, time_created: 1000 },
      { id: "s-new", directory: cwd, time_created: 9000 }
    );
    expect(findLatestSessionForCwd(cwd, undefined, dbPath)).toBe("s-new");
  });

  it("returns null when the directory has no sessions", () => {
    seed({ id: "s-elsewhere", directory: "/Users/x/code/nope", time_created: 1 });
    expect(findLatestSessionForCwd(cwd, undefined, dbPath)).toBe(null);
  });

  // The read path wants the directory's newest session whether or not a running
  // instance already owns it — unlike discovery, which must skip claimed ids.
  it("returns a session even when something else claims it", () => {
    seed({ id: "s-claimed", directory: cwd, time_created: 5 });
    expect(findLatestSessionForCwd(cwd, undefined, dbPath)).toBe("s-claimed");
  });

  it("still honours a claim filter when one is passed", () => {
    seed(
      { id: "s-claimed", directory: cwd, time_created: 9000 },
      { id: "s-free", directory: cwd, time_created: 1000 }
    );
    expect(
      findLatestSessionForCwd(cwd, (id) => id === "s-claimed", dbPath)
    ).toBe("s-free");
  });

  it("returns null rather than throwing when the database is unreadable", () => {
    expect(
      findLatestSessionForCwd(cwd, undefined, "/tmp/does-not-exist.db")
    ).toBe(null);
  });
});
