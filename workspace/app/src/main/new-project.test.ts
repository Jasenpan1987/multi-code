// The promise a clone makes: it only ever removes a folder it made itself, and a
// folder already at the target is never touched. git here is a fake (a node script
// with git's arguments) run as a real child process, so stderr, exit codes and the
// process group behave as git's would. Everything runs in a temp directory.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import type { SpawnOptions } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  NOT_A_FOLDER,
  abortCloneForQuit,
  cancelClone,
  checkFolder,
  cloneRepo,
  createGitOutput,
  hintFor,
  lastClonedInto,
  noPromptEnv,
  percentOf,
  resolveTypedPath,
} from "./new-project";
import type { CloneDeps } from "./new-project";
import type { CloneProgress } from "../shared/types";

// Acts on the URL's last part: ok (progress, a file, exit 0), fail, login, slow
// (makes a file, then waits to be stopped).
const FAKE_GIT = String.raw`
const [sub, flag, dashes, url, target] = process.argv.slice(process.argv.indexOf("clone"));
if (sub !== "clone" || flag !== "--progress" || dashes !== "--") process.exit(3);
if (process.env.GIT_TERMINAL_PROMPT !== "0" || process.env.GIT_ASKPASS !== "") process.exit(4);
if (process.env.SSH_ASKPASS !== undefined || process.env.SSH_ASKPASS_REQUIRE !== "never") process.exit(5);
const fs = require("fs");
const kind = url.split("/").pop().replace(/\.git$/, "");
process.stderr.write("Cloning into '" + require("path").basename(target) + "'...\n");
if (kind === "ok") {
  process.stderr.write("Receiving objects:  10% (1/10)\rReceiving objects:  60% (6/10)\r");
  process.stderr.write("Receiving objects: 100% (10/10), done.\n");
  fs.writeFileSync(target + "/README.md", "hi");
  process.exit(0);
}
if (kind === "fail") {
  process.stderr.write("ERROR: Repository not found.\nfatal: Could not read from remote repository.\n");
  process.exit(128);
}
if (kind === "login") {
  process.stderr.write("fatal: could not read Username for 'https://example.com': terminal prompts disabled\n");
  process.exit(128);
}
if (kind === "stubborn") {
  // A helper that ignores SIGTERM and keeps git's stderr open after git is gone.
  require("child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "inherit"] });
  process.stderr.write("Receiving objects:  1% (1/100)\r");
  setInterval(() => {}, 1000);
}
if (kind === "slow") {
  fs.writeFileSync(target + "/partial", "x");
  process.stderr.write("Receiving objects:  1% (1/100)\r");
  setTimeout(() => process.exit(0), 20000);
}
`;

let root = "";
let spawned = 0;

function deps(over: Partial<CloneDeps> = {}): CloneDeps {
  return {
    spawn: (_cmd: string, args: string[], options: SpawnOptions) => {
      spawned++;
      return spawn(process.execPath, ["-e", FAKE_GIT, "--", ...args], options);
    },
    // As a login shell might give it: askpass programs that must not reach git.
    env: async () => ({ PATH: process.env.PATH ?? "", GIT_ASKPASS: "/bin/echo", SSH_ASKPASS: "/bin/echo" }),
    killAfterMs: 2000,
    ...over,
  };
}

function clone(url: string, folderName = "", onProgress: (p: CloneProgress) => void = () => {}, d = deps()) {
  return cloneRepo({ url, parent: root, folderName }, onProgress, d);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-new-project-"));
  spawned = 0;
});

afterEach(() => {
  fs.chmodSync(root, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveTypedPath", () => {
  it("expands ~ and takes relative paths from home", () => {
    expect(resolveTypedPath("~", "/Users/me")).toBe("/Users/me");
    expect(resolveTypedPath(" ~/code/study/ ", "/Users/me")).toBe("/Users/me/code/study");
    expect(resolveTypedPath("code/x", "/Users/me")).toBe("/Users/me/code/x");
    expect(resolveTypedPath("/tmp/a/../b", "/Users/me")).toBe("/tmp/b");
    expect(resolveTypedPath("~other/x", "/Users/me")).toBe("/Users/me/~other/x");
  });
});

describe("checkFolder", () => {
  it("tells a folder from a file and from nothing", async () => {
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "file"), "");
    expect(await checkFolder(path.join(root, "dir"))).toEqual({ path: path.join(root, "dir"), kind: "directory" });
    expect((await checkFolder(path.join(root, "file"))).kind).toBe("file");
    expect((await checkFolder(path.join(root, "nope"))).kind).toBe("missing");
  });
});

