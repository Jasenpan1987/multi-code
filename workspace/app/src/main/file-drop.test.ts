// The one promise this module makes is that a drop loses nothing: the original stays,
// and nothing already in the target folder is ever written over. And a drop past
// the limits copies nothing at all. Every test runs in its own temp directory, never
// in HOME or the repo, and no test makes a big file: sizes past the limit are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  copyIntoFolder,
  describePath,
  dropStillWaiting,
  numberedName,
  plainReason,
} from "./file-drop";

let root = "";
let src = "";
let target = "";

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

// Every path under `dir` with what it holds: a file's text, a link's target, or
// "dir". Two equal snapshots mean the same tree.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const full = path.join(dir, entry);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) out[entry] = `-> ${fs.readlinkSync(full)}`;
    else if (stat.isDirectory()) out[entry] = "dir";
    else out[entry] = read(full);
  }
  return out;
}

// `n` small files in the drop's source folder, a.txt, b.txt, …
function smallFiles(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    write(path.join(src, `${String.fromCharCode(97 + i)}.txt`), `file ${i}`)
  );
}

// lstat as it is, but with the sizes given for these paths: the limit can be met
// without a gigabyte on disk.
function fakeSizes(sizes: Record<string, number>): void {
  const realLstat = fs.promises.lstat;
  vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike) => {
    const stat = await realLstat(p);
    if (typeof p === "string" && p in sizes) stat.size = sizes[p];
    return stat;
  }) as typeof fs.promises.lstat);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-drop-"));
  src = path.join(root, "src");
  target = path.join(root, "target");
  fs.mkdirSync(src);
  fs.mkdirSync(target);
});

// An unreadable test file would stop rm; give everything back its permissions.
function unlock(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.lstatSync(full).isSymbolicLink()) continue;
    fs.chmodSync(full, 0o755);
    if (fs.statSync(full).isDirectory()) unlock(full);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("numberedName", () => {
  it("puts the number before the extension", () => {
    expect(numberedName("report.docx", 2)).toBe("report 2.docx");
    expect(numberedName("report.docx", 3)).toBe("report 3.docx");
  });

  it("uses the last extension only", () => {
    expect(numberedName("backup.tar.gz", 2)).toBe("backup.tar 2.gz");
  });

  it("puts the number at the end of a name with no extension, or a dotfile", () => {
    expect(numberedName("Makefile", 2)).toBe("Makefile 2");
    expect(numberedName(".env", 2)).toBe(".env 2");
    expect(numberedName("notes.", 2)).toBe("notes. 2");
  });

  it("leaves the name alone for the first copy", () => {
    expect(numberedName("report.docx", 1)).toBe("report.docx");
  });

  it("takes any last extension on a file", () => {
    expect(numberedName("archive.7z", 2)).toBe("archive 2.7z");
    expect(numberedName("photos.2024", 2)).toBe("photos 2.2024");
  });
});

