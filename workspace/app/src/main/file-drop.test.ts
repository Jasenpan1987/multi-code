// The one promise this module makes is that a drop loses nothing: the original stays,
// and nothing already in the target folder is ever written over. Every test runs in
// its own temp directory, never in HOME or the repo.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { copyIntoFolder, isSameOrInside, numberedName, plainReason } from "./file-drop";

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-drop-"));
  src = path.join(root, "src");
  target = path.join(root, "target");
  fs.mkdirSync(src);
  fs.mkdirSync(target);
});

afterEach(() => {
  vi.restoreAllMocks();
  // An unreadable test file would stop rm; give everything back its permissions.
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const full = path.join(root, entry);
    if (!fs.lstatSync(full).isSymbolicLink()) fs.chmodSync(full, 0o755);
  }
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
    expect(numberedName("assets", 2)).toBe("assets 2");
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

  it("takes a folder's extension only when it starts with a letter", () => {
    expect(numberedName("report.pages", 2, true)).toBe("report 2.pages");
    expect(numberedName("Tool.app", 2, true)).toBe("Tool 2.app");
    expect(numberedName("v1.2", 2, true)).toBe("v1.2 2");
    expect(numberedName("archive.7z", 2, true)).toBe("archive.7z 2");
    expect(numberedName("my.notes-old", 2, true)).toBe("my.notes-old 2");
    expect(numberedName(".github", 2, true)).toBe(".github 2");
    expect(numberedName("assets", 2, true)).toBe("assets 2");
  });
});