describe("createGitOutput", () => {
  it("redraws \\r lines and keeps \\n lines, as a terminal shows them", () => {
    const out = createGitOutput();
    expect(out.push("Cloning into 'x'...\n")).toBe("Cloning into 'x'...");
    expect(out.push("Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\r")).toBe(
      "Receiving objects:  50% (5/10)"
    );
    out.push("Receiving objects: 100% (10/10), done.\nfatal: x\n");
    expect(out.tail()).toBe("Cloning into 'x'...\nReceiving objects: 100% (10/10), done.\nfatal: x");
  });

  it("joins lines split across chunks, \\r\\n included", () => {
    const out = createGitOutput();
    expect(out.push("Resolving del")).toBeNull();
    expect(out.push("tas:  20% (1/5)\r")).toBe("Resolving deltas:  20% (1/5)");
    out.push("\nnext\n");
    expect(out.tail()).toBe("Resolving deltas:  20% (1/5)\nnext");
  });

  it("keeps only the last lines", () => {
    const out = createGitOutput(2);
    out.push("a\nb\nc\n");
    expect(out.tail()).toBe("b\nc");
  });
});

describe("noPromptEnv", () => {
  it("leaves git and ssh nothing to prompt with, and keeps the rest", () => {
    const env = noPromptEnv({ PATH: "/bin", SSH_AUTH_SOCK: "/agent", GIT_ASKPASS: "/x", SSH_ASKPASS: "/y" });
    expect(env).toEqual({
      PATH: "/bin",
      SSH_AUTH_SOCK: "/agent",
      GIT_ASKPASS: "",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "never",
    });
  });
});

