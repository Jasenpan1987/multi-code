// Reading a Claude session's JSONL: the entries the manager sees
// (`claudeTranscriptEntries`), what the builder last said and what happened since
// (`readBuilderTurn`), the secretary's material behind `Backend.readBuilderTurn`, and
// the phone's last turns (`readClaudeRecentTurns`, at the end).
//
// The builder's messages come from the raw rows, not from `readClaudeTranscript`,
// which keeps every `isMeta` row with string content as a "user" entry and drops
// every typed message whose content is an array. In a survey of the builder's own
// transcripts that meant 25 `[Image: original 2400x1600, …]` lines the CLI added,
// which would hand the brief writer an English "latest message" and flip a Chinese
// builder's brief, and 40 real messages lost because they carried a pasted image
// (docs/timeline/2026-10-08_brief-writer-spike.md, "Input format").
//
// The turn itself is `claudeTranscriptEntries` over the rows after that message, so
// it reads the way the phone and the manager see a session.

import fs from "fs";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { BuilderTurn, RecentTurns } from "./types";
import { RECENT_TURNS_ENTRY_CAP, lastTurns, lineCount, noTurns } from "./recentTurns";

// For the language rule only: a bare "B" or "[Image #1]" as the latest message
// falls back to these, newest first.
export const EARLIER_MESSAGES = 3;

// The CLI's own tagged rows all open with a hyphenated tag: `<command-name>`,
// `<bash-input>`, `<bash-stdout>`, `<task-notification>`, `<local-command-stdout>`
// (every one found in the builder's transcripts). A message the builder typed that
// merely starts with `<`, such as pasted HTML, is still theirs.
const CLI_TAGGED_ROW = /^<[a-z]+(?:-[a-z]+)+[\s>]/;

// How much of the transcript's end is read, doubled until it holds the builder's
// latest message and the ones before it, up to the cap. A session runs to hundreds
// of megabytes of old tool output and images, and only its end matters.
export const TAIL_START_BYTES = 1 << 20;
export const TAIL_MAX_BYTES = 32 << 20;

// The text of a row the builder typed, or null for anything else: rows the CLI
// adds (`isMeta`: image notes, "Continue from where you left off.", messages from
// other sessions), tool results, the CLI's own tagged rows (`<command-name>`,
// `<bash-input>`, `<task-notification>`, `<local-command-…>`) and the interruption
// marker. Text parts of an array body count, so a message with a pasted image is
// still the builder's.
export function typedText(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  if (record.type !== "user" || record.isMeta === true) return null;
  // The summary a compaction writes as a user row. Not seen in the builder's
  // transcripts; skipped because it is long English text the builder never typed.
  if (record.isCompactSummary === true) return null;

  const content = (record.message as Record<string, unknown> | undefined)?.content;
  let text: string;
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    const parts = content as Record<string, unknown>[];
    if (parts.some((part) => part?.type === "tool_result")) return null;
    text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
  } else {
    return null;
  }

  if (!text || CLI_TAGGED_ROW.test(text) || text.startsWith("[Request interrupted")) return null;
  return text;
}

export function builderTurnFromLines(lines: string[]): BuilderTurn {
  // Backwards, because a session runs to thousands of rows and only its end matters.
  const typed: { index: number; text: string }[] = [];
  for (let i = lines.length - 1; i >= 0 && typed.length <= EARLIER_MESSAGES; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const text = typedText(row);
    if (text !== null) typed.push({ index: i, text });
  }

  const [latest, ...earlier] = typed;
  return {
    builderLatestMessage: latest?.text,
    builderEarlierMessages: earlier.reverse().map((message) => message.text),
    turn: claudeTranscriptEntries(latest ? lines.slice(latest.index + 1) : lines),
  };
}

