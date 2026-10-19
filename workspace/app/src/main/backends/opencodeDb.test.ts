// OpenCode 2's records, read from a real SQLite file in the 2.x layout.
//
// The fixture database is built here, per run, with the DDL of the three tables the
// readers touch, copied from OpenCode 2.0.32 (`packages/core/src/database/schema.gen.ts`,
// identical to `.schema` of the builder's own database). Its rows follow
// `packages/schema/src/session-message.ts` and cover both vocabularies: a session
// written natively by 2.x, and one carried over by the 1.x migration, which keeps the
// old tool names and keys. Nothing here reads the real HOME: every call names its
// database and config paths. The last block is an opt-in smoke run against the
// builder's real database (OPENCODE_DB_SMOKE=1), skipped by default.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import {
  BUILDER_TURN_SCAN_MESSAGES,
  latestRootSession,
  opencodeConfigPaths,
  opencodeDbPath,
  opencodeSessionExists,
  readOpencodeBuilderTurn,
  readOpencodeContextUsage,
  readOpencodeContextWindow,
  readOpencodeTranscript,
  stripJsonc,
  summarizeOpencodeTool,
} from "./opencodeDb";

// ---------------------------------------------------------------- fixture builder

const DDL = [
  `CREATE TABLE \`session_v2\` (
    \`id\` text PRIMARY KEY,
    \`project_id\` text NOT NULL,
    \`workspace_id\` text,
    \`parent_id\` text,
    \`fork_session_id\` text,
    \`fork_boundary\` text,
    \`slug\` text NOT NULL,
    \`directory\` text NOT NULL,
    \`path\` text,
    \`title\` text,
    \`version\` text NOT NULL,
    \`share_url\` text,
    \`summary_additions\` integer,
    \`summary_deletions\` integer,
    \`summary_files\` integer,
    \`summary_diffs\` text,
    \`metadata\` text,
    \`cost\` real DEFAULT 0 NOT NULL,
    \`tokens_input\` integer DEFAULT 0 NOT NULL,
    \`tokens_output\` integer DEFAULT 0 NOT NULL,
    \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
    \`revert\` text,
    \`permission\` text,
    \`agent\` text,
    \`model\` text,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`time_idle\` integer,
    \`time_viewed\` integer,
    \`idle_outcome\` text,
    \`time_compacting\` integer,
    \`time_archived\` integer,
    \`time_suspended\` integer,
    \`resume_attempts\` integer DEFAULT 0 NOT NULL,
    CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`session_message\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`type\` text NOT NULL,
    \`seq\` integer NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
  )`,
  `CREATE TABLE \`kv\` (
    \`key\` text PRIMARY KEY,
    \`value\` text NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL
  )`,
  "CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`)",
  "CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`)",
  "CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`)",
  "CREATE INDEX `session_v2_parent_idx` ON `session_v2` (`parent_id`)",
];

// A row's `data` is the message minus `id` and `type`, as OpenCode stores it; a string
// is written as is, which is how a malformed row is made.
interface RowSpec {
  type: string;
  data: Record<string, unknown> | string;
  // `time_updated`; defaults to a value rising with the row's position.
  updated?: number;
}

interface SessionSpec {
  id: string;
  directory: string;
  updated: number;
  parent?: string;
  archived?: number;
  rows?: RowSpec[];
}

function buildDb(
  file: string,
  sessions: SessionSpec[],
  kv: Record<string, { value: unknown; updated: number }> = {}
): string {
  const db = new Database(file);
  // The `project` table the foreign key names isn't part of the fixture; the readers
  // never join it.
  db.pragma("foreign_keys = OFF");
  for (const statement of DDL) db.exec(statement);
  const session = db.prepare(
    "INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, version, " +
      "time_created, time_updated, time_archived) VALUES (?, 'prj_1', ?, ?, ?, '2.0.32', ?, ?, ?)"
  );
  const message = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const spec of sessions) {
    session.run(
      spec.id,
      spec.parent ?? null,
      spec.id.slice(-6),
      spec.directory,
      spec.updated - 1,
      spec.updated,
      spec.archived ?? null
    );
    (spec.rows ?? []).forEach((row, index) => {
      message.run(
        `msg_${spec.id}_${index}`,
        spec.id,
        row.type,
        // Not contiguous, as in OpenCode, and `time_created` deliberately runs the
        // other way: the readers must order by `seq`.
        index * 3 + 1,
        10_000 - index,
        row.updated ?? 20_000 + index,
        typeof row.data === "string" ? row.data : JSON.stringify(row.data)
      );
    });
  }
  const put = db.prepare(
    "INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)"
  );
  for (const [key, entry] of Object.entries(kv)) {
    put.run(key, JSON.stringify(entry.value), entry.updated, entry.updated);
  }
  db.close();
  return file;
}

const MODEL = { id: "claude-opus-4-8", providerID: "anthropic", variant: "default" };
let callCount = 0;

