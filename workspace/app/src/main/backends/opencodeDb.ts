// Read-only access to OpenCode 2's records in `opencode.db`: session lookups, the
// transcript, the builder's turn, context usage and the context window.
//
// Tables and shapes: docs/timeline/2026-10-20_opencode-v2-source-reading.md,
// "Database". Every function returns null or empty when the database can't be read,
// and never throws. `dbPath` and `configPath` are overridable for tests; tests must
// never read the real HOME.
//
// Nothing here writes. The handle is opened read-only per call and closed again, so
// Multi-Code never holds OpenCode's database open between reads.

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import type { BuilderTurn, RecentTurns } from "./types";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { ContextUsage } from "../../shared/types";
import { resolvePath } from "./resolvePath";
import { opencodePathEnv } from "./opencodeShellEnv";
import { RECENT_TURNS_ENTRY_CAP, lastTurns, lineCount, noTurns } from "./recentTurns";

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

// `$OPENCODE_DB`, else `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`.
// A relative `$OPENCODE_DB` is taken against that data directory, as OpenCode does
// (`packages/cli/src/database-path.ts`). The env is the one OpenCode runs with
// (opencodePathEnv), so a shell that moves the data directory moves it here too.
export function opencodeDbPath(env: NodeJS.ProcessEnv = opencodePathEnv()): string {
  const data = env.XDG_DATA_HOME || path.join(homeOf(env), ".local", "share");
  const file = env.OPENCODE_DB || "opencode.db";
  if (file === ":memory:") return file;
  return path.resolve(path.join(data, "opencode"), file);
}

// The user's global config files, in the order OpenCode merges them (a later one
// wins). Read only, never written.
export function opencodeConfigPaths(env: NodeJS.ProcessEnv = opencodePathEnv()): string[] {
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(homeOf(env), ".config"), "opencode");
  return [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
}

