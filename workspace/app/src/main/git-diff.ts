import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { DiffRow, DiffSide, FileDiff } from "../shared/types";

const execFileAsync = promisify(execFile);

// The shapes live in shared/types.ts because the renderer draws these rows and
// cannot import a main-process module. Re-exported so callers in main don't need
// to know which file they came from.
export type {
  DiffLineKind,
  DiffRow,
  DiffSide,
  FileDiff,
  FileDiffFailReason,
} from "../shared/types";

type FileDiffFail = Extract<FileDiff, { ok: false }>;

// Whole-file context: the right-hand line numbers are the file's real line
// numbers, which is what an @path:start-end reference depends on. Bounded rather
// than unlimited so a generated 500k-line file can't hand us its entire body.
const CONTEXT_LINES = 100000;
const MAX_ROWS_SHOWN = 5000;
const MAX_ROWS_TOTAL = 20000;
const BINARY_SNIFF_BYTES = 8192;
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

const COMPARISON: Record<DiffSide, string> = {
  unstaged: "working tree vs index",
  staged: "index vs HEAD",
  untracked: "new file",
};

interface PendingDel {
  oldLine: number;
  text: string;
}

interface PendingAdd {
  newLine: number;
  text: string;
}

export interface ParsedDiff {
  rows: DiffRow[];
  oldPath: string;
  newPath: string;
  binary: boolean;
}

/**
 * Parse `git diff`'s unified output into aligned old/new row pairs.
 *
 * Pure and exported so the tests exercise real git output as fixture text
 * without spawning anything.
 */
export function parseUnifiedDiff(stdout: string, relPath: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let oldPath = relPath;
  let newPath = relPath;
  let binary = false;

  let inHunk = false;
  let oldCounter = 0;
  let newCounter = 0;
  let pendingDels: PendingDel[] = [];
  let pendingAdds: PendingAdd[] = [];

  // Emit whatever deletions/additions have accumulated, zipping them into
  // `replace` rows as far as they pair up.
  const flush = () => {
    const paired = Math.min(pendingDels.length, pendingAdds.length);
    for (let i = 0; i < paired; i++) {
      rows.push({
        kind: "replace",
        oldLine: pendingDels[i].oldLine,
        newLine: pendingAdds[i].newLine,
        oldText: pendingDels[i].text,
        newText: pendingAdds[i].text,
      });
    }
    for (let i = paired; i < pendingDels.length; i++) {
      rows.push({
        kind: "del",
        oldLine: pendingDels[i].oldLine,
        newLine: null,
        oldText: pendingDels[i].text,
        newText: null,
      });
    }
    for (let i = paired; i < pendingAdds.length; i++) {
      rows.push({
        kind: "add",
        oldLine: null,
        newLine: pendingAdds[i].newLine,
        oldText: null,
        newText: pendingAdds[i].text,
      });
    }
    pendingDels = [];
    pendingAdds = [];
  };

  // Strip the single trailing newline before splitting, so the split can't
  // produce a phantom empty last line — inside a hunk an empty line is a blank
  // context line, and the two must not be confused.
  const lines = stdout.replace(/\n$/, "").split("\n");

  for (const line of lines) {
    // A new file header always ends the previous hunk. This is the only reliable
    // hunk terminator; a blank line is not one.
    if (line.startsWith("diff --git ")) {
      flush();
      inHunk = false;
      const paths = parseDiffGitPaths(line);
      if (paths) {
        oldPath = paths.oldPath;
        newPath = paths.newPath;
      }
      continue;
    }

    if (!inHunk) {
      // Preamble. `--- a/x` and `+++ b/y` live here and must not be read as
      // content, which is why hunk body handling is gated on inHunk.
      if (line.startsWith("rename from ")) {
        oldPath = line.slice("rename from ".length);
        continue;
      }
      if (line.startsWith("rename to ")) {
        newPath = line.slice("rename to ".length);
        continue;
      }
      if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        binary = true;
        continue;
      }
    }

    if (line.startsWith("@@")) {
      flush();
      const header = parseHunkHeader(line);
      if (header) {
        inHunk = true;
        oldCounter = header.oldStart;
        newCounter = header.newStart;
      }
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — a note about the line above, not content.
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);

    // `" "` is git's own marker for an unchanged line; a bare `""` is the same
    // thing with its trailing space eaten somewhere in transit. Both are context.
    if (marker === " " || line === "") {
      flush();
      rows.push({
        kind: "context",
        oldLine: oldCounter++,
        newLine: newCounter++,
        oldText: text,
        newText: text,
      });
      continue;
    }

    if (marker === "-") {
      // A '-' after '+' means the previous run is over; pairing only applies to
      // a run of deletions immediately followed by a run of additions.
      if (pendingAdds.length > 0) flush();
      pendingDels.push({ oldLine: oldCounter++, text });
      continue;
    }

    if (marker === "+") {
      pendingAdds.push({ newLine: newCounter++, text });
      continue;
    }

    // Anything else inside a hunk is output we don't model. Ignore the line
    // rather than guessing, and keep the counters untouched.
  }

  flush();

  return { rows, oldPath, newPath, binary };
}

function parseDiffGitPaths(
  line: string
): { oldPath: string; newPath: string } | null {
  // `diff --git a/old b/new`. Paths with spaces make this ambiguous in general;
  // the rename from/to lines that follow are authoritative when it matters, and
  // relPath is the fallback.
  const rest = line.slice("diff --git ".length);
  const match = /^a\/(.+) b\/(.+)$/.exec(rest);
  if (!match) return null;
  return { oldPath: match[1], newPath: match[2] };
}

