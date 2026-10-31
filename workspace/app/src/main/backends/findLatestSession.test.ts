// Finding the session a directory last worked on, from what is on disk.
//
// This is the lookup that makes a *stopped* instance readable. A stopped contact has
// no session id in memory at all after an app restart — contacts.json doesn't store
// one — so before this existed every stopped contact showed `context=unknown`, and
// a paired phone could not read its history.
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
// which session is the most recent. `entrypoint` as the CLI stamps it on each row:
// `cli` from a terminal, `sdk-cli` from `claude -p`.
function writeTranscript(cwd: string, sessionId: string, mtimeMs: number, entrypoint?: string) {
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const row = entrypoint ? { type: "user", entrypoint } : { type: "user" };
  fs.writeFileSync(file, JSON.stringify({ type: "queue-operation" }) + "\n" + JSON.stringify(row) + "\n");
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

  // `--continue` doesn't open a `claude -p` or SDK run: a directory whose newest
  // session is one would otherwise be continued into "No conversation found".
  it("leaves out sessions started by claude -p or the SDK", () => {
    const now = Date.now();
    writeTranscript(cwd, "ses-terminal", now - 100_000, "cli");
    writeTranscript(cwd, "ses-print", now, "sdk-cli");
    writeTranscript(cwd, "ses-sdk", now - 50_000, "sdk-ts");
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-terminal");
  });

  it("returns null when every session there is a claude -p run", () => {
    writeTranscript(cwd, "ses-print", Date.now(), "sdk-cli");
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe(null);
  });

  // A `claude -p` run opens with a queue row holding the whole prompt. Past 64 KB, no
  // stamped row is left in the head, and the CLI reads the tail's instead.
  it("knows a claude -p run whose prompt pushes every stamped row past the head", () => {
    const now = Date.now();
    writeTranscript(cwd, "ses-terminal", now - 100_000, "cli");
    const dir = path.join(projectsRoot, encodeProjectDir(cwd));
    const file = path.join(dir, "ses-big-prompt.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "x".repeat(70 * 1024) }) +
        "\n" +
        JSON.stringify({ type: "user", parentUuid: null, entrypoint: "sdk-cli" }) +
        "\n"
    );
    fs.utimesSync(file, now / 1000, now / 1000);
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-terminal");
  });

  it("leaves out a background job's session, as the CLI's picker does", () => {
    const now = Date.now();
    writeTranscript(cwd, "ses-terminal", now - 100_000, "cli");
    const dir = path.join(projectsRoot, encodeProjectDir(cwd));
    const file = path.join(dir, "ses-daemon.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "user", parentUuid: null, entrypoint: "cli", sessionKind: "daemon-worker" }) + "\n"
    );
    fs.utimesSync(file, now / 1000, now / 1000);
    expect(findLatestJsonlSessionId(cwd, projectsRoot)).toBe("ses-terminal");
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
