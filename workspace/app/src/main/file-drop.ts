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
}

export type DropCopyResult = DropCopied | DropFailed;

// Far past any real clash; only stops the loop if EEXIST somehow never ends.
const MAX_NUMBER = 9999;

/**
 * The name Finder gives the nth copy: `report 2.docx`. The number goes before the
 * last extension only (`a.tar 2.gz`); a name with none, or a dotfile, gets it at the
 * end (`assets 2`, `.env 2`). n = 1 is the name itself. Exported for the tests.
 */
export function numberedName(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf(".");
  // No dot, only a leading one (".env"), or a trailing one: no extension.
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
  return err instanceof Error ? err.message : String(err);
}

// Both paths already realpath'd, so a symlinked parent or a different letter case
// (macOS's default disk ignores case) can't hide that one is inside the other.
function isSameOrInside(folder: string, target: string): boolean {
  const rel = path.relative(folder, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
  );
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

// Fill a folder claimName just made with mkdir, the one way to take a folder name
// atomically. cp with errorOnExist refuses a folder that exists, even this empty one,
// so each entry is copied into it on its own. Symlinks are copied as links with their
// target unchanged, as Finder does.
async function fillFolder(source: string, destination: string, mode: number): Promise<void> {
  try {
    for (const entry of await fs.promises.readdir(source)) {
      await fs.promises.cp(path.join(source, entry), path.join(destination, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
        mode: fs.constants.COPYFILE_EXCL,
      });
    }
    // cp sets a folder's mode only when it makes the folder itself.
    await fs.promises.chmod(destination, mode & 0o7777);
  } catch (err) {
    // Half a folder would pass for the whole one. The folder is new (mkdir just made
    // it) and holds only what this copy put there, so take it back.
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
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
    const name = path.basename(source);
    let claimed: { destination: string; renamed: boolean } | null;

    if (stat.isDirectory()) {
      const realSource = await fs.promises.realpath(source);
      if (isSameOrInside(realSource, realTarget)) {
        return { ok: false, source, reason: "can't copy a folder into itself" };
      }
      claimed = await claimName(targetDir, name, (d) => fs.promises.mkdir(d));
      if (claimed) await fillFolder(source, claimed.destination, stat.mode);
    } else if (stat.isFile()) {
      claimed = await claimName(targetDir, name, (d) =>
        fs.promises.copyFile(source, d, fs.constants.COPYFILE_EXCL)
      );
    } else if (stat.isSymbolicLink()) {
      // The link itself, not what it points to, as Finder copies one.
      const linkTarget = await fs.promises.readlink(source);
      claimed = await claimName(targetDir, name, (d) =>
        fs.promises.symlink(linkTarget, d)
      );
    } else {
      // A socket or a pipe: copyFile would block reading a pipe forever.
      return { ok: false, source, reason: "not a file or folder" };
    }

    if (!claimed) return { ok: false, source, reason: "too many copies with this name" };
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
