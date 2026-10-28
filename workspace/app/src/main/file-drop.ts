// What a Finder drop on the window does to the disk: copy each dropped file into one
// folder. Copy, never move, and never overwrite: a name already taken gets a number,
// as Finder's "Keep Both" does (`report 2.docx`). Files only, and a drop past the
// limits (shared/dropLimits.ts) copies nothing. No `electron` import, so plain
// vitest runs it; the IPC in ipc-handlers.ts wraps it.

import fs from "fs";
import path from "path";
import { finderSize, MAX_DROP_BYTES, MAX_DROP_FILES, pastDropLimit } from "../shared/dropLimits";
import type { DropItemSize, PastDropLimit } from "../shared/dropLimits";

export interface DropCopied {
  ok: true;
  source: string;
  // Absolute, built on the target folder exactly as the caller passed it (not its
  // realpath), so the caller can make it relative to a project directory it holds in
  // the same form.
  destination: string;
  // The source's own name was taken, and the copy got a number.
  renamed: boolean;
}

export interface DropFailed {
  ok: false;
  source: string;
  // Short and plain, to stand after the file's name in a message: "no permission".
  reason: string;
}

export type DropCopyResult = DropCopied | DropFailed;

// Far past any real clash; only stops the loop if EEXIST somehow never ends.
const MAX_NUMBER = 9999;

/**
 * The name Finder gives the nth copy: `report 2.docx`. The number goes before the
 * last extension only (`a.tar 2.gz`); a name with none, or a dotfile, gets it at the
 * end (`Makefile 2`, `.env 2`). n = 1 is the name itself. Exported for the tests.
 */
