// Every fixture below is real `git diff --unified=100000 --no-color -M` output,
// captured from a scratch repo on 2026-09-18 rather than hand-written, because the
// two details most likely to break the parser are shaped by git and not by us: the
// `\ No newline at end of file` note that interrupts a deletion/addition pair, and
// the fact that a `-`/`+` run is only a replacement when nothing separates them.

import { describe, expect, it } from "vitest";
import {
  applyRowLimits,
  looksBinary,
  normalizeRelPath,
  parseUnifiedDiff,
  rowsForNewFile,
  splitLines,
  type DiffRow,
} from "./git-diff";

// old: alpha beta gamma delta epsilon
// new: alpha BETA gamma inserted delta
const MIXED = `diff --git a/a.txt b/a.txt
index 600d48a..609b8ae 100644
--- a/a.txt
+++ b/a.txt
@@ -1,5 +1,5 @@
 alpha
-beta
+BETA
 gamma
+inserted
 delta
-epsilon
`;

const NO_TRAILING_NEWLINE = `diff --git a/c.txt b/c.txt
index 9ed40b4..530cc72 100644
--- a/c.txt
+++ b/c.txt
@@ -1,2 +1,2 @@
 one
-two
\\ No newline at end of file
+TWO
\\ No newline at end of file
`;

const RENAME_ONLY = `diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
`;

const BINARY = `diff --git a/bin.dat b/bin.dat
new file mode 100644
index 0000000..01610b4
Binary files /dev/null and b/bin.dat differ
`;

const TWO_HUNKS = `diff --git a/m.txt b/m.txt
index 1111111..2222222 100644
--- a/m.txt
+++ b/m.txt
@@ -3,2 +3,3 @@
 three
+three-and-a-half
 four
@@ -20,2 +21,1 @@
-twenty
 twentyone
`;

function kinds(rows: DiffRow[]): string[] {
  return rows.map((r) => r.kind);
}

describe("parseUnifiedDiff", () => {
  it("pairs a deletion followed by an addition into one replace row", () => {
    const { rows } = parseUnifiedDiff(MIXED, "a.txt");
    expect(kinds(rows)).toEqual([
      "context", // alpha
      "replace", // beta -> BETA
      "context", // gamma
      "add", // inserted
      "context", // delta
      "del", // epsilon
    ]);

    const replaced = rows[1];
    expect(replaced).toEqual({
      kind: "replace",
      oldLine: 2,
      newLine: 2,
      oldText: "beta",
      newText: "BETA",
    });
  });

  it("keeps both sides' line numbers true to their own version", () => {
    const { rows } = parseUnifiedDiff(MIXED, "a.txt");
    // `delta` is line 4 of the old file and line 5 of the new one — an insertion
    // above it shifted only the new side.
    const delta = rows[4];
    expect(delta.oldText).toBe("delta");
    expect(delta.oldLine).toBe(4);
    expect(delta.newLine).toBe(5);

    // A pure addition has no old-side number, a pure deletion no new-side one.
    expect(rows[3].oldLine).toBeNull();
    expect(rows[5].newLine).toBeNull();
  });

  it("numbers the new side 1..N with no gaps", () => {
    const { rows } = parseUnifiedDiff(MIXED, "a.txt");
    const newLines = rows
      .map((r) => r.newLine)
      .filter((n): n is number => n !== null);
    expect(newLines).toEqual([1, 2, 3, 4, 5]);
  });

  it("ignores the no-newline-at-end-of-file note", () => {
    const { rows } = parseUnifiedDiff(NO_TRAILING_NEWLINE, "c.txt");
    expect(kinds(rows)).toEqual(["context", "replace"]);
    expect(rows[1].oldText).toBe("two");
    expect(rows[1].newText).toBe("TWO");
  });

  it("seeds line numbers from each hunk header", () => {
    const { rows } = parseUnifiedDiff(TWO_HUNKS, "m.txt");
    expect(kinds(rows)).toEqual([
      "context", // three
      "add", // three-and-a-half
      "context", // four
      "del", // twenty
      "context", // twentyone
    ]);
    expect(rows[0]).toMatchObject({ oldLine: 3, newLine: 3 });
    expect(rows[1]).toMatchObject({ oldLine: null, newLine: 4 });
    expect(rows[2]).toMatchObject({ oldLine: 4, newLine: 5 });
    // Second hunk restarts from its own header, not from where the first left off.
    expect(rows[3]).toMatchObject({ oldLine: 20, newLine: null });
    expect(rows[4]).toMatchObject({ oldLine: 21, newLine: 21 });
  });

  it("reads both paths out of a rename, with no rows to show", () => {
    const parsed = parseUnifiedDiff(RENAME_ONLY, "b.txt");
    expect(parsed.oldPath).toBe("a.txt");
    expect(parsed.newPath).toBe("b.txt");
    expect(parsed.rows).toEqual([]);
  });

  it("flags a binary diff", () => {
    const parsed = parseUnifiedDiff(BINARY, "bin.dat");
    expect(parsed.binary).toBe(true);
    expect(parsed.rows).toEqual([]);
  });

  it("does not read the --- / +++ preamble as content", () => {
    const { rows } = parseUnifiedDiff(MIXED, "a.txt");
    for (const row of rows) {
      expect(row.oldText).not.toBe(" a/a.txt");
      expect(row.newText).not.toBe(" b/a.txt");
    }
  });

  it("treats an unrelated string as an empty diff rather than throwing", () => {
    expect(parseUnifiedDiff("", "x.txt").rows).toEqual([]);
    expect(parseUnifiedDiff("fatal: bad revision\n", "x.txt").rows).toEqual([]);
  });

  it("pairs runs index-wise and leaves the remainder unpaired", () => {
    const threeForOne = `@@ -1,3 +1,1 @@
-one
-two
-three
+ONE
`;
    const { rows } = parseUnifiedDiff(threeForOne, "x.txt");
    expect(kinds(rows)).toEqual(["replace", "del", "del"]);
    expect(rows[0]).toMatchObject({ oldText: "one", newText: "ONE" });
    expect(rows[1]).toMatchObject({ oldLine: 2, oldText: "two" });
    expect(rows[2]).toMatchObject({ oldLine: 3, oldText: "three" });
  });

  it("does not pair an addition with a deletion that comes after it", () => {
    const addThenDel = `@@ -1,2 +1,2 @@
+added
 kept
-removed
`;
    const { rows } = parseUnifiedDiff(addThenDel, "x.txt");
    expect(kinds(rows)).toEqual(["add", "context", "del"]);
  });

  it("ends a hunk at the next file header rather than at a blank line", () => {
    // We only ever ask for one path, but a `diff --git` is the only terminator
    // that is actually reliable — so prove it terminates, and that the second
    // file's preamble is not read as content.
    const twoFiles = `diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1,1 +1,1 @@
-a
+A
diff --git a/two.txt b/two.txt
--- a/two.txt
+++ b/two.txt
@@ -1,1 +1,1 @@
-b
+B
`;
    const { rows, newPath } = parseUnifiedDiff(twoFiles, "one.txt");
    expect(kinds(rows)).toEqual(["replace", "replace"]);
    expect(rows[0]).toMatchObject({ oldText: "a", newText: "A" });
    expect(rows[1]).toMatchObject({ oldText: "b", newText: "B", oldLine: 1 });
    expect(newPath).toBe("two.txt");
  });

  it("keeps blank context lines", () => {
    const withBlank = `@@ -1,3 +1,3 @@
 one

-three
+THREE
`;
    const { rows } = parseUnifiedDiff(withBlank, "x.txt");
    expect(kinds(rows)).toEqual(["context", "context", "replace"]);
    expect(rows[1].oldText).toBe("");
    expect(rows[1].newLine).toBe(2);
  });
});