const user = (text: string, extra: Record<string, unknown> = {}): RowSpec => ({
  type: "user",
  data: { text, time: { created: 1 }, ...extra },
});
const injected = (type: string, extra: Record<string, unknown>): RowSpec => ({
  type,
  data: { time: { created: 1 }, ...extra },
});
const assistant = (
  content: unknown[],
  extra: Record<string, unknown> = {},
  updated?: number
): RowSpec => ({
  type: "assistant",
  data: { agent: "build", model: MODEL, content, time: { created: 1 }, ...extra },
  updated,
});
const text = (t: string) => ({ type: "text", text: t });
const reasoning = (t: string) => ({ type: "reasoning", text: t });
const tool = (
  name: string,
  input: Record<string, unknown> | string,
  status: "streaming" | "running" | "completed" | "error" = "completed"
) => {
  const state =
    status === "streaming"
      ? { status, input: typeof input === "string" ? input : JSON.stringify(input) }
      : status === "running"
        ? { status, input, metadata: {} }
        : status === "error"
          ? { status, input, error: { type: "tool.execution", message: "boom" } }
          : { status, input, content: [{ type: "text", text: "tool output that is never shown" }] };
  return { type: "tool", id: `call_${++callCount}`, name, state, time: { created: 1 } };
};
const tokens = (input: number, read: number, write: number) => ({
  input,
  output: 999,
  reasoning: 77,
  cache: { read, write },
});
const compaction = (status: "running" | "completed" | "failed"): RowSpec =>
  injected("compaction", {
    status,
    reason: "auto",
    summary: "summary",
    recent: "",
    // The summarising request's own usage, which is not the new window's size.
    tokens: tokens(50_000, 0, 0),
  });

// A pasted image: base64 the readers must never ship to JS.
const IMAGE = {
  mime: "image/png",
  name: "shot.png",
  uri: "data:image/png;base64," + "iVBORw0KGgo".repeat(2000),
};

const PATCH_TEXT = [
  "*** Begin Patch",
  "*** Update File: src/b.ts",
  "@@",
  "-old",
  "+new",
  "*** Add File: src/c.ts",
  "+hello",
  "*** End Patch",
].join("\n");

let dir = "";
let dbFile = "";
let tmpLink = "";
let realTmpDir = "";
let symlinkDir = "";
let symlinkTarget = "";

const NATIVE_DIR = "/repo/native";
const LEGACY_DIR = "/repo/legacy";
const MISSING = () => path.join(dir, "does-not-exist", "opencode.db");
const NO_CONFIG = () => path.join(dir, "no-config", "opencode.json");

// ---------------------------------------------------------------- sessions

const NATIVE: SessionSpec = {
  id: "ses_native",
  directory: NATIVE_DIR,
  updated: 1_000,
  rows: [
    injected("agent-switched", { agent: "build" }),
    user("fix the build", { files: [IMAGE] }),
    injected("synthetic", { text: "<system-reminder>plan mode is active</system-reminder>" }),
    assistant(
      [reasoning("thinking hard"), text("Looking."), tool("shell", { command: "pnpm build" })],
      { tokens: tokens(1_000, 20_000, 300), finish: "tool-calls" }
    ),
    injected("system", { text: "Background job finished", description: "job" }),
    assistant(
      [
        tool("read", { path: "src/a.ts" }),
        tool("edit", { path: "src/a.ts", oldString: "a", newString: "b" }, "error"),
        tool("patch", { patchText: PATCH_TEXT }),
        tool("websearch", { query: "sqlite json_each" }),
        tool("subagent", { agent: "explore", description: "Find callers", prompt: "long prompt" }),
        tool("skill", { id: "deploy" }),
        tool("execute", { code: "\n  const r = await tools.read({ path: 'x' })\nreturn r" }),
        tool("glob", { pattern: "**/*.ts" }),
      ],
      { tokens: tokens(2_000, 30_000, 500), finish: "tool-calls" },
      30_000
    ),
    { type: "shell", data: { shellID: "sh_1", command: "git status", status: "exited", exit: 0, time: { created: 1 } } },
    user("now run the tests"),
    injected("skill", { skill: "testing", name: "testing", text: "skill body" }),
    assistant([
      text("Running them."),
      tool("shell", { command: "pnpm test" }, "running"),
      tool("grep", '{"pattern":"TO', "streaming"),
    ]),
    injected("model-switched", { model: MODEL }),
  ],
};

// Carried over from 1.x: ids kept, tool names and keys kept, and the provider's 1.x id.
const LEGACY: SessionSpec = {
  id: "ses_legacy",
  directory: LEGACY_DIR,
  updated: 900,
  rows: [
    user("migrate this"),
    injected("synthetic", { text: '<system-reminder>Note: The user opened the file "a.ts"</system-reminder>' }),
    assistant(
      [
        tool("bash", { command: "ls -la", description: "List files" }),
        tool("bash", { description: "Only a description" }),
        tool("read", { filePath: "/repo/legacy/a.ts" }),
        tool("write", { filePath: "/repo/legacy/b.ts", content: "x" }),
        tool("apply_patch", { patchText: "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch" }),
        tool("task", { description: "Review code", prompt: "p", subagent_type: "general" }),
        tool("task", { prompt: "only a prompt", subagent_type: "general" }),
        tool("todowrite", { todos: [{ content: "x", status: "pending" }] }),
        tool("skill", { name: "release" }),
        tool("question", { questions: [{ question: "Ship it?", header: "Ship", options: [] }] }, "error"),
        tool("webfetch", { url: "https://example.com" }),
        tool("documonster_doc_inspect", { description: "Inspect the doc" }),
        text("Done."),
      ],
      {
        model: { id: "gpt-legacy", providerID: "azure-cognitive-services", variant: "default" },
        tokens: tokens(100, 4_000, 0),
      }
    ),
    injected("system", { text: "The available tools have changed." }),
  ],
};

