// What a Finder drop on the window does to the disk: copy each dropped file or folder
// into one folder. Copy, never move, and never overwrite: a name already taken gets a
// number, as Finder's "Keep Both" does (`report 2.docx`). No `electron` import, so
// plain vitest runs it; the IPC in ipc-handlers.ts wraps it.

import fs from "fs";
import path from "path";

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
  // Set when a folder copy stopped partway. What it copied stays (Multi-Code never
  // deletes anything), in the folder at `destination`, and the reason starts
  // "partly copied: ".
  partial?: true;
  destination?: string;
}

export type DropCopyResult = DropCopied | DropFailed;

// Far past any real clash; only stops the loop if EEXIST somehow never ends.
const MAX_NUMBER = 9999;

// A folder's name has an extension only when it looks like one (`report.pages`, a
// package), so a folder named `v1.2` becomes `v1.2 2`, not `v1 2.2`.
const FOLDER_EXTENSION = /^\.[A-Za-z][A-Za-z0-9]*$/;

/**
 * The name Finder gives the nth copy: `report 2.docx`. The number goes before the
 * last extension only (`a.tar 2.gz`); a name with none, or a dotfile, gets it at the
 * end (`assets 2`, `.env 2`). n = 1 is the name itself. Exported for the tests.
 */
export function numberedName(name: string, n: number, isFolder = false): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf(".");
  // No dot, or only a leading one (".env"): no extension.
  const ext = dot > 0 ? name.slice(dot) : "";
  const hasExt = isFolder ? FOLDER_EXTENSION.test(ext) : ext.length > 1;
  if (!hasExt) return `${name} ${n}`;
  return `${name.slice(0, dot)} ${n}${ext}`;
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
  return err instanceof Error ? err.message : String(err);
}

export interface FileId {
  dev: bigint;
  ino: bigint;
}

// Which folder a path is, whatever path names it. bigint, because a 64-bit inode
// number can be past what a JS number holds exactly.
async function fileId(p: string): Promise<FileId> {
  const { dev, ino } = await fs.promises.stat(p, { bigint: true });
  return { dev, ino };
}

const SAME_FOLDER = "can't copy a folder into itself";

/**
 * Whether `realTarget` (a realpath) is `folder` or inside it, compared by device and
 * inode up the target's parents to `/`, not by path: macOS gives one folder two
 * realpaths through a firmlink (`/Users/…` and `/System/Volumes/Data/Users/…`).
 * `idOf` is a parameter for the tests. Exported for the tests.
 */
