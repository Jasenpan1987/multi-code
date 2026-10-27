import { describe, expect, it } from "vitest";
import {
  allOnDisk,
  changeDefaultMessage,
  dropStep,
  dropTitle,
  shownNames,
  somewhereElseMessage,
  swallowHeldKeyRepeats,
} from "./dropFlow";
import type { DroppedItem } from "../../shared/types";

const file = (name: string): DroppedItem => ({ name, isDirectory: false });
const folder = (name: string): DroppedItem => ({ name, isDirectory: true });

describe("allOnDisk", () => {
  it("takes a drop whose every item has a path", () => {
    expect(allOnDisk(["/Users/me/report.docx", "/Users/me/assets"])).toBe(true);
  });

  it("refuses a drop with one item that has no file on disk", () => {
    expect(allOnDisk(["/Users/me/report.docx", ""])).toBe(false);
  });

  it("refuses a drop with no files at all", () => {
    expect(allOnDisk([])).toBe(false);
  });
});

describe("dropTitle", () => {
  it("counts one file", () => {
    expect(dropTitle([file("report.docx")], "multi-code")).toBe(
      "Put 1 file in multi-code?"
    );
  });

  it("counts several files", () => {
    expect(dropTitle([file("a.csv"), file("b.png")], "multi-code")).toBe(
      "Put 2 files in multi-code?"
    );
  });

  it("counts folders alone as folders", () => {
    expect(dropTitle([folder("assets")], "p")).toBe("Put 1 folder in p?");
    expect(dropTitle([folder("a"), folder("b"), folder("c")], "p")).toBe(
      "Put 3 folders in p?"
    );
  });

  it("names files first, then folders, for a mix in any order", () => {
    expect(dropTitle([folder("assets"), file("report.docx")], "fd-project")).toBe(
      "Put 1 file and 1 folder in fd-project?"
    );
    expect(
      dropTitle([file("a"), folder("b"), file("c"), folder("d"), folder("e")], "p")
    ).toBe("Put 2 files and 3 folders in p?");
  });

  it("keeps the project's name as it is", () => {
    expect(dropTitle([file("a")], "My Project (old)")).toBe(
      "Put 1 file in My Project (old)?"
    );
  });
});

describe("shownNames", () => {
  it("lists every name up to five, a folder with a trailing slash", () => {
    expect(shownNames([file("report.docx"), folder("assets")])).toEqual({
      names: ["report.docx", "assets/"],
      more: 0,
    });
  });

  it("lists exactly five with nothing more", () => {
    const items = ["1", "2", "3", "4", "5"].map(file);
    expect(shownNames(items)).toEqual({ names: ["1", "2", "3", "4", "5"], more: 0 });
  });

  it("stops at five, in the drop's order, and counts the rest", () => {
    const items = ["1", "2", "3", "4", "5", "6", "7"].map(file);
    expect(shownNames(items)).toEqual({ names: ["1", "2", "3", "4", "5"], more: 2 });
  });
});

describe("dropStep", () => {
  const project = { name: "fd-project", cwd: "/tmp/fd-project" };

  it("opens the picker at the project when there is no default yet", () => {
    expect(dropStep({ path: null, exists: false, display: null }, project)).toEqual({
      kind: "pick",
      message: "No default folder for fd-project yet. Choose where dropped files go.",
      start: "/tmp/fd-project",
    });
  });

  it("says which default is gone, as the dialog would show it, and opens at the project", () => {
    expect(
      dropStep({ path: "/tmp/fd-project/inbox", exists: false, display: "inbox/" }, project)
    ).toEqual({
      kind: "pick",
      message: "The default folder inbox/ no longer exists. Choose where dropped files go.",
      start: "/tmp/fd-project",
    });
  });

  it("asks in the dialog when the default is there", () => {
    expect(
      dropStep({ path: "/tmp/fd-project/inbox", exists: true, display: "inbox/" }, project)
    ).toEqual({ kind: "confirm", folder: "/tmp/fd-project/inbox", display: "inbox/" });
  });
});

describe("the dialog's picker messages", () => {
  it("says the default stays for Somewhere else", () => {
    expect(somewhereElseMessage("docs/sources/inbox/")).toBe(
      "Choose where these files go. The default folder stays docs/sources/inbox/."
    );
  });

  it("names the project for Change default path", () => {
    expect(changeDefaultMessage("multi-code")).toBe(
      "Choose the new default folder for multi-code. These files go there too."
    );
  });
});

describe("swallowHeldKeyRepeats", () => {
  // Like a key event: Node has EventTarget and Event, not KeyboardEvent.
  const key = (type: string, repeat = false) => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, "repeat", { value: repeat });
    return e;
  };

  // The guard first: on a window its capture listener runs before the terminal's;
  // Node's EventTarget, with no tree, runs listeners in the order they were added.
  function setup() {
    const target = new EventTarget();
    const reached: string[] = [];
    swallowHeldKeyRepeats(target);
    target.addEventListener("keydown", (e) =>
      reached.push((e as KeyboardEvent).repeat ? "repeat" : "press")
    );
    return { target, reached };
  }

  it("swallows the repeats of a held key until it is released", () => {
    const { target, reached } = setup();
    const held = key("keydown", true);
    target.dispatchEvent(held);
    target.dispatchEvent(key("keydown", true));
    expect(reached).toEqual([]);
    expect(held.defaultPrevented).toBe(true);

    target.dispatchEvent(key("keyup"));
    target.dispatchEvent(key("keydown", true));
    expect(reached).toEqual(["repeat"]);
  });

  it("lets a fresh press through, and its repeats after it", () => {
    const { target, reached } = setup();
    target.dispatchEvent(key("keydown"));
    target.dispatchEvent(key("keydown", true));
    expect(reached).toEqual(["press", "repeat"]);
  });
});