// Null when the transcript can't be read. Reads only the end of the file (see
// TAIL_START_BYTES); a turn longer than the cap is read from the cap on, without
// the builder's message that started it.
export async function readBuilderTurn(
  jsonlPath: string,
  window: { startBytes: number; maxBytes: number } = {
    startBytes: TAIL_START_BYTES,
    maxBytes: TAIL_MAX_BYTES,
  }
): Promise<BuilderTurn | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(jsonlPath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    let length = Math.min(size, window.startBytes);
    for (;;) {
      const start = size - length;
      const lines = (await readRange(handle, start, length)).split("\n");
      // The first line is cut wherever the window began, mid-character included.
      if (start > 0) lines.shift();
      const found = builderTurnFromLines(lines);
      const complete =
        found.builderLatestMessage !== undefined &&
        found.builderEarlierMessages.length >= EARLIER_MESSAGES;
      if (complete || start === 0 || length >= window.maxBytes) return found;
      length = Math.min(size, length * 2, window.maxBytes);
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readRange(
  handle: fs.promises.FileHandle,
  start: number,
  length: number
): Promise<string> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.toString("utf8", 0, filled);
}

// The same entries from a run of JSONL lines, for a reader that wants only part of
// a session: the secretary's brief writer reads the turn since the builder's last
// message. A tool use is pending when its result isn't among these lines.
export function claudeTranscriptEntries(lines: string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // Tool uses still awaiting a result, so they can be marked pending — that's
  // the tool the agent is currently on, which is what a phone is for.
  const unpaired = new Set<string>();
  // Entry index -> tool_use id, so the pending flags can be resolved after the
  // whole file is read. Local to the call: two instances read concurrently.
  const toolEntryIds = new Map<number, string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (msg.type === "user") {
      // A string body is something the user actually typed. Array bodies are
      // tool results, which only matter here for pairing.
      if (typeof content === "string") {
        const text = content.trim();
        if (text) entries.push({ kind: "user", text });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          const entry = item as Record<string, unknown>;
          if (entry?.type === "tool_result" && typeof entry.tool_use_id === "string") {
            unpaired.delete(entry.tool_use_id);
          }
        }
      }
      continue;
    }

    if (msg.type !== "assistant" || !Array.isArray(content)) continue;

    for (const item of content) {
      const entry = item as Record<string, unknown>;
      if (entry?.type === "text" && typeof entry.text === "string") {
        const text = entry.text.trim();
        if (text) entries.push({ kind: "assistant", text });
        continue;
      }
      if (entry?.type === "tool_use" && typeof entry.name === "string") {
        if (typeof entry.id === "string") unpaired.add(entry.id);
        const summary = summarizeTranscriptTool(entry.name, entry.input);
        entries.push({
          kind: "tool",
          tool: entry.name,
          text: summary ?? "",
        });
        if (typeof entry.id === "string") {
          toolEntryIds.set(entries.length - 1, entry.id);
        }
      }
    }
  }

  // Resolve pending only now: a tool_use paired further down the file must not
  // stay flagged from when it was first seen.
  for (const [index, id] of toolEntryIds) {
    const entry = entries[index];
    if (entry && unpaired.has(id)) entry.pending = true;
  }

  return entries;
}

// One-line description of a tool call, matching what the desktop shows.
function summarizeTranscriptTool(name: string, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  switch (name) {
    case "Bash":
      return str(record.command);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return str(record.file_path);
    case "Grep":
      return str(record.pattern);
    case "Glob":
      return str(record.pattern);
    case "WebFetch":
      return str(record.url);
    case "Task":
      return str(record.description);
    default:
      return str(record.description) ?? str(record.command);
  }
}

// ---------------------------------------------------------------- recent turns

// Rows the turn reader never needs, told apart without parsing them. The CLI writes its
// bookkeeping rows (`api-request`, `mode`, `last-prompt`, `queue-operation`, …) with
// `type` as the first key, while user and assistant rows open with `parentUuid`. Of a
// 24 MB session of the builder's (2026-10-29), `api-request` rows were 17.8 MB, each a
// copy of the request so far; leaving them unparsed took a read of the whole file from
// 60 ms to 20 ms.
const TYPE_FIRST = Buffer.from('{"type":"');
const MESSAGE_TYPE_FIRST = [Buffer.from('{"type":"user"'), Buffer.from('{"type":"assistant"')];

function startsWith(buffer: Buffer, start: number, end: number, prefix: Buffer): boolean {
  return (
    end - start >= prefix.length &&
    buffer.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0
  );
}

