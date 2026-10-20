// Finding the session a directory last worked on, from what is on disk.
//
// This is the lookup that makes a *stopped* instance readable. A stopped contact has
// no session id in memory at all after an app restart — contacts.json doesn't store
// one — so before this existed the manager could not read the history of any session
// it hadn't personally watched run, and every stopped contact showed
// `context=unknown`.
//
// Claude's lookup; OpenCode 2's (`latestRootSession`) is tested in opencodeDb.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { findLatestJsonlSessionId, encodeProjectDir } = await import("./claude");

// ---------------------------------------------------------------- claude

let projectsRoot = "";

beforeEach(() => {
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-projects-"));
});

afterEach(() => {
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

// Writes a transcript for `cwd` with an explicit mtime, since mtime is what decides
// which session is the most recent.
function writeTranscript(cwd: string, sessionId: string, mtimeMs: number) {
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '{"type":"user"}\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("claude: findLatestJsonlSessionId", () => {
  const cwd = "/Users/x/code/msk";

  it("finds the only session in a directory", () => {
    writeTranscript(cwd, "ses-only", Date.now());
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-only");
  });

  // mtime, not creation order or filename: a session's transcript is touched on
  // every turn, so the most recently written one is the most recently worked in.
  it("picks the most recently written of several", () => {
    const now = Date.now();
    writeTranscript(cwd, "ses-old", now - 200_000);
    writeTranscript(cwd, "ses-newest", now);
    writeTranscript(cwd, "ses-middle", now - 100_000);
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-newest");
  });

  it("returns null for a directory that has never been used", () => {
    expect(findLatestJsonlSessionId("/Users/x/code/never", projectsRoot)).toBe(
      null
    );
  });

  it("returns null for a project directory with no transcripts in it", () => {
    fs.mkdirSync(path.join(projectsRoot, encodeProjectDir(cwd)), {
      recursive: true,
    });
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe(null);
  });

  it("ignores files that are not transcripts", () => {
    const dir = path.join(projectsRoot, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.md"), "hello");
    fs.writeFileSync(path.join(dir, ".DS_Store"), "");
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe(null);
  });

  it("keeps transcripts of different directories apart", () => {
    const other = "/Users/x/code/other";
    writeTranscript(cwd, "ses-msk", Date.now());
    writeTranscript(other, "ses-other", Date.now());
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-msk");
    expect(findLatestJsonlSessionId(other, projectsRoot)).toBe("ses-other");
  });

  it("does not throw when the projects root itself is missing", () => {
    expect(findLatestJsonlSessionId(cwd, "/nope/not/here")).toBe(null);
  });
});
