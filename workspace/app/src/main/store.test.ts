// contacts.json is written through a file beside it and a rename, so a write cut
// short leaves the old list whole (a torn file would load as no contacts at all).

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-store-test-"));

vi.mock("electron", () => ({ app: { getPath: () => dir } }));

const { loadContacts, saveContacts } = await import("./store");

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("saveContacts", () => {
  it("writes what loadContacts reads back, and leaves no temporary file", () => {
    saveContacts([{ id: "a", cwd: "/p/a", note: { text: "明天继续", writtenAt: 1 } }]);
    expect(loadContacts()).toEqual([{ id: "a", cwd: "/p/a", note: { text: "明天继续", writtenAt: 1 } }]);
    expect(fs.readdirSync(dir)).toEqual(["contacts.json"]);
  });

  it("leaves nothing behind when the rename fails", () => {
    saveContacts([{ id: "a", cwd: "/p/a" }]);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() =>
      saveContacts([{ id: "a", cwd: "/p/a", note: { text: "refused", writtenAt: 1 } }])
    ).toThrow("EACCES");
    vi.restoreAllMocks();
    expect(loadContacts()).toEqual([{ id: "a", cwd: "/p/a" }]);
    expect(fs.readdirSync(dir)).toEqual(["contacts.json"]);
  });

  it("keeps an owner-only file owner-only", () => {
    saveContacts([{ id: "a", cwd: "/p/a" }]);
    fs.chmodSync(path.join(dir, "contacts.json"), 0o600);
    saveContacts([{ id: "a", cwd: "/p/a", note: { text: "private", writtenAt: 1 } }]);
    expect(fs.statSync(path.join(dir, "contacts.json")).mode & 0o777).toBe(0o600);
  });

  it("reports the save's own error when the tidying fails too", () => {
    saveContacts([{ id: "a", cwd: "/p/a" }]);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EACCES: rename");
    });
    const realRm = fs.rmSync;
    let rmCalls = 0;
    vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
      // The first call clears a leftover before the write; the second tidies up.
      if (++rmCalls > 1) throw new Error("EROFS: rm");
      realRm(...(args as Parameters<typeof fs.rmSync>));
    });

    expect(() => saveContacts([{ id: "b", cwd: "/p/b" }])).toThrow("EACCES: rename");
    vi.restoreAllMocks();
    for (const f of fs.readdirSync(dir)) if (f !== "contacts.json") fs.rmSync(path.join(dir, f));
  });

  it("keeps the old file whole when the write fails partway", () => {
    saveContacts([{ id: "a", cwd: "/p/a" }]);
    const real = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, ...rest) => {
      // Half the bytes land, then the disk is full.
      real(file, String(data).slice(0, 10), ...(rest as []));
      throw new Error("ENOSPC: no space left on device");
    });

    expect(() => saveContacts([{ id: "b", cwd: "/p/b" }])).toThrow("ENOSPC");
    vi.restoreAllMocks();
    expect(loadContacts()).toEqual([{ id: "a", cwd: "/p/a" }]);
    expect(fs.readdirSync(dir)).toEqual(["contacts.json"]);
  });
});