// The database's other sessions: what `latestRootSession` must choose between.
function lookupSessions(): SessionSpec[] {
  return [
    // A newer root in the native session's directory.
    { id: "ses_newer_root", directory: NATIVE_DIR, updated: 2_000, rows: [user("hello")] },
    // A subagent of the native session: newest of all, never a contact's.
    { id: "ses_child", directory: NATIVE_DIR, parent: "ses_native", updated: 5_000, rows: [user("sub task")] },
    // Put away by the user.
    { id: "ses_archived", directory: NATIVE_DIR, updated: 6_000, archived: 6_001 },
    // Stored as the physical path, queried through a link to it.
    { id: "ses_symlinked", directory: symlinkTarget, updated: 100 },
  ];
}

function usageSessions(): SessionSpec[] {
  return [
    {
      id: "ses_compacted",
      directory: "/repo/u",
      updated: 1,
      rows: [user("a"), assistant([text("x")], { tokens: tokens(10, 20, 30) }), compaction("completed")],
    },
    {
      id: "ses_after_compaction",
      directory: "/repo/u",
      updated: 1,
      rows: [
        user("a"),
        assistant([text("x")], { tokens: tokens(10, 90_000, 30) }),
        compaction("completed"),
        assistant([text("y")], { tokens: tokens(5, 8_000, 0) }),
      ],
    },
    {
      id: "ses_compaction_pending",
      directory: "/repo/u",
      updated: 1,
      rows: [assistant([text("x")], { tokens: tokens(1, 2, 3) }), compaction("running"), compaction("failed")],
    },
    {
      id: "ses_zero_newest",
      directory: "/repo/u",
      updated: 1,
      rows: [
        assistant([text("x")], { tokens: tokens(7, 0, 0) }),
        assistant([], { tokens: tokens(0, 0, 0), error: { type: "api", message: "boom" } }),
      ],
    },
    {
      id: "ses_no_model",
      directory: "/repo/u",
      updated: 1,
      rows: [{ type: "assistant", data: { agent: "build", content: [], tokens: tokens(3, 0, 0), time: { created: 1 } } }],
    },
    {
      id: "ses_garbled_usage",
      directory: "/repo/u",
      updated: 1,
      rows: [
        assistant([text("y")], { tokens: tokens(11, 0, 0) }),
        assistant([text("x")], { tokens: { input: "lots", cache: null } }),
        { type: "assistant", data: "{not json" },
      ],
    },
    { id: "ses_user_only", directory: "/repo/u", updated: 1, rows: [user("hi")] },
    {
      id: "ses_garbled",
      directory: "/repo/u",
      updated: 1,
      rows: [
        user("first"),
        { type: "user", data: "{broken" },
        { type: "assistant", data: "[[[" },
        assistant([text("still here")]),
      ],
    },
  ];
}

function turnSessions(): SessionSpec[] {
  return [
    {
      id: "ses_many_typed",
      directory: "/repo/t",
      updated: 1,
      rows: ["one", "two", "three", "four", "five"].flatMap((t) => [
        user(t),
        assistant([text(`ok ${t}`)]),
      ]),
    },
    {
      id: "ses_untyped",
      directory: "/repo/t",
      updated: 1,
      rows: [
        injected("synthetic", { text: "Continue if you have next steps" }),
        assistant([text("Hello.")]),
        user("", { files: [IMAGE] }),
        assistant([text("Nice picture.")]),
      ],
    },
    {
      id: "ses_image_after_typed",
      directory: "/repo/t",
      updated: 1,
      rows: [user("look at this"), user("   ", { files: [IMAGE] }), assistant([text("I see a cat.")])],
    },
  ];
}

// The models.dev catalog as OpenCode caches it: `body` is api.json's text.
const CATALOG_BODY = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-9": { id: "claude-sonnet-9", limit: { context: 400_000, output: 64_000 } },
      "claude-opus-4-8": { id: "claude-opus-4-8", limit: { context: 200_000, output: 64_000 } },
      "no-limit": { id: "no-limit" },
    },
  },
  "github-copilot": {
    id: "github-copilot",
    models: { "claude-haiku-4.5": { id: "claude-haiku-4.5", limit: { context: 128_000 } } },
  },
  azure: { id: "azure", models: { "gpt-azure": { id: "gpt-azure", limit: { context: 272_000 } } } },
};

function catalog(body: unknown, updated: number) {
  return {
    "models-dev:catalog": {
      value: { updatedAt: updated, digest: "d".repeat(64), body: JSON.stringify(body) },
      updated,
    },
    "migration.v1-v2": { value: { phase: "completed" }, updated: 1 },
  };
}