describe("plainReason", () => {
  function err(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: something, copyfile 'a' -> 'b'`), { code });
  }

  it("says the common failures in plain words", () => {
    expect(plainReason(err("EACCES"))).toBe("no permission");
    expect(plainReason(err("EPERM"))).toBe("no permission");
    expect(plainReason(err("ENOSPC"))).toBe("disk full");
    expect(plainReason(err("ENOENT"))).toBe("no longer exists");
  });

  it("says a name taken meanwhile is already there", () => {
    expect(plainReason(err("EEXIST"))).toBe("already exists");
  });

  it("drops the call and the paths from an fs error, which the message names already", () => {
    const io = Object.assign(new Error("EIO: i/o error, copyfile '/a/x.md' -> '/b/x.md'"), {
      code: "EIO",
      syscall: "copyfile",
    });
    expect(plainReason(io)).toBe("EIO: i/o error");
  });

  it("falls back to the error's own message", () => {
    expect(plainReason(err("EIO"))).toBe("EIO: something, copyfile 'a' -> 'b'");
  });
});

describe("dropStillWaiting", () => {
  const until = 1_700_000_010_000;

  it("brings the window forward before the drop is given up", () => {
    expect(dropStillWaiting(until, until - 9_999)).toBe(true);
    expect(dropStillWaiting(until, until - 1)).toBe(true);
  });

  it("refuses once the renderer has given the drop up", () => {
    expect(dropStillWaiting(until, until)).toBe(false);
    expect(dropStillWaiting(until, until + 60_000)).toBe(false);
  });

  it("refuses a call with no usable deadline", () => {
    for (const bad of [undefined, null, "1700000010000", NaN, Infinity, {}]) {
      expect(dropStillWaiting(bad, until - 1)).toBe(false);
    }
  });
});

describe("describePath", () => {
  it("gives a file's size and says it is no folder", async () => {
    const file = write(path.join(src, "report.docx"), "12345");
    expect(await describePath(file)).toEqual({ isDirectory: false, size: 5 });
  });

  it("says a folder is one", async () => {
    fs.mkdirSync(path.join(src, "assets"));
    expect(await describePath(path.join(src, "assets"))).toMatchObject({ isDirectory: true });
  });

  it("counts a link as itself, not what it points at", async () => {
    const big = write(path.join(src, "big.bin"), "x".repeat(4096));
    fs.symlinkSync(big, path.join(src, "file-link"));
    fs.symlinkSync(src, path.join(src, "folder-link"));

    expect(await describePath(path.join(src, "file-link"))).toEqual({
      isDirectory: false,
      size: big.length,
    });
    expect(await describePath(path.join(src, "folder-link"))).toEqual({
      isDirectory: false,
      size: src.length,
    });
  });

  it("counts a path that is gone as an empty file rather than failing", async () => {
    expect(await describePath(path.join(src, "gone.txt"))).toEqual({
      isDirectory: false,
      size: 0,
    });
  });
});

describe("copyIntoFolder", () => {
  it("copies a file and leaves the original where it was", async () => {
    const file = write(path.join(src, "report.docx"), "draft");

    const results = await copyIntoFolder([file], target);

    expect(results).toEqual([
      {
        ok: true,
        source: file,
        destination: path.join(target, "report.docx"),
        renamed: false,
      },
    ]);
    expect(read(path.join(target, "report.docx"))).toBe("draft");
    expect(read(file)).toBe("draft");
  });

  it("gives a clashing name the next free number: report 2, then report 3", async () => {
    const file = write(path.join(src, "report.docx"), "new");
    write(path.join(target, "report.docx"), "old");

    const [second] = await copyIntoFolder([file], target);
    expect(second).toEqual({
      ok: true,
      source: file,
      destination: path.join(target, "report 2.docx"),
      renamed: true,
    });

    const [third] = await copyIntoFolder([file], target);
    expect(third).toMatchObject({ ok: true, destination: path.join(target, "report 3.docx") });

    expect(read(path.join(target, "report.docx"))).toBe("old");
    expect(read(path.join(target, "report 2.docx"))).toBe("new");
    expect(read(path.join(target, "report 3.docx"))).toBe("new");
  });

  it("numbers a dotfile and a name with no extension at the end", async () => {
    const env = write(path.join(src, ".env"), "KEY=new");
    const makefile = write(path.join(src, "Makefile"), "new");
    write(path.join(target, ".env"), "KEY=old");
    write(path.join(target, "Makefile"), "old");

    const results = await copyIntoFolder([env, makefile], target);

    expect(results.map((r) => r.ok && path.basename(r.destination))).toEqual([
      ".env 2",
      "Makefile 2",
    ]);
    expect(read(path.join(target, ".env"))).toBe("KEY=old");
    expect(read(path.join(target, ".env 2"))).toBe("KEY=new");
    expect(read(path.join(target, "Makefile 2"))).toBe("new");
  });

  it("numbers two dropped files with the same name against each other", async () => {
    const a = write(path.join(src, "a", "notes.md"), "from a");
    const b = write(path.join(src, "b", "notes.md"), "from b");

    const results = await copyIntoFolder([a, b], target);

    expect(results.map((r) => r.ok && r.renamed)).toEqual([false, true]);
    expect(read(path.join(target, "notes.md"))).toBe("from a");
    expect(read(path.join(target, "notes 2.md"))).toBe("from b");
  });

  it("copies 10 files in one drop", async () => {
    const files = smallFiles(10);

    const results = await copyIntoFolder(files, target);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(fs.readdirSync(target)).toHaveLength(10);
  });

  it("copies nothing of 11 files, and says why for each", async () => {
    const files = smallFiles(11);

    const results = await copyIntoFolder(files, target);

    expect(results).toEqual(
      files.map((source) => ({
        ok: false,
        source,
        reason: "the drop has more than 10 files",
      }))
    );
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("copies exactly 1 GB in all", async () => {
    const [a, b] = smallFiles(2);
    fakeSizes({ [a]: 600_000_000, [b]: 400_000_000 });

    const results = await copyIntoFolder([a, b], target);

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(fs.readdirSync(target).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("copies nothing of a drop 1 byte past 1 GB", async () => {
    const [a, b] = smallFiles(2);
    fakeSizes({ [a]: 600_000_000, [b]: 400_000_001 });

    const results = await copyIntoFolder([a, b], target);

    expect(results).toEqual([
      { ok: false, source: a, reason: "the drop is more than 1 GB" },
      { ok: false, source: b, reason: "the drop is more than 1 GB" },
    ]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("copies nothing of a drop with a folder in it, alone or with files", async () => {
    const assets = path.join(src, "assets");
    write(path.join(assets, "logo.svg"), "<svg/>");
    const file = write(path.join(src, "report.docx"), "draft");

    expect(await copyIntoFolder([assets], target)).toEqual([
      { ok: false, source: assets, reason: "the drop has a folder" },
    ]);
    expect(await copyIntoFolder([file, assets], target)).toEqual([
      { ok: false, source: file, reason: "the drop has a folder" },
      { ok: false, source: assets, reason: "the drop has a folder" },
    ]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("copies a link to a folder as a link: it is not a folder", async () => {
    fs.mkdirSync(path.join(src, "assets"));
    const link = path.join(src, "assets-link");
    fs.symlinkSync(path.join(src, "assets"), link);

    const [result] = await copyIntoFolder([link], target);

    expect(result).toMatchObject({ ok: true, destination: path.join(target, "assets-link") });
    expect(fs.lstatSync(path.join(target, "assets-link")).isSymbolicLink()).toBe(true);
  });

  it("refuses a file that became a folder after the drop was checked", async () => {
    const file = write(path.join(src, "a.txt"), "a");
    const swapped = path.join(src, "assets");
    write(path.join(swapped, "inside.txt"), "inside");
    // The check sees a file there; the copy, a moment later, a folder.
    const realLstat = fs.promises.lstat;
    let checked = false;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike) => {
      if (p === swapped && !checked) {
        checked = true;
        return realLstat(file);
      }
      return realLstat(p);
    }) as typeof fs.promises.lstat);

    const results = await copyIntoFolder([swapped, file], target);

    expect(results).toEqual([
      { ok: false, source: swapped, reason: "is a folder" },
      { ok: true, source: file, destination: path.join(target, "a.txt"), renamed: false },
    ]);
    expect(fs.readdirSync(target)).toEqual(["a.txt"]);
  });

  it("reports a missing source as no longer there and copies the others", async () => {
    const gone = path.join(src, "gone.txt");
    const file = write(path.join(src, "here.txt"), "here");

    const results = await copyIntoFolder([gone, file], target);

    expect(results).toEqual([
      { ok: false, source: gone, reason: "no longer exists" },
      { ok: true, source: file, destination: path.join(target, "here.txt"), renamed: false },
    ]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "names a file it can't read, and copies the others",
    async () => {
      const locked = write(path.join(src, "secret.txt"), "secret");
      fs.chmodSync(locked, 0o000);
      const file = write(path.join(src, "report.docx"), "draft");

      const results = await copyIntoFolder([locked, file], target);

      expect(results).toEqual([
        { ok: false, source: locked, reason: "no permission" },
        { ok: true, source: file, destination: path.join(target, "report.docx"), renamed: false },
      ]);
      expect(fs.readdirSync(target)).toEqual(["report.docx"]);
    }
  );

  it("fails every source the same way when the target folder is gone", async () => {
    const file = write(path.join(src, "report.docx"), "draft");
    const missing = path.join(root, "deleted");

    expect(await copyIntoFolder([file], missing)).toEqual([
      { ok: false, source: file, reason: "the target folder no longer exists" },
    ]);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("refuses a target that is a file", async () => {
    const file = write(path.join(src, "report.docx"), "draft");
    const notAFolder = write(path.join(root, "plain.txt"), "plain");

    expect(await copyIntoFolder([file], notAFolder)).toEqual([
      { ok: false, source: file, reason: "the target is not a folder" },
    ]);
    expect(read(notAFolder)).toBe("plain");
  });

  it("refuses a pipe without waiting on it, and copies the others", async () => {
    const pipe = path.join(src, "pipe");
    execFileSync("mkfifo", [pipe]);
    const file = write(path.join(src, "a.txt"), "a");

    const results = await copyIntoFolder([pipe, file], target);

    expect(results).toEqual([
      { ok: false, source: pipe, reason: "not a file" },
      { ok: true, source: file, destination: path.join(target, "a.txt"), renamed: false },
    ]);
    expect(fs.readdirSync(target)).toEqual(["a.txt"]);
  });

  it("copies a link as a link", async () => {
    const real = write(path.join(src, "real.txt"), "real");
    const link = path.join(src, "link.txt");
    fs.symlinkSync(real, link);

    const [result] = await copyIntoFolder([link], target);

    expect(result).toMatchObject({ ok: true, destination: path.join(target, "link.txt") });
    expect(fs.readlinkSync(path.join(target, "link.txt"))).toBe(real);
  });

  it("never writes over a file that appears while it copies", async () => {
    const file = write(path.join(src, "report.docx"), "new");
    const realCopyFile = fs.promises.copyFile;
    let raced = false;
    // Another app creates report.docx just after the clash check would have passed.
    vi.spyOn(fs.promises, "copyFile").mockImplementation(async (from, to, mode) => {
      if (!raced) {
        raced = true;
        fs.writeFileSync(to as string, "theirs");
      }
      return realCopyFile(from, to, mode);
    });

    const [result] = await copyIntoFolder([file], target);

    expect(result).toMatchObject({ ok: true, destination: path.join(target, "report 2.docx") });
    expect(read(path.join(target, "report.docx"))).toBe("theirs");
    expect(read(path.join(target, "report 2.docx"))).toBe("new");
  });

  it("never writes through a link already in the target", async () => {
    const outside = write(path.join(root, "outside.txt"), "untouched");
    fs.symlinkSync(outside, path.join(target, "report.docx"));
    fs.symlinkSync(path.join(root, "nowhere"), path.join(target, "report 2.docx"));
    const file = write(path.join(src, "report.docx"), "new");

    const [result] = await copyIntoFolder([file], target);

    expect(result).toMatchObject({ ok: true, destination: path.join(target, "report 3.docx") });
    expect(read(outside)).toBe("untouched");
    expect(fs.existsSync(path.join(root, "nowhere"))).toBe(false);
  });

  it("leaves everything already in the target as it was", async () => {
    write(path.join(target, "report.docx"), "old report");
    write(path.join(target, "report 2.docx"), "older report");
    write(path.join(target, ".env"), "KEY=old");
    write(path.join(target, "assets", "logo.svg"), "old logo");
    const before = snapshot(target);

    const sources = [
      write(path.join(src, "report.docx"), "new report"),
      write(path.join(src, ".env"), "KEY=new"),
      write(path.join(src, "assets"), "a file named like the folder"),
    ];

    const results = await copyIntoFolder(sources, target);

    expect(results.every((r) => r.ok && r.renamed)).toBe(true);
    const after = snapshot(target);
    for (const [entry, content] of Object.entries(before)) {
      expect(after[entry]).toBe(content);
    }
    expect(after["report 3.docx"]).toBe("new report");
    expect(after["assets 2"]).toBe("a file named like the folder");
  });
});