function parseHunkHeader(
  line: string
): { oldStart: number; newStart: number } | null {
  // @@ -oldStart[,oldCount] +newStart[,newCount] @@ optional section heading
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1], 10),
    newStart: Number.parseInt(match[2], 10),
  };
}

/** Split a file's text into lines, dropping the empty tail a trailing \n leaves. */
export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Every line of a new file, as additions with an empty left side. */
export function rowsForNewFile(content: string): DiffRow[] {
  return splitLines(content).map((text, i) => ({
    kind: "add" as const,
    oldLine: null,
    newLine: i + 1,
    oldText: null,
    newText: text,
  }));
}

/** Cap the row count, reporting too-large past the hard limit. */
export function applyRowLimits(
  rows: DiffRow[]
): { rows: DiffRow[]; truncated: boolean } | FileDiffFail {
  if (rows.length > MAX_ROWS_TOTAL) {
    return {
      ok: false,
      reason: "too-large",
      detail: `${rows.length} lines`,
    };
  }
  if (rows.length > MAX_ROWS_SHOWN) {
    return { rows: rows.slice(0, MAX_ROWS_SHOWN), truncated: true };
  }
  return { rows, truncated: false };
}

/**
 * Whether a Git-section path really is inside the instance's project.
 *
 * The Git section only ever produces repo-relative paths, so anything absolute,
 * `~`-prefixed, or climbing out through `..` did not come from there and is
 * refused rather than resolved — diffs outside the cwd are out of scope.
 */
export function isInsideCwd(cwd: string, rawRelPath: string): boolean {
  if (!cwd) return false;
  const relPath = normalizeRelPath(rawRelPath);
  if (relPath === "") return false;
  if (relPath.startsWith("~")) return false;
  if (path.isAbsolute(relPath)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(relPath)) return false;

  const rel = path.relative(cwd, path.resolve(cwd, relPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A renamed entry arrives from `git status --porcelain` as "old -> new". The
 * diff is about the new path, so take that side.
 */
export function normalizeRelPath(relPath: string): string {
  const arrow = relPath.lastIndexOf(" -> ");
  return arrow >= 0 ? relPath.slice(arrow + 4) : relPath;
}

async function runGitDiff(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

function isMaxBufferError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The diff for one file, on one side, as rows the renderer can draw directly.
 *
 * Read-only by construction: the only git subcommand reachable from here is
 * `diff`.
 */
export async function getFileDiff(
  cwd: string,
  rawRelPath: string,
  side: DiffSide,
  oldPath?: string
): Promise<FileDiff> {
  const relPath = normalizeRelPath(rawRelPath);
  const comparison = COMPARISON[side];

  if (side === "untracked") {
    return diffForNewFile(cwd, relPath, comparison);
  }

  const args = ["diff", `--unified=${CONTEXT_LINES}`, "--no-color", "-M"];
  if (side === "staged") args.push("--cached");
  // Both sides of a rename go in the pathspec. Given only the new path, git has
  // nothing to pair it with and reports the whole file as added — measured against
  // a real `git mv` plus an edit, which came back as 223 additions.
  args.push("--", relPath);
  if (oldPath && oldPath !== relPath) args.push(oldPath);

  let stdout: string;
  try {
    stdout = await runGitDiff(cwd, args);
  } catch (err) {
    if (isMaxBufferError(err)) {
      return { ok: false, reason: "too-large", detail: "over 16 MB of output" };
    }
    return { ok: false, reason: "failed", detail: errorDetail(err) };
  }

  if (stdout.trim() === "") return { ok: false, reason: "no-changes" };

  const parsed = parseUnifiedDiff(stdout, relPath);
  if (parsed.binary) return { ok: false, reason: "binary" };
  if (parsed.rows.length === 0) return { ok: false, reason: "no-changes" };

  const limited = applyRowLimits(parsed.rows);
  if ("ok" in limited) return limited;

  return {
    ok: true,
    rows: limited.rows,
    oldPath: parsed.oldPath,
    newPath: parsed.newPath,
    comparison,
    truncated: limited.truncated,
  };
}

/**
 * An untracked file has no diff to ask git for. Read it and mark every line as
 * added — `git diff --no-index` was the alternative and exits 1 whenever there
 * is a difference, which execFile turns into a rejection.
 */
async function diffForNewFile(
  cwd: string,
  relPath: string,
  comparison: string
): Promise<FileDiff> {
  const abs = path.resolve(cwd, relPath);
  let buffer: Buffer;
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return { ok: false, reason: "not-found", detail: "path is a directory" };
    }
    buffer = fs.readFileSync(abs);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, reason: "not-found" };
    }
    return { ok: false, reason: "failed", detail: errorDetail(err) };
  }

  if (looksBinary(buffer)) return { ok: false, reason: "binary" };

  const rows = rowsForNewFile(buffer.toString("utf8"));
  if (rows.length === 0) return { ok: false, reason: "no-changes" };

  const limited = applyRowLimits(rows);
  if ("ok" in limited) return limited;

  return {
    ok: true,
    rows: limited.rows,
    oldPath: relPath,
    newPath: relPath,
    comparison,
    truncated: limited.truncated,
  };
}

/** A NUL byte near the start is how git itself decides a file is binary. */
export function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