function writeFile(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

let mtimeBefore = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-oc2-db-"));
  symlinkTarget = fs.realpathSync(fs.mkdtempSync(path.join(dir, "real-")));
  symlinkDir = path.join(dir, "link");
  fs.symlinkSync(symlinkTarget, symlinkDir);
  if (process.platform === "darwin") {
    // `/tmp` is a link to `/private/tmp` on macOS, and the TUI stores the latter.
    tmpLink = fs.mkdtempSync("/tmp/multicode-oc2-");
    realTmpDir = fs.realpathSync(tmpLink);
  }
  const sessions = [NATIVE, LEGACY, ...lookupSessions(), ...usageSessions(), ...turnSessions()];
  if (realTmpDir) sessions.push({ id: "ses_private_tmp", directory: realTmpDir, updated: 50 });
  dbFile = buildDb(path.join(dir, "opencode.db"), sessions, catalog(CATALOG_BODY, 1_700_000_000_000));
  // Read-only on disk: a reader that tried to write, or needed a write lock, fails.
  fs.chmodSync(dbFile, 0o444);
  mtimeBefore = fs.statSync(dbFile).mtimeMs;
});

afterAll(() => {
  // Every reader has run against it by now; none may have touched the file.
  expect(fs.statSync(dbFile).mtimeMs).toBe(mtimeBefore);
  fs.rmSync(dir, { recursive: true, force: true });
  if (tmpLink) fs.rmSync(tmpLink, { recursive: true, force: true });
});

// ---------------------------------------------------------------- paths

describe("opencodeDbPath", () => {
  it("defaults under HOME", () => {
    expect(opencodeDbPath({ HOME: "/h" })).toBe("/h/.local/share/opencode/opencode.db");
  });

  it("follows XDG_DATA_HOME", () => {
    expect(opencodeDbPath({ HOME: "/h", XDG_DATA_HOME: "/d" })).toBe("/d/opencode/opencode.db");
  });

  it("takes OPENCODE_DB, relative to the data directory as OpenCode does", () => {
    expect(opencodeDbPath({ HOME: "/h", OPENCODE_DB: "/elsewhere/x.db" })).toBe("/elsewhere/x.db");
    expect(opencodeDbPath({ HOME: "/h", XDG_DATA_HOME: "/d", OPENCODE_DB: "alt.db" })).toBe(
      "/d/opencode/alt.db"
    );
  });
});

describe("opencodeConfigPaths", () => {
  it("lists opencode.json then opencode.jsonc, the order OpenCode merges them", () => {
    expect(opencodeConfigPaths({ HOME: "/h" })).toEqual([
      "/h/.config/opencode/opencode.json",
      "/h/.config/opencode/opencode.jsonc",
    ]);
    expect(opencodeConfigPaths({ HOME: "/h", XDG_CONFIG_HOME: "/c" })[0]).toBe(
      "/c/opencode/opencode.json"
    );
  });
});

// ---------------------------------------------------------------- lookups

describe("opencodeSessionExists", () => {
  it("finds a session by id, child sessions included", () => {
    expect(opencodeSessionExists("ses_native", dbFile)).toBe(true);
    expect(opencodeSessionExists("ses_child", dbFile)).toBe(true);
    expect(opencodeSessionExists("ses_gone", dbFile)).toBe(false);
  });

  it("counts an unreadable database as yes", () => {
    expect(opencodeSessionExists("ses_native", MISSING())).toBe(true);
    // A database without the 2.x table (not migrated yet) is no answer either.
    const empty = buildDbWithout(path.join(dir, "empty.db"));
    expect(opencodeSessionExists("ses_native", empty)).toBe(true);
  });
});

function buildDbWithout(file: string): string {
  const db = new Database(file);
  db.exec("CREATE TABLE session (id text PRIMARY KEY)");
  db.close();
  return file;
}

describe("latestRootSession", () => {
  it("picks the newest root, past subagents and archived sessions", () => {
    expect(latestRootSession(NATIVE_DIR, undefined, dbFile)).toBe("ses_newer_root");
  });

  it("passes over a session another contact holds", () => {
    const claimed = new Set(["ses_newer_root"]);
    expect(latestRootSession(NATIVE_DIR, (id) => claimed.has(id), dbFile)).toBe("ses_native");
    claimed.add("ses_native");
    expect(latestRootSession(NATIVE_DIR, (id) => claimed.has(id), dbFile)).toBeNull();
  });

  it("matches the stored physical path through a link", () => {
    expect(latestRootSession(symlinkDir, undefined, dbFile)).toBe("ses_symlinked");
    expect(latestRootSession(symlinkTarget, undefined, dbFile)).toBe("ses_symlinked");
  });

  it.runIf(process.platform === "darwin")("finds a /private/tmp session from its /tmp path", () => {
    expect(tmpLink.startsWith("/tmp/")).toBe(true);
    expect(realTmpDir.startsWith("/private/tmp/")).toBe(true);
    expect(latestRootSession(tmpLink, undefined, dbFile)).toBe("ses_private_tmp");
  });

  it("is null for a directory with no session or an unreadable database", () => {
    expect(latestRootSession("/repo/nothing", undefined, dbFile)).toBeNull();
    expect(latestRootSession(NATIVE_DIR, undefined, MISSING())).toBeNull();
  });
});

// ---------------------------------------------------------------- transcript

