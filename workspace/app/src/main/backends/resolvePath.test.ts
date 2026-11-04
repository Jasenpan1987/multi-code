// Tests for symlink-aware path comparison.
//
// This guards a failure that is invisible in the UI: when the stored cwd and the
// configured cwd differ only by a symlink, session discovery finds nothing, and
// the instance runs normally but silently loses completion detection, prompt
// detection, and phone notifications.

import { describe, expect, it, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { clearResolvePathCache, resolvePath, samePath } from "./resolvePath";
import { encodeProjectDir } from "./claude";

beforeEach(() => {
  clearResolvePathCache();
});

describe("resolvePath", () => {
  it("resolves a symlinked directory to its target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-resolve-"));
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    expect(resolvePath(link)).toBe(fs.realpathSync(real));
  });

  it("returns a nonexistent path unchanged instead of throwing", () => {
    // A cwd can be configured before it exists; that must not break discovery.
    expect(resolvePath("/definitely/not/here")).toBe("/definitely/not/here");
  });

  it("matches macOS's /tmp symlink, the case this was written for", () => {
    // On macOS /tmp -> /private/tmp. Skip elsewhere rather than assert an
    // OS-specific layout.
    if (!fs.existsSync("/tmp")) return;
    const resolved = resolvePath("/tmp");
    expect(resolved).toBe(fs.realpathSync("/tmp"));
  });
});

describe("samePath", () => {
  it("treats a symlink and its target as the same directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-resolve-"));
    const real = path.join(root, "project");
    const link = path.join(root, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    expect(samePath(link, real)).toBe(true);
    // The regression this encodes: a plain string compare says these differ.
    expect(link === real).toBe(false);
  });

  it("keeps genuinely different directories apart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-resolve-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);

    expect(samePath(a, b)).toBe(false);
  });

  it("compares identical paths without needing them to exist", () => {
    expect(samePath("/nope/x", "/nope/x")).toBe(true);
  });
});

describe("encodeProjectDir", () => {
  // Claude names its per-project directory after the RESOLVED cwd. Encoding the
  // unresolved path yields a directory that doesn't exist, so `--continue` is
  // never passed and the transcript can't be located.
  it("encodes the resolved path, not the one it was given", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-encode-"));
    const real = path.join(root, "project");
    const link = path.join(root, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    const expected = fs.realpathSync(real).replace(/\//g, "-");
    expect(encodeProjectDir(link)).toBe(expected);
    expect(encodeProjectDir(link)).toBe(encodeProjectDir(real));
  });

  it("replaces every separator", () => {
    expect(encodeProjectDir("/nope/a/b")).toBe("-nope-a-b");
  });
});