export async function isSameOrInside(
  folder: string,
  realTarget: string,
  idOf: (p: string) => Promise<FileId> = fileId
): Promise<boolean> {
  const { dev, ino } = await idOf(folder);
  for (let dir = realTarget; ; dir = path.dirname(dir)) {
    const id = await idOf(dir);
    if (id.dev === dev && id.ino === ino) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * Try the source's name in the target folder, then `name 2`, `name 3`, … until
 * `claim` stops failing with EEXIST. `claim` must create the destination atomically
 * (an exclusive copy, mkdir, symlink), so a name that appears between two tries is
 * skipped rather than overwritten.
 */
async function claimName(
  targetDir: string,
  name: string,
  isFolder: boolean,
  claim: (destination: string) => Promise<void>
): Promise<{ destination: string; renamed: boolean } | null> {
  for (let n = 1; n <= MAX_NUMBER; n++) {
    const destination = path.join(targetDir, numberedName(name, n, isFolder));
    try {
      await claim(destination);
      return { destination, renamed: n > 1 };
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
  }
  return null;
}

// Make one entry at `destination`, which must not exist yet: an empty folder (its
// contents come after), an exclusive copy of a file, or the link itself with its
// target unchanged, as Finder copies one. Each fails with EEXIST rather than replace
// what is there.
async function createEntry(
  source: string,
  destination: string,
  stat: fs.Stats | fs.BigIntStats
): Promise<void> {
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destination);
  } else if (stat.isFile()) {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } else if (stat.isSymbolicLink()) {
    await fs.promises.symlink(await fs.promises.readlink(source), destination);
  } else {
    // A socket or a pipe: copyFile would block reading a pipe forever.
    throw new Error(`${path.basename(source)} is not a file or folder`);
  }
}

// Copy a folder's contents into `destination`, a folder createEntry just made, and
// give it the source's mode last, so a read-only source folder can still be filled.
// This walk stands in for fs.promises.cp, which replaces a link already at a
// destination whatever its options say (Node 22 and 24: onLink, then copyLink
// unlinks it). Here every create is exclusive, and a name taken inside the new
// folder (something else wrote into it meanwhile) is an error, not a rename.
//
// `copyId` is the copy's own top folder. Links are never followed, so the walk can
// only reach it through a real folder entry, which isSameOrInside rules out before
// the copy starts. The check here is for what that can't see: a bind mount, a
// hard-linked folder, or a firmlink between a folder and its parent.
async function fillFolder(
  source: string,
  destination: string,
  mode: number,
  copyId: FileId
): Promise<void> {
  // In name order, so a copy that stops partway has a predictable part.
  for (const entry of (await fs.promises.readdir(source)).sort()) {
    const from = path.join(source, entry);
    const to = path.join(destination, entry);
    const stat = await fs.promises.lstat(from, { bigint: true });
    if (stat.isDirectory() && stat.dev === copyId.dev && stat.ino === copyId.ino) {
      throw new Error(SAME_FOLDER);
    }
    await createEntry(from, to, stat);
    if (stat.isDirectory()) await fillFolder(from, to, Number(stat.mode), copyId);
  }
  await fs.promises.chmod(destination, mode & 0o7777);
}

async function copyOne(
  source: string,
  targetDir: string,
  realTarget: string
): Promise<DropCopyResult> {
  if (!path.isAbsolute(source)) {
    return { ok: false, source, reason: "not an absolute path" };
  }
  try {
    const stat = await fs.promises.lstat(source);
    const isFolder = stat.isDirectory();
    if (!isFolder && !stat.isFile() && !stat.isSymbolicLink()) {
      return { ok: false, source, reason: "not a file or folder" };
    }
    if (isFolder && (await isSameOrInside(source, realTarget))) {
      return { ok: false, source, reason: SAME_FOLDER };
    }

    const claimed = await claimName(targetDir, path.basename(source), isFolder, (d) =>
      createEntry(source, d, stat)
    );
    if (!claimed) return { ok: false, source, reason: "too many copies with this name" };

    if (isFolder) {
      try {
        const copyId = await fileId(claimed.destination);
        await fillFolder(source, claimed.destination, stat.mode, copyId);
      } catch (err) {
        // What was copied stays: Multi-Code never deletes, and the folder may by now
        // hold something that isn't ours. The result says it is incomplete.
        return {
          ok: false,
          source,
          reason: `partly copied: ${plainReason(err)}`,
          partial: true,
          destination: claimed.destination,
        };
      }
    }
    return { ok: true, source, ...claimed };
  } catch (err) {
    return { ok: false, source, reason: plainReason(err) };
  }
}

/**
 * Copy each source (an absolute path to a file or folder) into `targetDir`, and
 * return one result per source, in order. Never throws. One source failing does not
 * stop the others, and copies already made stay.
 */
export async function copyIntoFolder(
  sources: string[],
  targetDir: string
): Promise<DropCopyResult[]> {
  let realTarget: string;
  try {
    if (!path.isAbsolute(targetDir)) throw new Error("the target is not an absolute path");
    if (!(await fs.promises.stat(targetDir)).isDirectory()) {
      throw new Error("the target is not a folder");
    }
    realTarget = await fs.promises.realpath(targetDir);
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
    results.push(await copyOne(source, targetDir, realTarget));
  }
  return results;
}

// ---------------------------------------------------------------------------
// How a drop's folders and copies are shown
// ---------------------------------------------------------------------------

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
  if (isSameOrInside(project, full)) {
    const rel = path.relative(project, full);
    return rel === "" ? "./" : rel + slash;
  }
  // "/" as home would turn every path into `~/…`; no home at all, the same.
  if (home && path.resolve(home) !== path.sep && isSameOrInside(path.resolve(home), full)) {
    const rel = path.relative(path.resolve(home), full);
    return rel === "" ? "~/" : `~/${rel}${slash}`;
  }
  return full === path.sep ? full : full + slash;
}