describe("readOpencodeTranscript", () => {
  it("reads a native session in seq order, dropping what OpenCode injected", () => {
    expect(readOpencodeTranscript("ses_native", 40, dbFile)).toEqual([
      { kind: "user", text: "fix the build" },
      { kind: "assistant", text: "Looking." },
      { kind: "tool", tool: "shell", text: "pnpm build" },
      { kind: "tool", tool: "read", text: "src/a.ts" },
      { kind: "tool", tool: "edit", text: "src/a.ts" },
      { kind: "tool", tool: "patch", text: "src/b.ts" },
      { kind: "tool", tool: "websearch", text: "sqlite json_each" },
      { kind: "tool", tool: "subagent", text: "Find callers" },
      { kind: "tool", tool: "skill", text: "deploy" },
      { kind: "tool", tool: "execute", text: "const r = await tools.read({ path: 'x' })" },
      { kind: "tool", tool: "glob", text: "**/*.ts" },
      // The human's own `!git status`.
      { kind: "tool", tool: "shell", text: "git status" },
      { kind: "user", text: "now run the tests" },
      { kind: "assistant", text: "Running them." },
      { kind: "tool", tool: "shell", text: "pnpm test", pending: true },
      // Still streaming its input: in flight, with nothing to summarise yet.
      { kind: "tool", tool: "grep", text: "", pending: true },
    ]);
  });

  it("reads a migrated session's 1.x tool names and keys", () => {
    expect(readOpencodeTranscript("ses_legacy", 40, dbFile)).toEqual([
      { kind: "user", text: "migrate this" },
      { kind: "tool", tool: "bash", text: "ls -la" },
      { kind: "tool", tool: "bash", text: "Only a description" },
      { kind: "tool", tool: "read", text: "/repo/legacy/a.ts" },
      { kind: "tool", tool: "write", text: "/repo/legacy/b.ts" },
      { kind: "tool", tool: "apply_patch", text: "old.txt" },
      { kind: "tool", tool: "task", text: "Review code" },
      { kind: "tool", tool: "task", text: "only a prompt" },
      { kind: "tool", tool: "todowrite", text: "" },
      { kind: "tool", tool: "skill", text: "release" },
      { kind: "tool", tool: "question", text: "Ship it?" },
      { kind: "tool", tool: "webfetch", text: "https://example.com" },
      { kind: "tool", tool: "documonster_doc_inspect", text: "Inspect the doc" },
      { kind: "assistant", text: "Done." },
    ]);
  });

  it("keeps the newest entries when cut, splitting a step if it must", () => {
    expect(readOpencodeTranscript("ses_native", 4, dbFile)).toEqual([
      { kind: "user", text: "now run the tests" },
      { kind: "assistant", text: "Running them." },
      { kind: "tool", tool: "shell", text: "pnpm test", pending: true },
      { kind: "tool", tool: "grep", text: "", pending: true },
    ]);
    expect(readOpencodeTranscript("ses_native", 2, dbFile)).toEqual([
      { kind: "tool", tool: "shell", text: "pnpm test", pending: true },
      { kind: "tool", tool: "grep", text: "", pending: true },
    ]);
  });

  it("skips rows that aren't valid JSON", () => {
    expect(readOpencodeTranscript("ses_garbled", 40, dbFile)).toEqual([
      { kind: "user", text: "first" },
      { kind: "assistant", text: "still here" },
    ]);
  });

  it("never brings a pasted image's base64 out of SQLite", () => {
    // Every row any statement returns, as the readers receive it.
    const returned: string[] = [];
    const prepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      const statement = prepare.call(this, sql);
      for (const method of ["all", "get"] as const) {
        const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
        Object.assign(statement, {
          [method]: (...args: unknown[]) => {
            const result = original(...args);
            returned.push(JSON.stringify(result) ?? "");
            return result;
          },
        });
      }
      return statement;
    });
    try {
      readOpencodeTranscript("ses_native", 40, dbFile);
      readOpencodeBuilderTurn("ses_native", dbFile);
      readOpencodeBuilderTurn("ses_untyped", dbFile);
      readOpencodeContextUsage("ses_native", dbFile, NO_CONFIG());
    } finally {
      spy.mockRestore();
    }
    expect(returned.length).toBeGreaterThan(5);
    expect(returned.filter((rows) => rows.includes("iVBORw0KGgo"))).toEqual([]);
    // And no tool's output, which the transcript never shows either.
    expect(returned.filter((rows) => rows.includes("tool output that is never shown"))).toEqual([]);
  });

  it("is empty for an unknown session, a zero limit or an unreadable database", () => {
    expect(readOpencodeTranscript("ses_gone", 40, dbFile)).toEqual([]);
    expect(readOpencodeTranscript("ses_native", 0, dbFile)).toEqual([]);
    expect(readOpencodeTranscript("ses_native", 40, MISSING())).toEqual([]);
  });
});

describe("summarizeOpencodeTool", () => {
  it("prefers the 2.x key and falls back to the 1.x one", () => {
    expect(summarizeOpencodeTool("read", { path: "new.ts", filePath: "old.ts" })).toBe("new.ts");
    expect(summarizeOpencodeTool("edit", { filePath: "old.ts" })).toBe("old.ts");
    expect(summarizeOpencodeTool("skill", { id: "a", name: "b" })).toBe("a");
  });

  it("reads a patch's first file, or nothing when it names none", () => {
    expect(summarizeOpencodeTool("patch", { patchText: PATCH_TEXT })).toBe("src/b.ts");
    expect(summarizeOpencodeTool("patch", { patchText: "garbage" })).toBe("");
  });

  it("shows the question asked, or its header", () => {
    expect(summarizeOpencodeTool("question", { questions: [{ header: "Pick" }] })).toBe("Pick");
    expect(summarizeOpencodeTool("question", { questions: [] })).toBe("");
    expect(summarizeOpencodeTool("question", { questions: [null] })).toBe("");
  });

  it("is empty when there's no input to read", () => {
    expect(summarizeOpencodeTool("shell", undefined)).toBe("");
    expect(summarizeOpencodeTool("execute", { code: "" })).toBe("");
    expect(summarizeOpencodeTool("unknown_tool", {})).toBe("");
  });
});

