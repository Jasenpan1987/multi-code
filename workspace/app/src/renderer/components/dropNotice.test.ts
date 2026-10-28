import { describe, expect, it } from "vitest";
import {
  dropMessage,
  HIDE_AFTER_MS,
  HIDE_FAILED_AFTER_MS,
  hideAfterMs,
  MAX_NOTICES,
  pastLimitText,
  withDropReport,
} from "./dropNotice";
import type { DropNotice } from "./dropNotice";
import type { DropCopyOutcome } from "../../shared/types";

const copied = (display: string, renamed = false): DropCopyOutcome => ({
  ok: true,
  source: `/Users/me/Desktop/${display.split("/").filter(Boolean).pop()}`,
  destination: `/p/${display}`,
  renamed,
  display,
});
const failed = (source: string, reason: string): DropCopyOutcome => ({
  ok: false,
  source,
  reason,
});
const texts = (outcomes: DropCopyOutcome[], max?: number) =>
  dropMessage({ kind: "copied", outcomes }, max).lines.map((l) => l.text);

describe("dropMessage", () => {
  it("lists every copy's path as main shows it, in the drop's order", () => {
    const message = dropMessage({
      kind: "copied",
      outcomes: [copied("docs/sources/inbox/report.docx"), copied("docs/sources/inbox/data.csv")],
    });
    expect(message.lines).toEqual([
      { tone: "ok", text: "docs/sources/inbox/report.docx", path: true },
      { tone: "ok", text: "docs/sources/inbox/data.csv", path: true },
    ]);
    expect(message.tone).toBe("ok");
  });

  it("shows a path outside the project as main gives it", () => {
    expect(texts([copied("~/Downloads/report.docx")])).toEqual(["~/Downloads/report.docx"]);
  });

  it("shows a renamed copy by its new name, marked", () => {
    expect(texts([copied("inbox/report 2.docx", true), copied("inbox/data.csv")])).toEqual([
      "inbox/report 2.docx (renamed)",
      "inbox/data.csv",
    ]);
  });

  it("names a failed item and its reason, and still lists the rest", () => {
    const message = dropMessage({
      kind: "copied",
      outcomes: [failed("/Users/me/secret.txt", "no permission"), copied("inbox/data.csv")],
    });
    expect(message.lines).toEqual([
      { tone: "failed", text: "secret.txt: no permission", path: true },
      { tone: "ok", text: "inbox/data.csv", path: true },
    ]);
    expect(message.tone).toBe("failed");
  });

  it("says why main refused a whole drop, for each file", () => {
    const reason = "the drop has a folder";
    const message = dropMessage({
      kind: "copied",
      outcomes: [failed("/a/report.docx", reason), failed("/a/assets", reason)],
    });
    expect(message.lines.map((l) => l.text)).toEqual([
      "report.docx: the drop has a folder",
      "assets: the drop has a folder",
    ]);
    expect(message.tone).toBe("failed");
  });

  it("past the limit keeps every failure, then the first copies, and counts the rest", () => {
    const outcomes = [
      copied("in/1.md"),
      copied("in/2.md"),
      copied("in/3.md"),
      copied("in/4.md"),
      copied("in/5.md"),
      copied("in/6.md"),
      failed("/a/7.md", "no permission"),
      copied("in/8.md"),
    ];
    expect(texts(outcomes, 5)).toEqual([
      "in/1.md",
      "in/2.md",
      "in/3.md",
      "in/4.md",
      "7.md: no permission",
      "+3 more copied",
    ]);
  });

  it("counts the failures it couldn't fit", () => {
    const outcomes = ["1", "2", "3", "4"].map((n) => failed(`/a/${n}`, "no permission"));
    expect(texts([copied("in/0.md"), ...outcomes], 2)).toEqual([
      "1: no permission",
      "2: no permission",
      "+3 more (2 not copied)",
    ]);
  });

  it("lists exactly the limit with nothing more", () => {
    const outcomes = ["1", "2", "3", "4", "5"].map((n) => copied(`in/${n}`));
    expect(texts(outcomes)).toEqual(["in/1", "in/2", "in/3", "in/4", "in/5"]);
  });

  it("says Copying… while the copy runs", () => {
    expect(dropMessage({ kind: "copying" })).toEqual({
      lines: [{ tone: "busy", text: "Copying…", path: false }],
      tone: "busy",
    });
  });

  it("says only files from Finder can be dropped", () => {
    expect(dropMessage({ kind: "only-finder" })).toEqual({
      lines: [{ tone: "failed", text: "Only files from Finder can be dropped", path: false }],
      tone: "failed",
    });
  });

  it("says a drop past a limit copied nothing, in one line", () => {
    expect(
      dropMessage({ kind: "past-limit", limit: { kind: "too-many" }, count: 12, folder: "docs/" })
    ).toEqual({
      lines: [
        {
          tone: "failed",
          text: "Nothing copied: 12 files, up to 10 at a time. Put them in docs/ with Finder.",
          path: false,
        },
      ],
      tone: "failed",
    });
  });

  it("gives an error's own message", () => {
    expect(dropMessage({ kind: "error", message: "No such instance" }).lines).toEqual([
      { tone: "failed", text: "No such instance", path: false },
    ]);
  });
});