export function numberedName(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf(".");
  // No dot, or only a leading one (".env"), or a trailing one ("notes."): no
  // extension.
  if (dot <= 0 || dot === name.length - 1) return `${name} ${n}`;
  return `${name.slice(0, dot)} ${n}${name.slice(dot)}`;
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** An fs error as the few words the drop message shows. Exported for the tests. */
export function plainReason(err: unknown): string {
  const code = errorCode(err);
  if (code === "EACCES" || code === "EPERM") return "no permission";
  if (code === "ENOSPC") return "disk full";
  if (code === "ENOENT") return "no longer exists";
  if (code === "EEXIST") return "already exists";
  if (!(err instanceof Error)) return String(err);
  // An fs error's message ends with the call and its full paths ("EIO: i/o error,
  // copyfile '/a' -> '/b'"). The message already names the file, so keep the start.
  const syscall = (err as NodeJS.ErrnoException).syscall;
  const tail = syscall ? err.message.indexOf(`, ${syscall} '`) : -1;
  return tail > 0 ? err.message.slice(0, tail) : err.message;
}

/**
 * What a dropped path is, for the drop's limits: lstat's, so a link counts as
 * itself, as it is copied. A path that can't be read (gone, say) counts as an empty
 * file rather than failing the whole drop; its copy then reports it.
 */
export async function describePath(p: string): Promise<DropItemSize> {
  try {
    const stat = await fs.promises.lstat(p);
    return { isDirectory: stat.isDirectory(), size: stat.size };
  } catch {
    return { isDirectory: false, size: 0 };
  }
}

// Why every file of a drop past a limit was left where it was.
function limitReason(past: PastDropLimit): string {
  switch (past.kind) {
    case "too-many":
      return `the drop has more than ${MAX_DROP_FILES} files`;
    case "folder":
      return "the drop has a folder";
    case "too-large":
      return `the drop is more than ${finderSize(MAX_DROP_BYTES)}`;
  }
}

/**
 * Try the source's name in the target folder, then `name 2`, `name 3`, … until
 * `claim` stops failing with EEXIST. `claim` must create the destination atomically
 * (an exclusive copy, a symlink), so a name that appears between two tries is
 * skipped rather than overwritten.
 */
async function claimName(
  targetDir: string,
  name: string,
  claim: (destination: string) => Promise<void>
): Promise<{ destination: string; renamed: boolean } | null> {
  for (let n = 1; n <= MAX_NUMBER; n++) {
    const destination = path.join(targetDir, numberedName(name, n));
    try {
      await claim(destination);
      return { destination, renamed: n > 1 };
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
  }
  return null;
}

// Make one entry at `destination`, which must not exist yet: an exclusive copy of a
// file, or the link itself with its target unchanged, as Finder copies one. Each
// fails with EEXIST rather than replace what is there.
async function createEntry(source: string, destination: string, stat: fs.Stats): Promise<void> {
  if (stat.isSymbolicLink()) {
    await fs.promises.symlink(await fs.promises.readlink(source), destination);
  } else {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

async function copyOne(source: string, targetDir: string): Promise<DropCopyResult> {
  if (!path.isAbsolute(source)) {
    return { ok: false, source, reason: "not an absolute path" };
  }
  try {
    const stat = await fs.promises.lstat(source);
    // The drop's check already refused folders; this one became a folder since.
    if (stat.isDirectory()) return { ok: false, source, reason: "is a folder" };
    // A socket or a pipe: copyFile would block reading a pipe forever.
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return { ok: false, source, reason: "not a file" };
    }
    const claimed = await claimName(targetDir, path.basename(source), (d) =>
      createEntry(source, d, stat)
    );
    if (!claimed) return { ok: false, source, reason: "too many copies with this name" };
    return { ok: true, source, ...claimed };
  } catch (err) {
    return { ok: false, source, reason: plainReason(err) };
  }
}

/**
 * Copy each source (an absolute path to a file) into `targetDir`, and return one
 * result per source, in order. Never throws. A drop past the limits, a folder in it
 * included, copies nothing: every source fails with the limit as its reason. Else
 * one source failing does not stop the others, and copies already made stay.
 */
export async function copyIntoFolder(
  sources: string[],
  targetDir: string
): Promise<DropCopyResult[]> {
  // The renderer checks this first; main does again, on its own. A drop that is too
  // many isn't looked at further.
  const items =
    sources.length > MAX_DROP_FILES ? [] : await Promise.all(sources.map(describePath));
  const past = pastDropLimit(sources.length, items);
  if (past) {
    const reason = limitReason(past);
    return sources.map((source) => ({ ok: false, source, reason }));
  }

  try {
    if (!path.isAbsolute(targetDir)) throw new Error("the target is not an absolute path");
    if (!(await fs.promises.stat(targetDir)).isDirectory()) {
      throw new Error("the target is not a folder");
    }
  } catch (err) {
    // Every source fails the same way. ENOENT here is the folder's, not the file's.
    const reason =
      errorCode(err) === "ENOENT" ? "the target folder no longer exists" : plainReason(err);
    return sources.map((source) => ({ ok: false, source, reason }));
  }

  const results: DropCopyResult[] = [];
  // One at a time: two sources with the same name (from different folders) then
  // number against each other in order, and results come back in the drop's order.
  for (const source of sources) {
    results.push(await copyOne(source, targetDir));
  }
  return results;
}

// ---------------------------------------------------------------------------
// How a drop's folders and copies are shown
// ---------------------------------------------------------------------------

// Whether `target` is `folder` or inside it, by the path strings alone, which is
// enough for showing a path.
function isPathInside(folder: string, target: string): boolean {
  const rel = path.relative(folder, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
  );
}

/**
 * A path as the drop dialog and message show it: relative to the project when it is
 * inside it (`docs/sources/inbox/`, the project itself `./`), otherwise absolute with
 * the home directory as `~` (`~/Downloads/`). A folder ends in `/`. All three paths are
 * absolute. `home` is passed in so tests never read the real one, and because the
 * renderer has none to use: main formats every path the renderer shows.
 */
export function displayPath(
  target: string,
  projectDir: string,
  home: string,
  isFolder: boolean
): string {
  const full = path.resolve(target);
  const slash = isFolder ? "/" : "";
  const project = path.resolve(projectDir);
  if (isPathInside(project, full)) {
    const rel = path.relative(project, full);
    return rel === "" ? "./" : rel + slash;
  }
  // "/" as home would turn every path into `~/…`; no home at all, the same.
  if (home && path.resolve(home) !== path.sep && isPathInside(path.resolve(home), full)) {
    const rel = path.relative(path.resolve(home), full);
    return rel === "" ? "~/" : `~/${rel}${slash}`;
  }
  return full === path.sep ? full : full + slash;
}

// ---------------------------------------------------------------------------
// The window a drop brings forward
// ---------------------------------------------------------------------------

/**
 * Whether a drop still waits on its dialog at `now`: `until` (epoch ms) is when the
 * renderer gives it up. Past that the renderer has abandoned the drop and handed the
 * keyboard back, so bringing the window forward would take the keys from whatever
 * app the builder went on to, with no dialog to show for it. Anything but a finite
 * number counts as past.
 */
export function dropStillWaiting(until: unknown, now: number): boolean {
  return typeof until === "number" && Number.isFinite(until) && now < until;
}
