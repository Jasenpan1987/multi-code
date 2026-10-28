import { describe, expect, it } from "vitest";
import {
  dropMessage,
  HIDE_AFTER_MS,
  HIDE_FAILED_AFTER_MS,
  hideAfterMs,
  MAX_NOTICES,
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
const partly = (source: string, display: string, why: string): DropCopyOutcome => ({
  ok: false,
  source,
  reason: `partly copied: ${why}`,
  partial: true,
  destination: `/p/${display}`,
  display,
});
const texts = (outcomes: DropCopyOutcome[], max?: number) =>
  dropMessage({ kind: "copied", outcomes }, max).lines.map((l) => l.text);

describe("dropMessage", () => {
  it("lists every copy's path as main shows it, in the drop's order", () => {
    const message = dropMessage({
      kind: "copied",
      outcomes: [copied("docs/sources/inbox/report.docx"), copied("docs/sources/inbox/assets/")],
    });
    expect(message.lines).toEqual([
      { tone: "ok", text: "docs/sources/inbox/report.docx", path: true },
      { tone: "ok", text: "docs/sources/inbox/assets/", path: true },
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

  it("says a folder dropped into itself is refused", () => {
    expect(
      texts([failed("/tmp/p/inbox", "can't copy a folder into itself"), copied("inbox/a.md")])
    ).toEqual(["inbox: can't copy a folder into itself", "inbox/a.md"]);
  });

  it("reads a partial copy as partly copied, with where what was copied is", () => {
    const message = dropMessage({
      kind: "copied",
      outcomes: [partly("/Users/me/assets", "inbox/assets 2/", "disk full"), copied("inbox/a.md")],
    });
    expect(message.lines[0]).toEqual({
      tone: "partial",
      text: "inbox/assets 2/ (partly copied: disk full)",
      path: true,
    });
    expect(message.tone).toBe("partial");
  });

  it("names a partial copy by its source when main gave no path", () => {
    expect(
      texts([{ ok: false, source: "/Users/me/assets", reason: "partly copied: disk full", partial: true }])
    ).toEqual(["assets (partly copied: disk full)"]);
  });

  it("is failed, not partial, once anything wasn't copied at all", () => {
    const { tone } = dropMessage({
      kind: "copied",
      outcomes: [partly("/a/x", "x/", "disk full"), failed("/a/y", "no longer exists")],
    });
    expect(tone).toBe("failed");
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

  it("gives an error's own message", () => {
    expect(dropMessage({ kind: "error", message: "No such instance" }).lines).toEqual([
      { tone: "failed", text: "No such instance", path: false },
    ]);
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
    expect(hideAfterMs({ kind: "copied", outcomes: [partly("/b", "b/", "disk full")] })).toBe(
      HIDE_FAILED_AFTER_MS
    );
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