function isBookkeeping(buffer: Buffer, start: number, end: number): boolean {
  return (
    startsWith(buffer, start, end, TYPE_FIRST) &&
    !MESSAGE_TYPE_FIRST.some((prefix) => startsWith(buffer, start, end, prefix))
  );
}

// The parsed rows of a run of JSONL bytes. Only the lines that are kept are decoded.
// `cut`: the bytes begin mid-file, so the first line is a fragment.
function* jsonlRows(buffer: Buffer, cut: boolean): Generator<unknown> {
  let start = 0;
  if (cut) {
    const newline = buffer.indexOf(0x0a);
    start = newline === -1 ? buffer.length : newline + 1;
  }
  while (start < buffer.length) {
    let end = buffer.indexOf(0x0a, start);
    if (end === -1) end = buffer.length;
    if (end > start && !isBookkeeping(buffer, start, end)) {
      let row: unknown;
      try {
        row = JSON.parse(buffer.toString("utf8", start, end));
      } catch {
        // A row still being written, or a broken one.
      }
      if (row !== undefined) yield row;
    }
    start = end + 1;
  }
}

function readRangeSync(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = fs.readSync(fd, buffer, filled, length - filled, start + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/**
 * The last `turns` turns of a session JSONL (`Backend.readRecentTurns`). Reads the end
 * of the file, doubled until it holds a turn more than asked for (which is how
 * `hasEarlier` is known), more entries than the cap keeps, or the whole file, up to
 * `maxBytes`. A read that stops at `maxBytes` says there is more, and its oldest turn
 * may lack its start. Each widening reads and parses only the bytes before what it has,
 * so no row is parsed twice.
 */
export function readClaudeRecentTurns(
  jsonlPath: string,
  turns: number,
  window: { startBytes: number; maxBytes: number } = {
    startBytes: TAIL_START_BYTES,
    maxBytes: TAIL_MAX_BYTES,
  }
): RecentTurns {
  let fd: number;
  try {
    fd = fs.openSync(jsonlPath, "r");
  } catch {
    return noTurns();
  }
  try {
    const { size } = fs.fstatSync(fd);
    // The rows parsed so far, in file order, and where the first of them begins. The
    // line the window's edge cuts is left for the next widening to read whole.
    let rows: unknown[] = [];
    let parsedFrom = size;
    // At least a byte, so the doubling below moves.
    let length = Math.min(size, Math.max(1, window.startBytes), window.maxBytes);
    for (;;) {
      const start = size - length;
      const chunk = readRangeSync(fd, start, parsedFrom - start);
      rows = [...jsonlRows(chunk, start > 0), ...rows];
      const newline = chunk.indexOf(0x0a);
      if (start === 0) parsedFrom = 0;
      else if (newline !== -1) parsedFrom = start + newline + 1;
      const entries = claudeTurnEntries(rows);
      const typed = entries.reduce((count, entry) => (entry.kind === "user" ? count + 1 : count), 0);
      if (
        start === 0 ||
        length >= window.maxBytes ||
        typed > turns ||
        entries.length > RECENT_TURNS_ENTRY_CAP
      ) {
        return lastTurns(entries, turns, start > 0);
      }
      length = Math.min(size, length * 2, window.maxBytes);
    }
  } catch {
    return noTurns();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The entries `readClaudeRecentTurns` shows, from session rows in file order. Unlike
 * `claudeTranscriptEntries`, a "user" entry is only a message the builder typed
 * (`typedText`) or a command of theirs that prompted the agent, so each one starts a
 * turn; the other user rows the CLI writes (tool results, notifications, a local
 * command's output, image notes) are left out. A tool entry is settled by its result:
 * `outcome` from `is_error`, and an edit's or write's line counts from the record the
 * CLI keeps beside the result.
 */
export function claudeTurnEntries(rows: Iterable<unknown>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // Tool uses still waiting for their result, by tool_use id.
  const running = new Map<string, TranscriptEntry>();
  // A command row, until the next row says whether it prompted the agent.
  let command: TranscriptEntry | null = null;

  for (const value of rows) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    // A command is the builder's turn when the CLI's next row is the prompt it hands the
    // agent: an `isMeta` row that is the command row's child. A local command such as
    // `/clear`, `/model` or `/compact` has its output or a system row as that child
    // instead. Every command row on the builder's machine was followed directly by its
    // child (2026-10-29).
    const prompted = command;
    command = null;
    if (prompted && row.type === "user" && row.isMeta === true && row.parentUuid === prompted.id) {
      entries.push(prompted);
      continue;
    }
    const content = (row.message as Record<string, unknown> | undefined)?.content;

    if (row.type === "user") {
      if (Array.isArray(content)) settleResults(running, content, row.toolUseResult);
      if (row.isMeta === true) continue;
      const text = typedText(row);
      if (text !== null) {
        entries.push(fromRecord({ kind: "user", text }, row.uuid, row.timestamp));
      } else if (row.isCompactSummary !== true) {
        // A compaction summary may quote an old command's tags; it is never one.
        const line = commandLine(content);
        if (line) command = fromRecord({ kind: "user", text: line }, row.uuid, row.timestamp);
      }
      continue;
    }

    if (row.type !== "assistant" || !Array.isArray(content)) continue;
    const uuid = typeof row.uuid === "string" ? row.uuid : undefined;
    for (let index = 0; index < content.length; index++) {
      const part = content[index] as Record<string, unknown> | null;
      if (part?.type === "text" && typeof part.text === "string") {
        const text = part.text.trim();
        // One block per row in every transcript on the builder's machine (CLI 2.1.x);
        // the index keeps several apart should a row hold more.
        const id = uuid && index > 0 ? `${uuid}:${index}` : uuid;
        if (text) entries.push(fromRecord({ kind: "assistant", text }, id, row.timestamp));
      } else if (part?.type === "tool_use" && typeof part.name === "string") {
        const entry = fromRecord(
          { kind: "tool", tool: part.name, text: summarizeTranscriptTool(part.name, part.input) ?? "" },
          part.id,
          row.timestamp
        );
        // Without an id no result can be matched to it, so it never counts as running.
        if (typeof part.id === "string") {
          entry.pending = true;
          running.set(part.id, entry);
        }
        entries.push(entry);
      }
    }
  }
  return entries;
}

// `id` and `at` from the record, when it has them.
function fromRecord(entry: TranscriptEntry, id: unknown, timestamp: unknown): TranscriptEntry {
  if (typeof id === "string" && id) entry.id = id;
  const at = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  if (Number.isFinite(at)) entry.at = at;
  return entry;
}

// The command line of a row that ran a command, as the builder typed it:
// `<command-name>/omt:work</command-name>` and its `<command-args>`.
function commandLine(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(content)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

// Settles the tool uses a user row answers. The CLI writes one result per row (every
// one of the 20 510 on the builder's machine), with the tool's own account of the call
// as the row's `toolUseResult`; that is read only when the row answers a single call,
// so it can't be credited to the wrong one.
function settleResults(
  running: Map<string, TranscriptEntry>,
  content: unknown[],
  toolUseResult: unknown
): void {
  const results = content.filter(
    (part): part is Record<string, unknown> =>
      (part as Record<string, unknown> | null)?.type === "tool_result" &&
      typeof (part as Record<string, unknown>).tool_use_id === "string"
  );
  for (const result of results) {
    const entry = running.get(result.tool_use_id as string);
    if (!entry) continue;
    running.delete(result.tool_use_id as string);
    delete entry.pending;
    entry.outcome = result.is_error === true ? "error" : "ok";
    if (entry.outcome === "ok" && results.length === 1) {
      Object.assign(entry, editedLines(toolUseResult));
    }
  }
}

// Lines an edit or a write changed, from the CLI's record of it: the hunks of its
// `structuredPatch` (Edit, and Write over an existing file), or the whole content of a
// file Write created (`type: "create"`, whose patch is empty).
function editedLines(result: unknown): { added: number; removed: number } | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.structuredPatch)) return undefined;
  if (record.type === "create" && typeof record.content === "string") {
    return { added: lineCount(record.content), removed: 0 };
  }
  let added = 0;
  let removed = 0;
  for (const hunk of record.structuredPatch as Array<{ lines?: unknown } | null>) {
    if (!Array.isArray(hunk?.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}