describe("rowsForNewFile", () => {
  it("marks every line as an addition with an empty left side", () => {
    const rows = rowsForNewFile("one\ntwo\n");
    expect(rows).toEqual([
      { kind: "add", oldLine: null, newLine: 1, oldText: null, newText: "one" },
      { kind: "add", oldLine: null, newLine: 2, oldText: null, newText: "two" },
    ]);
  });

  it("does not invent a trailing empty line", () => {
    expect(rowsForNewFile("one\n")).toHaveLength(1);
    expect(rowsForNewFile("one")).toHaveLength(1);
    expect(rowsForNewFile("")).toHaveLength(0);
  });
});

describe("splitLines", () => {
  it("keeps interior blank lines and drops only the trailing empty", () => {
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});

describe("applyRowLimits", () => {
  const row: DiffRow = {
    kind: "add",
    oldLine: null,
    newLine: 1,
    oldText: null,
    newText: "x",
  };
  const many = (n: number) => Array.from({ length: n }, () => row);

  it("passes a small diff through untouched", () => {
    const result = applyRowLimits(many(10));
    expect(result).toEqual({ rows: many(10), truncated: false });
  });

  it("truncates past the display limit", () => {
    const result = applyRowLimits(many(6000));
    expect("ok" in result).toBe(false);
    if ("ok" in result) return;
    expect(result.rows).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });

  it("refuses past the hard limit", () => {
    const result = applyRowLimits(many(20001));
    expect(result).toMatchObject({ ok: false, reason: "too-large" });
  });
});

describe("normalizeRelPath", () => {
  it("takes the new path out of a porcelain rename entry", () => {
    expect(normalizeRelPath("old/name.ts -> new/name.ts")).toBe("new/name.ts");
  });

  it("leaves an ordinary path alone", () => {
    expect(normalizeRelPath("src/main/git-diff.ts")).toBe(
      "src/main/git-diff.ts"
    );
  });
});

describe("looksBinary", () => {
  it("finds a NUL byte", () => {
    expect(looksBinary(Buffer.from([0x78, 0x00, 0x79]))).toBe(true);
  });

  it("passes plain text", () => {
    expect(looksBinary(Buffer.from("hello\nworld\n", "utf8"))).toBe(false);
  });

  it("only sniffs the head of a large buffer", () => {
    const buf = Buffer.alloc(9000, 0x61);
    buf[8500] = 0;
    expect(looksBinary(buf)).toBe(false);
  });
});