describe("isSameOrInside", () => {
  // Fake ids, so the case that matters can be made anywhere: two different paths
  // for one folder, as a macOS firmlink gives.
  const ids: Record<string, bigint> = {
    "/": 1n,
    "/Users": 2n,
    "/Users/me": 3n,
    "/Users/me/project": 4n,
    "/Users/me/project/inbox": 5n,
    "/Users/me/other": 6n,
    "/System": 7n,
    "/System/Volumes": 8n,
    "/System/Volumes/Data": 9n,
    "/System/Volumes/Data/Users": 2n,
    "/System/Volumes/Data/Users/me": 3n,
    "/System/Volumes/Data/Users/me/project": 4n,
    "/System/Volumes/Data/Users/me/project/inbox": 5n,
  };
  const idOf = async (p: string) => {
    if (!(p in ids)) throw new Error(`unexpected stat of ${p}`);
    return { dev: 1n, ino: ids[p] };
  };

  it("finds the folder in the target's parents under another path", async () => {
    const inbox = "/System/Volumes/Data/Users/me/project/inbox";
    expect(await isSameOrInside("/Users/me/project", inbox, idOf)).toBe(true);
    expect(await isSameOrInside("/Users/me/project/inbox", inbox, idOf)).toBe(true);
  });

  it("says no for a sibling, and for a parent's other child", async () => {
    expect(await isSameOrInside("/Users/me/other", "/Users/me/project/inbox", idOf)).toBe(
      false
    );
    expect(await isSameOrInside("/Users/me/project/inbox", "/Users/me/project", idOf)).toBe(
      false
    );
  });

  it("tells apart a folder on another disk that has the same inode number", async () => {
    const withUsb = async (p: string) =>
      p === "/Volumes/USB/project" ? { dev: 2n, ino: ids["/Users/me/project"] } : idOf(p);
    expect(
      await isSameOrInside("/Volumes/USB/project", "/Users/me/project/inbox", withUsb)
    ).toBe(false);
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

  it("falls back to the error's own message", () => {
    expect(plainReason(err("EIO"))).toBe("EIO: something, copyfile 'a' -> 'b'");
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

  it("copies a folder whole, subfolders, dotfiles and links included", async () => {
    const assets = path.join(src, "assets");
    write(path.join(assets, "logo.svg"), "<svg/>");
    write(path.join(assets, ".gitkeep"), "");
    write(path.join(assets, "icons", "small", "dot.png"), "png");
    fs.mkdirSync(path.join(assets, "empty"));
    fs.symlinkSync("logo.svg", path.join(assets, "icons", "logo-link.svg"));
    const before = snapshot(assets);

    const results = await copyIntoFolder([assets], target);

    expect(results).toEqual([
      {
        ok: true,
        source: assets,
        destination: path.join(target, "assets"),
        renamed: false,
      },
    ]);
    expect(snapshot(path.join(target, "assets"))).toEqual(before);
    // The link is still a link, pointing where it did, as Finder copies one.
    expect(fs.readlinkSync(path.join(target, "assets", "icons", "logo-link.svg"))).toBe(
      "logo.svg"
    );
    expect(snapshot(assets)).toEqual(before);
  });

  it("gives a clashing folder a number and never merges into the one there", async () => {
    const assets = path.join(src, "assets");
    write(path.join(assets, "logo.svg"), "new");
    write(path.join(target, "assets", "logo.svg"), "old");
    write(path.join(target, "assets", "keep.txt"), "old");

    const [result] = await copyIntoFolder([assets], target);

    expect(result).toMatchObject({ ok: true, destination: path.join(target, "assets 2") });
    expect(snapshot(path.join(target, "assets"))).toEqual({
      "logo.svg": "old",
      "keep.txt": "old",
    });
    expect(snapshot(path.join(target, "assets 2"))).toEqual({ "logo.svg": "new" });
  });

  it("refuses a folder into itself or its own subfolder, and still copies the rest", async () => {
    const project = path.join(src, "project");
    write(path.join(project, "inbox", "old.txt"), "old");
    const file = write(path.join(src, "report.docx"), "draft");

    const intoSub = await copyIntoFolder([project, file], path.join(project, "inbox"));
    expect(intoSub).toEqual([
      { ok: false, source: project, reason: "can't copy a folder into itself" },
      {
        ok: true,
        source: file,
        destination: path.join(project, "inbox", "report.docx"),
        renamed: false,
      },
    ]);

    const [intoSelf] = await copyIntoFolder([project], project);
    expect(intoSelf).toEqual({
      ok: false,
      source: project,
      reason: "can't copy a folder into itself",
    });

    // The folder holds only what it held, plus the one file that was allowed in.
    expect(snapshot(project)).toEqual({
      inbox: "dir",
      "inbox/old.txt": "old",
      "inbox/report.docx": "draft",
    });
  });

  it("sees through a symlinked path to the same folder", async () => {
    const project = path.join(src, "project");
    fs.mkdirSync(path.join(project, "inbox"), { recursive: true });
    const alias = path.join(root, "alias");
    fs.symlinkSync(project, alias);

    const [result] = await copyIntoFolder([project], path.join(alias, "inbox"));

    expect(result).toEqual({
      ok: false,
      source: project,
      reason: "can't copy a folder into itself",
    });
    expect(fs.readdirSync(path.join(project, "inbox"))).toEqual([]);
  });

  // The real case behind the device-and-inode check: on macOS the temp folder can
  // also be reached through the Data volume, and realpath keeps the two apart. A
  // path compare missed it, and the walk copied its own output into itself.
  it.skipIf(process.platform !== "darwin")(
    "refuses a folder into itself through the Data volume's path for it",
    async () => {
      const project = fs.realpathSync(src);
      write(path.join(project, "inbox", "old.txt"), "old");
      const viaData = path.join("/System/Volumes/Data", project, "inbox");
      expect(fs.realpathSync(viaData)).not.toBe(path.join(project, "inbox"));

      const [result] = await copyIntoFolder([project], viaData);

      expect(result).toEqual({ ok: false, source: project, reason: "can't copy a folder into itself" });
      expect(fs.readdirSync(path.join(project, "inbox"))).toEqual(["old.txt"]);
    }
  );

  it("stops if the walk ever meets the copy it is making", async () => {
    const assets = path.join(src, "assets");
    write(path.join(assets, "a.txt"), "a");
    fs.mkdirSync(path.join(assets, "loop"));
    const copied = path.join(target, "assets");
    // As a bind mount would: assets/loop is, on disk, the copy itself.
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation(((p: fs.PathLike, options?: any) =>
      realLstat(p === path.join(assets, "loop") ? copied : p, options)) as typeof fs.promises.lstat);

    const [result] = await copyIntoFolder([assets], target);

    expect(result).toEqual({
      ok: false,
      source: assets,
      reason: "partly copied: can't copy a folder into itself",
      partial: true,
      destination: copied,
    });
    expect(snapshot(copied)).toEqual({ "a.txt": "a" });
  });

  it("copies a folder into its own parent as a numbered sibling", async () => {
    const assets = path.join(src, "assets");
    write(path.join(assets, "logo.svg"), "svg");

    const [result] = await copyIntoFolder([assets], src);

    expect(result).toMatchObject({ ok: true, destination: path.join(src, "assets 2") });
    expect(snapshot(path.join(src, "assets 2"))).toEqual({ "logo.svg": "svg" });
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

  it.skipIf(process.getuid?.() === 0)(
    "keeps a folder it could only partly copy, says so, and copies the rest",
    async () => {
      const assets = path.join(src, "assets");
      write(path.join(assets, "a.txt"), "a");
      const locked = write(path.join(assets, "z-locked.txt"), "secret");
      fs.chmodSync(locked, 0o000);
      const file = write(path.join(src, "report.docx"), "draft");

      const results = await copyIntoFolder([assets, file], target);

      expect(results).toEqual([
        {
          ok: false,
          source: assets,
          reason: "partly copied: no permission",
          partial: true,
          destination: path.join(target, "assets"),
        },
        { ok: true, source: file, destination: path.join(target, "report.docx"), renamed: false },
      ]);
      // Nothing is deleted: what was copied before the failure is still there.
      expect(snapshot(path.join(target, "assets"))).toEqual({ "a.txt": "a" });
    }
  );

  // Something else writes into the new folder while it is being filled. fs.promises.cp
  // would unlink a link found there whatever its options; every create here is
  // exclusive, so theirs stays and the copy reports it stopped.
  it.each([
    ["link", (at: string, outside: string) => fs.symlinkSync(outside, at)],
    ["file", (at: string) => fs.writeFileSync(at, "theirs")],
    ["folder", (at: string) => write(path.join(at, "theirs.txt"), "theirs")],
  ])("never replaces a %s that appears inside the folder it is filling", async (kind, plant) => {
    const outside = write(path.join(root, "outside.txt"), "untouched");
    const assets = path.join(src, "assets");
    const entry = path.join(assets, "entry");
    fs.mkdirSync(assets);
    // The link must resolve: cp only reached its unlink for a link that does.
    if (kind === "link") fs.symlinkSync(write(path.join(src, "real.txt"), "real"), entry);
    else if (kind === "file") write(entry, "ours");
    else write(path.join(entry, "ours.txt"), "ours");

    const copied = path.join(target, "assets");
    const realMkdir = fs.promises.mkdir;
    vi.spyOn(fs.promises, "mkdir").mockImplementation((async (
      dir: fs.PathLike,
      options?: fs.MakeDirectoryOptions
    ) => {
      const made = await realMkdir(dir, options);
      if (dir === copied) plant(path.join(copied, "entry"), outside);
      return made;
    }) as typeof fs.promises.mkdir);
    const theirs = () => snapshot(copied);
    const results = await copyIntoFolder([assets], target);

    expect(results).toEqual([
      expect.objectContaining({ ok: false, partial: true, destination: copied }),
    ]);
    expect(results[0].ok === false && results[0].reason).toMatch(/^partly copied: /);
    expect(theirs()).toEqual(
      kind === "link"
        ? { entry: `-> ${outside}` }
        : kind === "file"
          ? { entry: "theirs" }
          : { entry: "dir", "entry/theirs.txt": "theirs" }
    );
    expect(read(outside)).toBe("untouched");
  });

  it("refuses a pipe, alone or inside a folder, without waiting on it", async () => {
    const pipe = path.join(src, "pipe");
    execFileSync("mkfifo", [pipe]);
    const assets = path.join(src, "assets");
    write(path.join(assets, "a.txt"), "a");
    execFileSync("mkfifo", [path.join(assets, "b-pipe")]);

    const results = await copyIntoFolder([pipe, assets], target);

    expect(results).toEqual([
      { ok: false, source: pipe, reason: "not a file or folder" },
      {
        ok: false,
        source: assets,
        reason: "partly copied: b-pipe is not a file or folder",
        partial: true,
        destination: path.join(target, "assets"),
      },
    ]);
    expect(fs.readdirSync(target)).toEqual(["assets"]);
  });

  it("copies a read-only folder whole and keeps it read-only", async () => {
    const docs = path.join(src, "docs");
    write(path.join(docs, "sub", "a.md"), "a");
    fs.chmodSync(path.join(docs, "sub"), 0o555);
    fs.chmodSync(docs, 0o555);

    const [result] = await copyIntoFolder([docs], target);

    expect(result).toMatchObject({ ok: true, destination: path.join(target, "docs") });
    expect(snapshot(path.join(target, "docs"))).toEqual({ sub: "dir", "sub/a.md": "a" });
    expect(fs.statSync(path.join(target, "docs")).mode & 0o777).toBe(0o555);
    expect(fs.statSync(path.join(target, "docs", "sub")).mode & 0o777).toBe(0o555);
  });

  it("numbers a clashing folder by the folder rule", async () => {
    write(path.join(src, "v1.2", "notes.md"), "new");
    write(path.join(src, "report.pages", "index.xml"), "new");
    fs.mkdirSync(path.join(target, "v1.2"));
    fs.mkdirSync(path.join(target, "report.pages"));

    const results = await copyIntoFolder(
      [path.join(src, "v1.2"), path.join(src, "report.pages")],
      target
    );

    expect(results.map((r) => r.ok && path.basename(r.destination))).toEqual([
      "v1.2 2",
      "report 2.pages",
    ]);
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
    write(path.join(target, ".env"), "KEY=old");
    write(path.join(target, "assets", "logo.svg"), "old logo");
    write(path.join(target, "assets 2", "logo.svg"), "older logo");
    const before = snapshot(target);

    const sources = [
      write(path.join(src, "report.docx"), "new report"),
      write(path.join(src, ".env"), "KEY=new"),
      path.join(src, "assets"),
    ];
    write(path.join(src, "assets", "logo.svg"), "new logo");

    const results = await copyIntoFolder(sources, target);

    expect(results.every((r) => r.ok && r.renamed)).toBe(true);
    const after = snapshot(target);
    for (const [entry, content] of Object.entries(before)) {
      expect(after[entry]).toBe(content);
    }
    expect(after["assets 3/logo.svg"]).toBe("new logo");
  });
});