// Runs `read` against a fresh read-only handle, or returns `fallback` when the
// database can't be opened or read (not created yet, mid-migration, a table missing
// in an older layout). A malformed record must cost one read, never the caller.
function withDb<T>(dbPath: string | undefined, fallback: T, read: (db: Database.Database) => T): T {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath ?? opencodeDbPath(), { readonly: true, fileMustExist: true });
    return read(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

// Unknown (unreadable) counts as yes, as today: resuming a session that turns out to be
// gone costs a restart, starting fresh in its place loses the contact's history.
export function opencodeSessionExists(sessionId: string, dbPath?: string): boolean {
  return withDb(
    dbPath,
    true,
    (db) => db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(sessionId) !== undefined
  );
}

// The directory's newest root session (by `time_updated`) that `isClaimed` doesn't
// veto, matching `cwd` as given or resolved. Null when there is none.
//
// Both spellings, because the TUI stores its physical cwd: on macOS a contact on
// `/tmp/x` shows up as `/private/tmp/x` (44 such rows on the builder's machine, none
// under `/tmp`). Subagent sessions (`parent_id` set) are never a contact's session,
// and an archived one is a session the user put away.
export function latestRootSession(
  cwd: string,
  isClaimed?: (sessionId: string) => boolean,
  dbPath?: string
): string | null {
  return withDb(dbPath, null, (db) => {
    const rows = db
      .prepare(
        "SELECT id FROM session_v2 WHERE directory IN (?, ?) " +
          "AND parent_id IS NULL AND time_archived IS NULL " +
          "ORDER BY time_updated DESC"
      )
      .all(cwd, resolvePath(cwd)) as Array<{ id: string }>;
    for (const row of rows) {
      if (!isClaimed || !isClaimed(row.id)) return row.id;
    }
    return null;
  });
}

// ---------------------------------------------------------------- transcript

// One `session_message` row as the transcript readers take it, newest first.
//
// Only three row types carry anything for the transcript: `user` (what was typed),
// `assistant` (one per model step) and `shell` (a `!command` the human ran). The rest
// is OpenCode's: `synthetic`, `system` and `skill` are text it injected (reminders,
// subagent results, restart notices, migrated "user opened the file" notes), and
// `compaction`, `idle` and the `*-switched` rows are bookkeeping.
//
// `data` is never selected whole. A user row carries pasted images as base64 in
// `files`, and an assistant row carries every tool's output; `json_extract` takes out
// the few fields the transcript shows, inside SQLite.
interface MessageRow {
  id: string;
  type: string;
  // `user`: its text; `shell`: its command. Null otherwise.
  text: unknown;
  // `shell`: running, exited, timeout or killed. Null otherwise.
  status: unknown;
  // `shell`: the command's exit code, once it has one. Null otherwise.
  exit: unknown;
  // The row's `time_created`, ms. Equal to its `data.time.created` in every row on the
  // builder's machine, and read without parsing `data`.
  created: unknown;
}

const MESSAGE_ROWS_SQL =
  "SELECT id, type, " +
  "CASE type WHEN 'user' THEN json_extract(data, '$.text') " +
  "WHEN 'shell' THEN json_extract(data, '$.command') END AS text, " +
  "CASE type WHEN 'shell' THEN json_extract(data, '$.status') END AS status, " +
  "CASE type WHEN 'shell' THEN json_extract(data, '$.exit') END AS exit, " +
  "time_created AS created " +
  "FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant', 'shell') " +
  // A row that isn't valid JSON would make json_extract fail the whole query; it is
  // skipped instead, as one unreadable part was in 1.x. Assistant rows are parsed only
  // when their content is read.
  "AND (type = 'assistant' OR json_valid(data)) " +
  // `seq`, not time: unique per session and the order OpenCode itself reads in, while
  // `time_created` is rewritten (the migration, steered prompts).
  "ORDER BY seq DESC LIMIT ?";

// An assistant row's text and tool items in order. Reasoning is filtered out here, so
// its text never leaves SQLite; a tool's input comes as JSON text (or, while the
// model is still streaming it, as the partial string OpenCode keeps).
const ASSISTANT_ITEMS_SQL =
  "SELECT json_extract(value, '$.type') AS type, json_extract(value, '$.text') AS text, " +
  "json_extract(value, '$.name') AS name, json_extract(value, '$.state.status') AS status, " +
  "json_extract(value, '$.state.input') AS input " +
  "FROM json_each((SELECT data FROM session_message WHERE id = ?), '$.content') " +
  "WHERE json_extract(value, '$.type') IN ('text', 'tool') ORDER BY key";

interface AssistantItem {
  type: unknown;
  text: unknown;
  name: unknown;
  status: unknown;
  input: unknown;
}

// A tool's state while the call is under way: `streaming` while the model writes its
// input, `running` once it executes. A pending question is a running `question` tool.
// (The migration turned every 1.x call still running into `error`.)
const IN_FLIGHT = new Set(["streaming", "running"]);

// The first file a patch touches, from its `*** Add File: …` / `*** Update File: …` /
// `*** Delete File: …` headers (`packages/core/src/tool/patch.txt`).
function firstPatchFile(patchText: unknown): string | undefined {
  if (typeof patchText !== "string") return undefined;
  const match = /^\*\*\* (?:Add|Update|Delete) File: *(.+?)\s*$/m.exec(patchText);
  return match?.[1] || undefined;
}

// One-line description of an OpenCode tool call. Both vocabularies are live: native
// 2.x rows use `shell`, `subagent`, `patch` and `path`, while the migration kept every
// 1.x row's own names and keys (`bash`, `task`, `apply_patch`, `filePath`, `name` for
// a skill), and on the builder's machine those are nearly all of the history.
export function summarizeOpencodeTool(
  tool: string,
  input: Record<string, unknown> | undefined
): string {
  if (!input) return "";
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  switch (tool) {
    case "shell":
    case "bash":
      return str(input.command) ?? str(input.description) ?? "";
    case "read":
    case "write":
    case "edit":
      return str(input.path) ?? str(input.filePath) ?? "";
    case "patch":
    case "apply_patch":
      return firstPatchFile(input.patchText) ?? str(input.path) ?? str(input.filePath) ?? "";
    case "grep":
    case "glob":
      return str(input.pattern) ?? "";
    case "webfetch":
      return str(input.url) ?? "";
    case "websearch":
      return str(input.query) ?? "";
    case "subagent":
    case "task":
      return str(input.description) ?? str(input.prompt) ?? "";
    case "question": {
      // Show what was asked: it's usually the entry the agent is blocked on, and a
      // bare "question" line says nothing.
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length === 0) return "";
      const first = questions[0] as Record<string, unknown> | null;
      return str(first?.question) ?? str(first?.header) ?? "";
    }
    case "skill":
      return str(input.id) ?? str(input.name) ?? "";
    case "execute": {
      // Code Mode's script. Its first line is the closest thing to a summary.
      const code = str(input.code);
      return code?.split("\n").find((line) => line.trim())?.trim() ?? "";
    }
    default:
      return str(input.description) ?? str(input.command) ?? "";
  }
}