// ---------------------------------------------------------------- builder turn

describe("readOpencodeBuilderTurn", () => {
  it("finds the latest typed message and reads the turn after it, in order", () => {
    expect(readOpencodeBuilderTurn("ses_native", dbFile)).toEqual({
      builderLatestMessage: "now run the tests",
      builderEarlierMessages: ["fix the build"],
      turn: [
        { kind: "assistant", text: "Running them." },
        { kind: "tool", tool: "shell", text: "pnpm test", pending: true },
        { kind: "tool", tool: "grep", text: "", pending: true },
      ],
    });
  });

  it("never takes injected text for the builder's", () => {
    const turn = readOpencodeBuilderTurn("ses_legacy", dbFile);
    expect(turn?.builderLatestMessage).toBe("migrate this");
    expect(turn?.builderEarlierMessages).toEqual([]);
    expect(turn?.turn.at(-1)).toEqual({ kind: "assistant", text: "Done." });
  });

  it("keeps up to three earlier messages, oldest first", () => {
    const turn = readOpencodeBuilderTurn("ses_many_typed", dbFile);
    expect(turn?.builderLatestMessage).toBe("five");
    expect(turn?.builderEarlierMessages).toEqual(["two", "three", "four"]);
    expect(turn?.turn).toEqual([{ kind: "assistant", text: "ok five" }]);
  });

  it("passes over an image sent without text", () => {
    expect(readOpencodeBuilderTurn("ses_image_after_typed", dbFile)).toEqual({
      builderLatestMessage: "look at this",
      builderEarlierMessages: [],
      turn: [{ kind: "assistant", text: "I see a cat." }],
    });
  });

  it("is the whole session when the builder typed nothing", () => {
    expect(readOpencodeBuilderTurn("ses_untyped", dbFile)).toEqual({
      builderLatestMessage: undefined,
      builderEarlierMessages: [],
      turn: [
        { kind: "assistant", text: "Hello." },
        { kind: "assistant", text: "Nice picture." },
      ],
    });
  });

  it("reads only the newest rows of a long session", () => {
    const long = path.join(dir, "long.db");
    const steps = Array.from({ length: BUILDER_TURN_SCAN_MESSAGES + 5 }, (_, i) =>
      assistant([text(`step ${i}`)])
    );
    buildDb(long, [{ id: "ses_long", directory: "/repo/l", updated: 1, rows: [user("go"), ...steps] }]);
    const turn = readOpencodeBuilderTurn("ses_long", long);
    // The typed message is past the bound, so the turn is read without it.
    expect(turn?.builderLatestMessage).toBeUndefined();
    expect(turn?.turn).toHaveLength(BUILDER_TURN_SCAN_MESSAGES);
    expect(turn?.turn.at(-1)).toEqual({ kind: "assistant", text: `step ${BUILDER_TURN_SCAN_MESSAGES + 4}` });
  });

  it("is null for an unknown session or an unreadable database", () => {
    expect(readOpencodeBuilderTurn("ses_gone", dbFile)).toBeNull();
    expect(readOpencodeBuilderTurn("ses_native", MISSING())).toBeNull();
  });
});

// ---------------------------------------------------------------- context usage

describe("readOpencodeContextUsage", () => {
  it("sums the input side of the newest step that reported, never output or reasoning", () => {
    // The newest step is still running and has no tokens; the one before reported.
    expect(readOpencodeContextUsage("ses_native", dbFile, NO_CONFIG())).toEqual({
      inputTokens: 2_000 + 30_000 + 500,
      updatedAt: 30_000,
      model: "claude-opus-4-8",
      // From the cached catalog, there being no config.
      contextWindow: 200_000,
    });
  });

  it("is null after a completed compaction, until a step reports again", () => {
    expect(readOpencodeContextUsage("ses_compacted", dbFile, NO_CONFIG())).toBeNull();
    expect(readOpencodeContextUsage("ses_after_compaction", dbFile, NO_CONFIG())?.inputTokens).toBe(
      8_005
    );
  });

  it("keeps the figure through a compaction still running or one that failed", () => {
    expect(readOpencodeContextUsage("ses_compaction_pending", dbFile, NO_CONFIG())?.inputTokens).toBe(6);
  });

  it("walks back past an all-zero step", () => {
    expect(readOpencodeContextUsage("ses_zero_newest", dbFile, NO_CONFIG())?.inputTokens).toBe(7);
  });

  it("walks past unusable numbers and rows that aren't JSON", () => {
    expect(readOpencodeContextUsage("ses_garbled_usage", dbFile, NO_CONFIG())?.inputTokens).toBe(11);
  });

  it("omits the model and window when the step didn't name a model", () => {
    expect(readOpencodeContextUsage("ses_no_model", dbFile, NO_CONFIG())).toEqual({
      inputTokens: 3,
      updatedAt: 20_000,
      model: undefined,
      contextWindow: undefined,
    });
  });

  it("takes the window from the config first, by the row's provider renamed", () => {
    const config = writeFile(
      "usage/opencode.json",
      JSON.stringify({ providers: { azure: { models: { "gpt-legacy": { limit: { context: 400_000 } } } } } })
    );
    expect(readOpencodeContextUsage("ses_legacy", dbFile, config)).toEqual({
      inputTokens: 4_100,
      updatedAt: 20_002,
      model: "gpt-legacy",
      contextWindow: 400_000,
    });
  });

  it("is null for a session with no step, an unknown one or an unreadable database", () => {
    expect(readOpencodeContextUsage("ses_user_only", dbFile, NO_CONFIG())).toBeNull();
    expect(readOpencodeContextUsage("ses_gone", dbFile, NO_CONFIG())).toBeNull();
    expect(readOpencodeContextUsage("ses_native", MISSING(), NO_CONFIG())).toBeNull();
  });
});