describe("percentOf and hintFor", () => {
  it("reads git's percentage", () => {
    expect(percentOf("Receiving objects:  42% (42/100), 1.00 MiB | 2.00 MiB/s")).toBe(42);
    expect(percentOf("remote: Enumerating objects: 5, done.")).toBeNull();
  });

  it("points at the login problems", () => {
    expect(hintFor("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toMatch(/SSH link/);
    expect(hintFor("git@github.com: Permission denied (publickey).")).toMatch(/terminal/);
    expect(hintFor("fatal: Could not read from remote repository.")).toBeUndefined();
  });
});

describe("cloneRepo", () => {
  it("clones into the repo's name and reports progress", async () => {
    const progress: CloneProgress[] = [];
    const result = await clone("https://example.com/team/ok.git", "", (p) => progress.push(p));
    const target = path.join(root, "ok");
    expect(result).toEqual({ kind: "done", path: target });
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("hi");
    // Only the latest line of what arrived together is reported.
    expect(progress.at(-1)).toEqual({ line: "Receiving objects: 100% (10/10), done.", percent: 100 });
    expect(lastClonedInto()).toBe(root);
  });

  it("uses a typed folder name", async () => {
    const result = await clone("https://example.com/team/ok.git", "  portals-v2 ");
    expect(result).toEqual({ kind: "done", path: path.join(root, "portals-v2") });
  });

  it("removes its own folder when git fails, and shows git's words", async () => {
    const result = await clone("https://example.com/team/fail.git");
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.output).toMatch(/Repository not found/);
    expect(result.hint).toBeUndefined();
    expect(fs.existsSync(path.join(root, "fail"))).toBe(false);
  });

  it("fails at once for a login it can't do, with a hint", async () => {
    const result = await clone("https://example.com/team/login.git");
    expect(result.kind === "failed" && result.hint).toMatch(/SSH link/);
  });

  it("never touches a folder that was already there", async () => {
    const target = path.join(root, "ok");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "mine.txt"), "keep");
    const result = await clone("https://example.com/team/ok.git");
    expect(result).toEqual({ kind: "refused", reason: `${target} already exists` });
    expect(fs.readdirSync(target)).toEqual(["mine.txt"]);
    expect(spawned).toBe(0);
  });

  it("refuses an empty folder already there too", async () => {
    fs.mkdirSync(path.join(root, "ok"));
    expect((await clone("https://example.com/team/ok.git")).kind).toBe("refused");
    expect(fs.existsSync(path.join(root, "ok"))).toBe(true);
  });

  it("refuses a bad link, a bad name and a missing parent without starting git", async () => {
    expect((await clone("acme/some-repo")).kind).toBe("refused");
    expect(await clone("https://example.com/team/ok.git", "a/b")).toEqual({
      kind: "refused",
      reason: "A folder name cannot contain /",
    });
    const missing = path.join(root, "nope");
    expect(
      await cloneRepo({ url: "https://example.com/team/ok.git", parent: missing, folderName: "" }, () => {}, deps())
    ).toEqual({ kind: "refused", reason: NOT_A_FOLDER(missing) });
    expect(spawned).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("stops git on Cancel and removes the half-made folder", async () => {
    let started!: () => void;
    const firstLine = new Promise<void>((r) => (started = r));
    const pending = clone("https://example.com/team/slow.git", "", () => started());
    await firstLine;
    expect(fs.existsSync(path.join(root, "slow", "partial"))).toBe(true);
    cancelClone();
    expect(await pending).toEqual({ kind: "cancelled", path: path.join(root, "slow"), removed: true });
    expect(fs.existsSync(path.join(root, "slow"))).toBe(false);
  });

  it("runs one clone at a time", async () => {
    let started!: () => void;
    const firstLine = new Promise<void>((r) => (started = r));
    const pending = clone("https://example.com/team/slow.git", "", () => started());
    await firstLine;
    expect(await clone("https://example.com/team/ok.git")).toEqual({
      kind: "refused",
      reason: "A clone is already running",
    });
    cancelClone();
    await pending;
    expect((await clone("https://example.com/team/ok.git")).kind).toBe("done");
  });

  it("starts no git when cancelled while the environment is read", async () => {
    let release!: () => void;
    const envRead = new Promise<void>((r) => (release = r));
    const pending = clone("https://example.com/team/ok.git", "", () => {}, deps({
      env: async () => {
        await envRead;
        return null;
      },
    }));
    await new Promise((r) => setTimeout(r, 20));
    cancelClone();
    release();
    expect((await pending).kind).toBe("cancelled");
    expect(spawned).toBe(0);
    expect(fs.existsSync(path.join(root, "ok"))).toBe(false);
  });

  it("still clones when the login-shell env can't be read", async () => {
    const result = await clone("https://example.com/team/ok.git", "", () => {}, deps({
      env: () => Promise.reject(new Error("shell broke")),
    }));
    expect(result.kind).toBe("done");
  });

  it("kills git and removes its folder when Multi-Code quits", async () => {
    let started!: () => void;
    const firstLine = new Promise<void>((r) => (started = r));
    const pending = clone("https://example.com/team/slow.git", "", () => started());
    await firstLine;
    abortCloneForQuit();
    expect(fs.existsSync(path.join(root, "slow"))).toBe(false);
    expect((await pending).kind).toBe("cancelled");
  });

  it("leaves another folder alone when a linked parent is pointed elsewhere meanwhile", async () => {
    for (const dir of ["a", "b", "b/fail"]) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, "b", "fail", "mine.txt"), "keep");
    fs.symlinkSync(path.join(root, "a"), path.join(root, "link"));
    const result = await cloneRepo(
      { url: "https://example.com/team/fail.git", parent: path.join(root, "link"), folderName: "" },
      () => {},
      deps({
        env: async () => {
          fs.unlinkSync(path.join(root, "link"));
          fs.symlinkSync(path.join(root, "b"), path.join(root, "link"));
          return null;
        },
      })
    );
    expect(result).toMatchObject({ kind: "failed", removed: false });
    expect(fs.readFileSync(path.join(root, "b", "fail", "mine.txt"), "utf8")).toBe("keep");
  });

  it("leaves a folder put in place of its own while git ran", async () => {
    const target = path.join(root, "fail");
    const result = await clone("https://example.com/team/fail.git", "", () => {}, deps({
      env: async () => {
        // The folder this clone made is moved away; someone's own takes its place.
        fs.renameSync(target, path.join(root, "moved"));
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, "mine.txt"), "keep");
        return null;
      },
    }));
    expect(result).toMatchObject({ kind: "failed", path: target, removed: false });
    expect(fs.readFileSync(path.join(target, "mine.txt"), "utf8")).toBe("keep");
  });

  it("says so when its folder can't be removed", async () => {
    const result = await clone("https://example.com/team/fail.git", "", () => {}, deps({
      env: async () => {
        fs.chmodSync(root, 0o555);
        return null;
      },
    }));
    fs.chmodSync(root, 0o755);
    expect(result).toMatchObject({ kind: "failed", removed: false });
    expect(fs.existsSync(path.join(root, "fail"))).toBe(true);
  });

  it("finishes a Cancel even when a helper ignores SIGTERM and holds stderr", async () => {
    let started!: () => void;
    const firstLine = new Promise<void>((r) => (started = r));
    const quick = deps({ killAfterMs: 200 });
    const pending = clone("https://example.com/team/stubborn.git", "", () => started(), quick);
    await firstLine;
    cancelClone(quick);
    expect(await pending).toEqual({ kind: "cancelled", path: path.join(root, "stubborn"), removed: true });
    expect((await clone("https://example.com/team/ok.git")).kind).toBe("done");
  });

  it("says so when git isn't installed", async () => {
    const result = await clone("https://example.com/team/ok.git", "", () => {}, deps({
      spawn: (_cmd, args, options) => spawn("multicode-no-such-git", args, options),
    }));
    expect(result.kind === "failed" && result.output).toMatch(/git was not found/);
    expect(fs.existsSync(path.join(root, "ok"))).toBe(false);
  });
});