function toolInput(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A streaming call's input is the model's unfinished JSON.
    return undefined;
  }
}

function toolEntry(tool: string, text: string, status: unknown): TranscriptEntry {
  return typeof status === "string" && IN_FLIGHT.has(status)
    ? { kind: "tool", tool, text, pending: true }
    : { kind: "tool", tool, text };
}

// What the builder typed in a user row. 2.x keeps everything OpenCode injects in rows
// of its own, so a user row's text is all theirs (command templates expanded, as in
// 1.x). Null for a row with nothing typed, such as an image on its own.
function typedText(text: unknown): string | null {
  return typeof text === "string" ? text.trim() || null : null;
}

// A row's transcript entries in order. An assistant row's content is read only here,
// one row at a time, so a reader that stops early never parses the rest.
function rowEntries(items: Database.Statement, row: MessageRow): TranscriptEntry[] {
  if (row.type === "user") {
    const text = typedText(row.text);
    return text ? [{ kind: "user", text }] : [];
  }
  if (row.type === "shell") {
    return [toolEntry("shell", typeof row.text === "string" ? row.text : "", row.status)];
  }
  let content: AssistantItem[];
  try {
    content = items.all(row.id) as AssistantItem[];
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const item of content) {
    if (item.type === "text") {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (text) entries.push({ kind: "assistant", text });
    } else if (typeof item.name === "string") {
      entries.push(
        toolEntry(item.name, summarizeOpencodeTool(item.name, toolInput(item.input)), item.status)
      );
    }
  }
  return entries;
}

// Rows fetched per transcript entry wanted. Few rows come back empty (an image sent on
// its own, a step that only reasoned or failed before writing anything), and the
// fetch is cheap: an assistant row's content is only parsed once it's needed.
const TRANSCRIPT_ROWS_PER_ENTRY = 3;

// The tail of a session as reflowable lines, chronological. Rows are read newest
// first (what the `(session_id, seq)` index serves) and the result reversed.
export function readOpencodeTranscript(
  sessionId: string,
  limit: number,
  dbPath?: string
): TranscriptEntry[] {
  if (limit <= 0) return [];
  return withDb(dbPath, [], (db) => {
    const rows = db
      .prepare(MESSAGE_ROWS_SQL)
      .all(sessionId, limit * TRANSCRIPT_ROWS_PER_ENTRY) as MessageRow[];
    const items = db.prepare(ASSISTANT_ITEMS_SQL);
    const newestFirst: TranscriptEntry[] = [];
    for (const row of rows) {
      const entries = rowEntries(items, row);
      for (let i = entries.length - 1; i >= 0 && newestFirst.length < limit; i--) {
        newestFirst.push(entries[i]);
      }
      if (newestFirst.length >= limit) break;
    }
    return newestFirst.reverse();
  });
}

// For the language rule only, as on the Claude side: a bare "B" as the latest
// message falls back to these, newest first.
const EARLIER_MESSAGES = 3;

// How many of a session's newest rows the builder-turn reader looks at. Each step of
// an agent's turn is a row of its own, so a long turn runs to a few hundred; past this
// the turn is read without the message that started it.
export const BUILDER_TURN_SCAN_MESSAGES = 300;

// What the builder last typed, up to three typed before it (oldest first), and every
// transcript entry since. Null when the session can't be read or has no rows.
export function readOpencodeBuilderTurn(sessionId: string, dbPath?: string): BuilderTurn | null {
  return withDb(dbPath, null, (db) => {
    const rows = db
      .prepare(MESSAGE_ROWS_SQL)
      .all(sessionId, BUILDER_TURN_SCAN_MESSAGES) as MessageRow[];
    if (rows.length === 0) return null;

    const typed: { index: number; text: string }[] = [];
    for (let i = 0; i < rows.length && typed.length <= EARLIER_MESSAGES; i++) {
      if (rows[i].type !== "user") continue;
      const text = typedText(rows[i].text);
      if (text !== null) typed.push({ index: i, text });
    }

    const [latest, ...earlier] = typed;
    // Only the rows after the latest typed message are read in full: an older
    // assistant step's content (its tool output included) is never needed.
    const since = rows.slice(0, latest ? latest.index : rows.length).reverse();
    const items = db.prepare(ASSISTANT_ITEMS_SQL);
    return {
      builderLatestMessage: latest?.text,
      builderEarlierMessages: earlier.reverse().map((message) => message.text),
      turn: since.flatMap((row) => rowEntries(items, row)),
    };
  });
}