// ---------------------------------------------------------------- context window

describe("readOpencodeContextWindow", () => {
  // The builder's own config uses the 1.x key, 2026-09-15.
  const V1 = {
    provider: {
      "amazon-bedrock": {
        models: {
          "au.anthropic.claude-opus-4-8": { limit: { context: 1_000_000, output: 128_000 } },
        },
      },
      "google-vertex-anthropic": { models: { "claude-vertex": { limit: { context: 300_000 } } } },
      p: {
        models: {
          zero: { limit: { context: 0 } },
          text: { limit: { context: "1m" } },
          negative: { limit: { context: -1 } },
          none: {},
        },
      },
    },
  };

  it("reads the 1.x key, the recorded provider first, then any", () => {
    const config = writeFile("v1/opencode.json", JSON.stringify(V1));
    const window = (model: string, provider?: string) =>
      readOpencodeContextWindow(model, provider, MISSING(), config);
    expect(window("au.anthropic.claude-opus-4-8", "amazon-bedrock")).toBe(1_000_000);
    expect(window("au.anthropic.claude-opus-4-8", undefined)).toBe(1_000_000);
    expect(window("au.anthropic.claude-opus-4-8", "some-other-provider")).toBe(1_000_000);
    // A 1.x key under a provider 2.x renamed, matched by its 2.x name.
    expect(window("claude-vertex", "google-vertex")).toBe(300_000);
  });

  it("reads the 2.x key, which wins over the 1.x one for the same provider", () => {
    const config = writeFile(
      "v2/opencode.json",
      JSON.stringify({
        provider: { anthropic: { models: { m: { limit: { context: 100_000 } } } } },
        providers: {
          anthropic: { models: { m: { limit: { context: 500_000 } } } },
          other: { models: { m: { limit: { context: 1 } } } },
        },
      })
    );
    expect(readOpencodeContextWindow("m", "anthropic", MISSING(), config)).toBe(500_000);
  });

  it("prefers the recorded provider's 1.x entry to another provider's 2.x one", () => {
    const config = writeFile(
      "mixed/opencode.json",
      JSON.stringify({
        providers: { other: { models: { m: { limit: { context: 1 } } } } },
        provider: { anthropic: { models: { m: { limit: { context: 100_000 } } } } },
      })
    );
    expect(readOpencodeContextWindow("m", "anthropic", MISSING(), config)).toBe(100_000);
  });

  it("reads JSONC: comments and trailing commas", () => {
    const config = writeFile(
      "jsonc/opencode.jsonc",
      [
        "// my config",
        "{",
        '  "$schema": "https://opencode.ai/config.json", // a URL keeps its //',
        "  /* the 2.x key */",
        '  "providers": {',
        '    "anthropic": { "models": { "m": { "limit": { "context": 640000, }, }, }, },',
        "  },",
        "}",
      ].join("\n")
    );
    expect(readOpencodeContextWindow("m", "anthropic", MISSING(), config)).toBe(640_000);
  });

  it("is null for nonsensical limits, a missing or unparseable config, or no model", () => {
    const config = writeFile("bad/opencode.json", JSON.stringify(V1));
    for (const model of ["zero", "text", "negative", "none", "unknown"]) {
      expect(readOpencodeContextWindow(model, "p", MISSING(), config)).toBeNull();
    }
    expect(readOpencodeContextWindow("m", "p", MISSING(), NO_CONFIG())).toBeNull();
    expect(readOpencodeContextWindow("m", "p", MISSING(), writeFile("broken.json", "not json"))).toBeNull();
    expect(readOpencodeContextWindow(undefined, "amazon-bedrock", dbFile, config)).toBeNull();
  });

  it("falls back to OpenCode's cached models.dev catalog", () => {
    const window = (model: string, provider?: string) =>
      readOpencodeContextWindow(model, provider, dbFile, NO_CONFIG());
    expect(window("claude-sonnet-9", "anthropic")).toBe(400_000);
    // Dots in a model id are part of its name, not a path.
    expect(window("claude-haiku-4.5", "github-copilot")).toBe(128_000);
    // A migrated row's 1.x provider id, found under its 2.x name.
    expect(window("gpt-azure", "azure-cognitive-services")).toBe(272_000);
    expect(window("no-limit", "anthropic")).toBeNull();
    expect(window("claude-sonnet-9", "openai")).toBeNull();
    expect(window("claude-sonnet-9", undefined)).toBeNull();
    expect(window('bad"model', "anthropic")).toBeNull();
  });

  it("prefers the config to the catalog", () => {
    const config = writeFile(
      "override/opencode.json",
      JSON.stringify({ providers: { anthropic: { models: { "claude-sonnet-9": { limit: { context: 1_000_000 } } } } } })
    );
    expect(readOpencodeContextWindow("claude-sonnet-9", "anthropic", dbFile, config)).toBe(1_000_000);
  });

  it("follows a refreshed catalog", () => {
    const file = buildDb(path.join(dir, "refresh.db"), [], catalog(CATALOG_BODY, 1));
    expect(readOpencodeContextWindow("claude-sonnet-9", "anthropic", file, NO_CONFIG())).toBe(400_000);
    // What OpenCode does on refresh: the value replaced, `time_updated` moved.
    const db = new Database(file);
    const body = JSON.stringify({ anthropic: { models: { "claude-sonnet-9": { limit: { context: 450_000 } } } } });
    db.prepare("UPDATE kv SET value = ?, time_updated = 2 WHERE key = 'models-dev:catalog'").run(
      JSON.stringify({ updatedAt: 2, digest: "e", body })
    );
    db.close();
    expect(readOpencodeContextWindow("claude-sonnet-9", "anthropic", file, NO_CONFIG())).toBe(450_000);
  });

  it("is null when there's no catalog or it won't parse", () => {
    const none = buildDb(path.join(dir, "no-catalog.db"), []);
    expect(readOpencodeContextWindow("claude-sonnet-9", "anthropic", none, NO_CONFIG())).toBeNull();
    const garbled = buildDb(path.join(dir, "garbled-catalog.db"), [], {
      "models-dev:catalog": { value: { updatedAt: 1, body: "{not json" }, updated: 1 },
    });
    expect(readOpencodeContextWindow("claude-sonnet-9", "anthropic", garbled, NO_CONFIG())).toBeNull();
    expect(readOpencodeContextWindow("claude-sonnet-9", "anthropic", MISSING(), NO_CONFIG())).toBeNull();
    expect(
      readOpencodeContextWindow("claude-sonnet-9", "anthropic", buildDbWithout(path.join(dir, "v1.db")), NO_CONFIG())
    ).toBeNull();
  });
});