describe("pastLimitText", () => {
  it("says how many were dropped, the limit, and where to put them, with a default", () => {
    expect(pastLimitText({ kind: "too-many" }, 12, "docs/")).toBe(
      "Nothing copied: 12 files, up to 10 at a time. Put them in docs/ with Finder."
    );
  });

  it("says the project folder without a default", () => {
    expect(pastLimitText({ kind: "too-many" }, 11, null)).toBe(
      "Nothing copied: 11 files, up to 10 at a time. Put them in the project folder with Finder."
    );
  });

  it("gives the total as Finder shows it, and the 1 GB limit", () => {
    expect(pastLimitText({ kind: "too-large", bytes: 1_412_345_678 }, 3, "docs/")).toBe(
      "Nothing copied: 1.41 GB, up to 1 GB at a time. Put them in docs/ with Finder."
    );
    expect(pastLimitText({ kind: "too-large", bytes: 12_345_678_901 }, 1, null)).toBe(
      "Nothing copied: 12.35 GB, up to 1 GB at a time. Put it in the project folder with Finder."
    );
  });

  it("says more than 1 GB when the total rounds to the limit itself", () => {
    expect(pastLimitText({ kind: "too-large", bytes: 1_000_000_001 }, 2, "docs/")).toBe(
      "Nothing copied: more than 1 GB, up to 1 GB at a time. Put them in docs/ with Finder."
    );
  });

  it("says folders can't be dropped, for one folder or a mix", () => {
    expect(pastLimitText({ kind: "folder" }, 1, "~/Downloads/")).toBe(
      "Nothing copied: folders can't be dropped. Put it in ~/Downloads/ with Finder."
    );
    expect(pastLimitText({ kind: "folder" }, 3, null)).toBe(
      "Nothing copied: folders can't be dropped. Put them in the project folder with Finder."
    );
  });
});

describe("hideAfterMs", () => {
  it("keeps Copying… until the copy is done", () => {
    expect(hideAfterMs({ kind: "copying" })).toBeNull();
  });

  it("stays longer when something wasn't copied", () => {
    expect(hideAfterMs({ kind: "copied", outcomes: [copied("in/a")] })).toBe(HIDE_AFTER_MS);
    expect(
      hideAfterMs({ kind: "copied", outcomes: [copied("in/a"), failed("/b", "disk full")] })
    ).toBe(HIDE_FAILED_AFTER_MS);
    expect(
      hideAfterMs({ kind: "past-limit", limit: { kind: "folder" }, count: 1, folder: null })
    ).toBe(HIDE_FAILED_AFTER_MS);
    expect(hideAfterMs({ kind: "only-finder" })).toBe(HIDE_FAILED_AFTER_MS);
    expect(hideAfterMs({ kind: "error", message: "x" })).toBe(HIDE_FAILED_AFTER_MS);
    expect(HIDE_FAILED_AFTER_MS).toBeGreaterThan(HIDE_AFTER_MS);
  });
});

describe("withDropReport", () => {
  const done = (display: string) => ({ kind: "copied" as const, outcomes: [copied(display)] });

  it("adds a new drop's report as the newest", () => {
    const one = withDropReport([], 1, { kind: "copying" });
    expect(withDropReport(one, 2, { kind: "only-finder" })).toEqual([
      { drop: 1, report: { kind: "copying" } },
      { drop: 2, report: { kind: "only-finder" } },
    ]);
  });

  it("replaces a drop's own earlier report, in place", () => {
    const notices: DropNotice[] = [
      { drop: 1, report: { kind: "copying" } },
      { drop: 2, report: { kind: "copying" } },
    ];
    expect(withDropReport(notices, 1, done("in/a"))).toEqual([
      { drop: 1, report: done("in/a") },
      { drop: 2, report: { kind: "copying" } },
    ]);
  });

  it("never lets one drop's result replace another drop's Copying…", () => {
    let notices = withDropReport([], 1, { kind: "copying" });
    notices = withDropReport(notices, 2, { kind: "copying" });
    notices = withDropReport(notices, 1, done("in/a"));
    expect(notices.find((n) => n.drop === 2)?.report).toEqual({ kind: "copying" });
  });

  it("lets the oldest go past the limit", () => {
    let notices: DropNotice[] = [];
    for (let drop = 1; drop <= MAX_NOTICES + 1; drop++) {
      notices = withDropReport(notices, drop, { kind: "only-finder" });
    }
    expect(notices.map((n) => n.drop)).toEqual([2, 3, 4]);
  });
});