// ---------------------------------------------------------------- recent turns

// An assistant row's text and tool items with what the phone's turn view needs beyond
// ASSISTANT_ITEMS_SQL: each item's position (the id of a text item, which has none of its
// own), a tool's id and start, and from its result whether a shell call failed and how
// many lines an edit changed. Each field comes out of SQLite on its own, so a tool's
// output and the diffs in its metadata never reach JS (its input does, as in
// ASSISTANT_ITEMS_SQL: the summary is read from it). `jsonb_each` hands each item over as JSONB,
// which a `json_extract` reads without parsing it again: with the dozen fields read
// here, `json_each` made a session holding one 36 MB step take three times as long as
// the five-field ASSISTANT_ITEMS_SQL, and `jsonb_each` no longer than it (2026-10-29).
//
// Line counts are kept in both vocabularies (`packages/core/src/tool/plugin/file-diff.ts`
// and the builder's migrated rows): 2.x `edit` and `patch` and 1.x `apply_patch` hold
// `metadata.files[]`, each with `additions` and `deletions`, and 1.x `edit` one
// `metadata.filediff`. 1.x `write` records only whether the file `exists`ed, and a 2.x
// `write` no metadata at all, so a write over an existing file has no counts. Only
// objects are read as diffs: a custom tool's `files` may be a list of paths, and
// `json_extract` on a bare string fails the whole statement, which would lose the step.
const TURN_ITEMS_SQL =
  "SELECT c.key AS key, json_extract(c.value, '$.type') AS type, " +
  "json_extract(c.value, '$.text') AS text, json_extract(c.value, '$.id') AS id, " +
  "json_extract(c.value, '$.name') AS name, json_extract(c.value, '$.time.created') AS created, " +
  "json_extract(c.value, '$.state.status') AS status, json_extract(c.value, '$.state.input') AS input, " +
  "json_extract(c.value, '$.state.metadata.exit') AS exit, " +
  "json_extract(c.value, '$.state.metadata.timeout') AS timeout, " +
  "json_extract(c.value, '$.state.metadata.signal') AS signal, " +
  "json_extract(c.value, '$.state.metadata.exists') AS existed, " +
  "coalesce(json_extract(c.value, '$.state.metadata.filediff.additions'), " +
  "(SELECT sum(json_extract(f.value, '$.additions')) " +
  "FROM jsonb_each(c.value, '$.state.metadata.files') f WHERE f.type = 'object')) AS added, " +
  "coalesce(json_extract(c.value, '$.state.metadata.filediff.deletions'), " +
  "(SELECT sum(json_extract(f.value, '$.deletions')) " +
  "FROM jsonb_each(c.value, '$.state.metadata.files') f WHERE f.type = 'object')) AS removed " +
  "FROM jsonb_each((SELECT data FROM session_message WHERE id = ?), '$.content') c " +
  "WHERE json_extract(c.value, '$.type') IN ('text', 'tool') ORDER BY c.key";