describe("stripJsonc", () => {
  it("leaves strings alone, escaped quotes included", () => {
    const source = '{"a": "/* keep */", "b": "x // y", "c": "say \\"hi\\" // still a string", }';
    expect(JSON.parse(stripJsonc(source))).toEqual({
      a: "/* keep */",
      b: "x // y",
      c: 'say "hi" // still a string',
    });
  });

  it("passes plain JSON through unchanged", () => {
    const source = JSON.stringify({ a: [1, 2, { b: "c,]" }] }, null, 2);
    expect(stripJsonc(source)).toBe(source);
  });
});

// ---------------------------------------------------------------- real database

// Opt-in, read-only: OPENCODE_DB_SMOKE=1 pnpm vitest run src/main/backends/opencodeDb.test.ts -t smoke
// Prints counts and shapes only, never message text.
describe.runIf(process.env.OPENCODE_DB_SMOKE === "1")("smoke: the builder's real database", () => {
  it("reads the newest root sessions", () => {
    const file = opencodeDbPath();
    const before = fs.statSync(file).mtimeMs;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const roots = db
      .prepare(
        "SELECT id, directory FROM session_v2 WHERE parent_id IS NULL AND time_archived IS NULL " +
          "ORDER BY time_updated DESC LIMIT 20"
      )
      .all() as Array<{ id: string; directory: string }>;
    db.close();

    const report: Record<string, unknown>[] = [];
    for (const [index, root] of roots.entries()) {
      const started = performance.now();
      const transcript = readOpencodeTranscript(root.id, 200);
      const turn = readOpencodeBuilderTurn(root.id);
      const usage = readOpencodeContextUsage(root.id);
      const kinds: Record<string, number> = {};
      for (const entry of transcript) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
      report.push({
        rank: index,
        latestRootMatches: index === 0 ? latestRootSession(root.directory) === root.id : undefined,
        exists: opencodeSessionExists(root.id),
        transcript: transcript.length,
        kinds,
        pending: transcript.filter((entry) => entry.pending).length,
        // Tool names only: which calls the summaries don't cover.
        emptyToolSummaries: [
          ...new Set(transcript.filter((entry) => entry.kind === "tool" && !entry.text).map((entry) => entry.tool)),
        ],
        turn: turn && {
          latest: turn.builderLatestMessage !== undefined,
          earlier: turn.builderEarlierMessages.length,
          entries: turn.turn.length,
        },
        usage: usage && {
          inputTokens: usage.inputTokens,
          model: usage.model,
          contextWindow: usage.contextWindow ?? null,
        },
        ms: Math.round(performance.now() - started),
      });
    }
    const after = fs.statSync(file).mtimeMs;
    console.log(
      [
        JSON.stringify({ roots: roots.length, mtimeBefore: before, mtimeAfter: after }),
        ...report.map((line) => JSON.stringify(line)),
      ].join("\n")
    );
    expect(roots.length).toBeGreaterThan(0);
  });
});