interface TurnItem extends AssistantItem {
  key: unknown;
  id: unknown;
  created: unknown;
  exit: unknown;
  timeout: unknown;
  signal: unknown;
  // JSON booleans come out of SQLite as 1 and 0.
  existed: unknown;
  added: unknown;
  removed: unknown;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stamped(entry: TranscriptEntry, id: unknown, at: number | undefined): TranscriptEntry {
  if (typeof id === "string" && id) entry.id = id;
  if (at !== undefined) entry.at = at;
  return entry;
}

// A shell call that completed but failed, as OpenCode itself reads its result
// (`packages/core/src/shell/result.ts`, `notice`): it timed out, was killed by a signal,
// or exited non-zero. Migrated 1.x `bash` rows keep the exit code the same way. Claude
// reports such a call as an error, so both backends' failed commands read alike.
function shellFailed(item: TurnItem): boolean {
  if (item.name !== "shell" && item.name !== "bash") return false;
  return item.timeout === 1 || typeof item.signal === "string" || (finite(item.exit) ?? 0) !== 0;
}

function settleTool(entry: TranscriptEntry, item: TurnItem, input: Record<string, unknown> | undefined) {
  if (typeof item.status === "string" && IN_FLIGHT.has(item.status)) {
    entry.pending = true;
    return;
  }
  if (item.status === "error") {
    entry.outcome = "error";
    return;
  }
  // Anything else OpenCode may add is left without an outcome.
  if (item.status !== "completed") return;
  entry.outcome = shellFailed(item) ? "error" : "ok";
  const added = finite(item.added);
  const removed = finite(item.removed);
  if (added !== undefined || removed !== undefined) {
    entry.added = added ?? 0;
    entry.removed = removed ?? 0;
  } else if (item.existed === 0 && typeof input?.content === "string") {
    entry.added = lineCount(input.content);
    entry.removed = 0;
  }
}

// A row's entries for the turn view, in order: `rowEntries`, with ids, times, outcomes
// and line counts. A text item's time is its step's; a tool's is its own start.
function turnRowEntries(items: Database.Statement, row: MessageRow): TranscriptEntry[] {
  const at = finite(row.created);
  if (row.type === "user") {
    const text = typedText(row.text);
    return text ? [stamped({ kind: "user", text }, row.id, at)] : [];
  }
  if (row.type === "shell") {
    const text = typeof row.text === "string" ? row.text : "";
    const entry = stamped({ kind: "tool", tool: "shell", text }, row.id, at);
    if (row.status === "running") entry.pending = true;
    else entry.outcome = row.exit === 0 ? "ok" : "error";
    return [entry];
  }
  let content: TurnItem[];
  try {
    content = items.all(row.id) as TurnItem[];
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const item of content) {
    const position = `${row.id}:${String(item.key)}`;
    if (item.type === "text") {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (text) entries.push(stamped({ kind: "assistant", text }, position, at));
    } else if (typeof item.name === "string") {
      const input = toolInput(item.input);
      const entry = stamped(
        { kind: "tool", tool: item.name, text: summarizeOpencodeTool(item.name, input) },
        typeof item.id === "string" && item.id ? item.id : position,
        finite(item.created) ?? at
      );
      settleTool(entry, item, input);
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * The last `turns` turns of a session (`Backend.readRecentTurns`). Rows are walked
 * newest first and each read only when reached, so the walk stops at the first row
 * before them (which is how `hasEarlier` is known) or once it holds more entries than
 * the cap keeps.
 */
export function readOpencodeRecentTurns(
  sessionId: string,
  turns: number,
  dbPath?: string
): RecentTurns {
  return withDb(dbPath, noTurns(), (db) => {
    const items = db.prepare(TURN_ITEMS_SQL);
    const newestFirst: TranscriptEntry[] = [];
    let typed = 0;
    let earlier = false;
    // A negative LIMIT is none; the walk decides where to stop.
    for (const row of db.prepare(MESSAGE_ROWS_SQL).iterate(sessionId, -1) as Iterable<MessageRow>) {
      if (typed === turns) {
        // Earlier turns exist if any row before has something to show. An older step
        // counts without being opened, since one can hold tens of megabytes of tool
        // output; a step with nothing but reasoning, the exception, costs an "Earlier
        // turns" that brings nothing.
        if (row.type !== "user" || typedText(row.text) !== null) {
          earlier = true;
          break;
        }
        continue;
      }
      const entries = turnRowEntries(items, row);
      if (entries.length === 0) continue;
      for (let i = entries.length - 1; i >= 0; i--) newestFirst.push(entries[i]);
      if (entries[0].kind === "user") typed++;
      if (newestFirst.length > RECENT_TURNS_ENTRY_CAP) {
        earlier = true;
        break;
      }
    }
    return lastTurns(newestFirst.reverse(), turns, earlier);
  });
}

// ---------------------------------------------------------------- context

// How many of the newest assistant and compaction rows the usage reader looks at. The
// newest step has no `tokens` while it runs, and a failed one may report zeros, so it
// walks back; this far is plenty.
const USAGE_SCAN_ROWS = 40;

interface UsageRow {
  type: string;
  time_updated: unknown;
  status: unknown;
  input: unknown;
  cache_read: unknown;
  cache_write: unknown;
  model: unknown;
  provider: unknown;
}

// How full the window is, from the newest step that reported usage.
//
// Summed from the input side only: `tokens.input` (which excludes cache) plus
// `tokens.cache.read` and `tokens.cache.write`. Output and reasoning aren't occupying
// the window on the next turn, and adding them (as OpenCode's own UI does) would make
// the figure incomparable with the Claude backend's.
//
// A completed compaction newer than any such step means the window was rebuilt from
// a summary, and the older figure is stale: `"compacted"` until the next step
// reports. The row records no size for the new window (its fields are `status`,
// `reason`, `summary`, `recent`, `time`), and its own `tokens`, when present, are the
// summarising request's.
//
// Do NOT use `session_v2`'s `tokens_*` columns: those are lifetime totals.
export function readOpencodeContextUsage(
  sessionId: string,
  dbPath?: string,
  configPath?: string
): ContextUsage | "compacted" | null {
  return withDb<ContextUsage | "compacted" | null>(dbPath, null, (db) => {
    const rows = db
      .prepare(
        "SELECT type, time_updated, json_extract(data, '$.status') AS status, " +
          "json_extract(data, '$.tokens.input') AS input, " +
          "json_extract(data, '$.tokens.cache.read') AS cache_read, " +
          "json_extract(data, '$.tokens.cache.write') AS cache_write, " +
          "json_extract(data, '$.model.id') AS model, " +
          "json_extract(data, '$.model.providerID') AS provider " +
          "FROM session_message WHERE session_id = ? AND type IN ('assistant', 'compaction') " +
          "AND json_valid(data) ORDER BY seq DESC LIMIT ?"
      )
      .all(sessionId, USAGE_SCAN_ROWS) as UsageRow[];

    for (const row of rows) {
      if (row.type === "compaction") {
        if (row.status === "completed") return "compacted";
        continue;
      }
      const inputTokens =
        finiteNumber(row.input) + finiteNumber(row.cache_read) + finiteNumber(row.cache_write);
      // A running step has no tokens, and all zeros says nothing; keep walking back.
      if (inputTokens <= 0) continue;

      const model = nonEmpty(row.model);
      return {
        inputTokens,
        updatedAt: finiteNumber(row.time_updated),
        model,
        contextWindow: contextWindowFrom(db, model, nonEmpty(row.provider), configPath) ?? undefined,
      };
    }
    return null;
  });
}

// The model's context window: the user's config override, then OpenCode's cached
// models.dev catalog. Null when neither knows the model; OpenCode itself would assume
// 200 000 then, which is a guess this doesn't repeat (no percentage beats a wrong one).
export function readOpencodeContextWindow(
  model: string | undefined,
  providerId: string | undefined,
  dbPath?: string,
  configPath?: string
): number | null {
  if (!model) return null;
  const configured = configContextWindow(model, providerId, configPath);
  if (configured !== null) return configured;
  return withDb(dbPath, null, (db) => catalogContextWindow(db, model, providerId));
}

function contextWindowFrom(
  db: Database.Database,
  model: string | undefined,
  providerId: string | undefined,
  configPath: string | undefined
): number | null {
  if (!model) return null;
  return configContextWindow(model, providerId, configPath) ?? catalogContextWindow(db, model, providerId);
}

// The two providers 2.x renamed. A 1.x config key keeps its old name, and so does the
// `providerID` of every migrated assistant row, so both sides are compared renamed
// (`packages/core/src/v1/config/migrate.ts`, `providerID`).
function canonicalProvider(id: string): string {
  if (id === "azure-cognitive-services") return "azure";
  if (id === "google-vertex-anthropic") return "google-vertex";
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// JSONC as OpenCode accepts it: `//` and `/* */` comments and trailing commas, which
// are removed outside strings only, so a URL's `//` or a `/*` in a value survives.
// Plain JSON passes through unchanged.
export function stripJsonc(text: string): string {
  let out = "";
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      if (ch === "}" || ch === "]") {
        // Drop a trailing comma: the last thing written before this, past whitespace.
        let back = out.length - 1;
        while (back >= 0 && /\s/.test(out[back])) back--;
        if (out[back] === ",") out = out.slice(0, back) + out.slice(back + 1);
      }
      out += ch;
      i++;
    }
  }
  return out;
}

function readConfig(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// `models.<model>.limit.context` of one provider entry, either key style.
function modelLimit(provider: unknown, model: string): number | null {
  if (!isRecord(provider) || !isRecord(provider.models)) return null;
  const entry = provider.models[model];
  if (!isRecord(entry) || !isRecord(entry.limit)) return null;
  return positiveNumber(entry.limit.context);
}

// The window the user's config states for this model, exactly (observed 1 000 000 for
// the Bedrock 1M models, 200 000 for Haiku).
//
// 2.x reads providers from `providers`, and still reads and migrates the 1.x key
// `provider`, which is what the builder's config uses; for one provider the 2.x entry
// wins, as in OpenCode (`packages/core/src/config/normalize.ts`). The recorded
// provider is tried first, then any: the same model id under two providers carries the
// same limit, and a row whose provider wasn't recorded still deserves an answer.
function configContextWindow(
  model: string,
  providerId: string | undefined,
  configPath: string | undefined
): number | null {
  const files = configPath ? [configPath] : opencodeConfigPaths();
  const entries: Array<[string, unknown]> = [];
  // The file OpenCode merges last first, since its value is the one in force.
  for (const file of [...files].reverse()) {
    const config = readConfig(file);
    if (!config) continue;
    for (const key of ["providers", "provider"]) {
      const table = config[key];
      if (isRecord(table)) entries.push(...Object.entries(table));
    }
  }

  const wanted = providerId ? canonicalProvider(providerId) : undefined;
  const ordered = wanted
    ? [
        ...entries.filter(([id]) => canonicalProvider(id) === wanted),
        ...entries.filter(([id]) => canonicalProvider(id) !== wanted),
      ]
    : entries;
  for (const [, provider] of ordered) {
    const limit = modelLimit(provider, model);
    if (limit !== null) return limit;
  }
  return null;
}

// OpenCode caches the models.dev catalog in its own database (kv `models-dev:catalog`,
// value `{updatedAt, digest, body}` with `body` the api.json text, about 6.5 MB). It is
// read with `json_extract` inside SQLite rather than parsed in JS, and each answer is
// kept until the row's `time_updated` moves. That column is read without touching the
// value, so a repeat lookup costs one indexed row read; the `json_extract` itself
// takes about 20 ms on the real catalog, all of it on the main thread.
const CATALOG_KEY = "models-dev:catalog";

let catalogCache: { db: string; stamp: number; windows: Map<string, number | null> } | null =
  null;

function catalogContextWindow(
  db: Database.Database,
  model: string,
  providerId: string | undefined
): number | null {
  if (!providerId) return null;
  try {
    const stamp = (
      db.prepare("SELECT time_updated FROM kv WHERE key = ?").get(CATALOG_KEY) as
        | { time_updated: number }
        | undefined
    )?.time_updated;
    if (stamp === undefined) return null;
    if (!catalogCache || catalogCache.db !== db.name || catalogCache.stamp !== stamp) {
      catalogCache = { db: db.name, stamp, windows: new Map() };
    }
    const key = `${providerId}\n${model}`;
    const cached = catalogCache.windows.get(key);
    if (cached !== undefined) return cached;

    const read = db.prepare(
      "SELECT json_extract(json_extract(value, '$.body'), ?) AS context FROM kv WHERE key = ?"
    );
    let found: number | null = null;
    // The catalog's own id first; a migrated row may carry the 1.x name of a renamed
    // provider, so its 2.x name next.
    for (const provider of new Set([providerId, canonicalProvider(providerId)])) {
      // A JSON path label can't contain a double quote, and no real id does.
      if (provider.includes('"') || model.includes('"')) continue;
      const row = read.get(`$."${provider}".models."${model}".limit.context`, CATALOG_KEY) as
        | { context: unknown }
        | undefined;
      found = positiveNumber(row?.context);
      if (found !== null) break;
    }
    catalogCache.windows.set(key, found);
    return found;
  } catch {
    // A missing kv table or a catalog that won't parse is no answer, not a lost
    // usage figure.
    return null;
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
