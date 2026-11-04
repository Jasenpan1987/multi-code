import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allOnDisk,
  changeDefaultMessage,
  DeadlineError,
  dropStep,
  dropTitle,
  HELD_KEY_WINDOW_MS,
  holdInput,
  lookupTooSlowMessage,
  shownNames,
  somewhereElseMessage,
  swallowHeldKeyRepeats,
  withDeadline,
} from "./dropFlow";
import type { DroppedItem } from "../../shared/types";

const file = (name: string, size = 1): DroppedItem => ({ name, isDirectory: false, size });
const folder = (name: string): DroppedItem => ({ name, isDirectory: true, size: 96 });
const files = (n: number) => Array.from({ length: n }, (_, i) => file(`${i + 1}.md`));

describe("allOnDisk", () => {
  it("takes a drop whose every item has a path", () => {
    expect(allOnDisk(["/Users/me/report.docx", "/Users/me/data.csv"])).toBe(true);
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

  it("counts up to the limit", () => {
    expect(dropTitle(files(10), "p")).toBe("Put 10 files in p?");
  });

  it("keeps the project's name as it is", () => {
    expect(dropTitle([file("a")], "My Project (old)")).toBe(
      "Put 1 file in My Project (old)?"
    );
  });
});

describe("shownNames", () => {
  it("lists every name up to five", () => {
    expect(shownNames([file("report.docx"), file("data.csv")])).toEqual({
      names: ["report.docx", "data.csv"],
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
  const none = { path: null, exists: false, display: null };
  const inbox = { path: "/tmp/fd-project/inbox", exists: true, display: "inbox/" };
  const gone = { ...inbox, exists: false };
  const two = [file("a.md"), file("b.md")];

  it("opens the picker at the project when there is no default yet", () => {
    expect(dropStep(none, project, 2, two)).toEqual({
      kind: "pick",
      message: "No default folder for fd-project yet. Choose where dropped files go.",
      start: "/tmp/fd-project",
    });
  });

  it("says which default is gone, as the dialog would show it, and opens at the project", () => {
    expect(dropStep(gone, project, 2, two)).toEqual({
      kind: "pick",
      message: "The default folder inbox/ no longer exists. Choose where dropped files go.",
      start: "/tmp/fd-project",
    });
  });

  it("asks in the dialog when the default is there", () => {
    expect(dropStep(inbox, project, 2, two)).toEqual({
      kind: "confirm",
      folder: "/tmp/fd-project/inbox",
      display: "inbox/",
    });
  });

  // Story 6: the limits come before the dialog and before the first-drop picker.
  it("takes 10 files and refuses 11, by the count alone, before the dialog or the picker", () => {
    expect(dropStep(inbox, project, 10, files(10)).kind).toBe("confirm");
    expect(dropStep(none, project, 10, files(10)).kind).toBe("pick");
    for (const f of [inbox, none]) {
      expect(dropStep(f, project, 11, [])).toMatchObject({
        kind: "refuse",
        report: { kind: "past-limit", limit: { kind: "too-many" }, count: 11 },
      });
    }
  });

  it("takes exactly 1 GB in all and refuses 1 byte more", () => {
    const at = [file("a.mov", 999_999_999), file("b.txt", 1)];
    const past = [file("a.mov", 999_999_999), file("b.txt", 2)];
    expect(dropStep(inbox, project, 2, at).kind).toBe("confirm");
    expect(dropStep(inbox, project, 2, past)).toEqual({
      kind: "refuse",
      report: {
        kind: "past-limit",
        limit: { kind: "too-large", bytes: 1_000_000_001 },
        count: 2,
        folder: "inbox/",
      },
    });
    expect(dropStep(none, project, 2, past).kind).toBe("refuse");
  });

  it("refuses a folder anywhere in the drop, files and all", () => {
    for (const items of [[folder("assets")], [file("a.md"), folder("assets"), file("b.md")]]) {
      expect(dropStep(inbox, project, items.length, items)).toMatchObject({
        kind: "refuse",
        report: { limit: { kind: "folder" }, count: items.length },
      });
      expect(dropStep(none, project, items.length, items).kind).toBe("refuse");
    }
  });

  it("names the default folder to put them in, else the project folder", () => {
    const folderOf = (f: Parameters<typeof dropStep>[0]) => {
      const step = dropStep(f, project, 1, [folder("assets")]);
      return step.kind === "refuse" ? step.report.folder : "not refused";
    };
    expect(folderOf(inbox)).toBe("inbox/");
    expect(folderOf({ ...inbox, path: "/Users/me/Downloads", display: "~/Downloads/" })).toBe(
      "~/Downloads/"
    );
    // None yet, gone, or the project itself: the project folder.
    expect(folderOf(none)).toBeNull();
    expect(folderOf(gone)).toBeNull();
    expect(folderOf({ path: "/tmp/fd-project", exists: true, display: "./" })).toBeNull();
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

// Like a key event: Node has EventTarget and Event, not KeyboardEvent.
function key(type: string, code: string, repeat = false, target?: unknown): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, "code", { value: code });
  Object.defineProperty(e, "key", { value: code });
  Object.defineProperty(e, "repeat", { value: repeat });
  // What it was aimed at, for holdInput's `allow`; Node's has no tree to set it.
  if (target !== undefined) Object.defineProperty(e, "target", { value: target });
  return e;
}

// The guard first: on a window its capture listener runs before the terminal's;
// Node's EventTarget, with no tree, runs listeners in the order they were added.
// What reaches the "terminal" after it, as "<code>" or "<code>*" for a repeat.
function behindGuard(guard: (target: EventTarget) => unknown) {
  const target = new EventTarget();
  const reached: string[] = [];
  guard(target);
  for (const type of ["keydown", "keypress"]) {
    target.addEventListener(type, (e) => {
      const k = e as KeyboardEvent;
      reached.push(`${type === "keypress" ? "press:" : ""}${k.code}${k.repeat ? "*" : ""}`);
    });
  }
  return { target, reached, send: (e: Event) => (target.dispatchEvent(e), e) };
}

describe("swallowHeldKeyRepeats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("swallows the repeats of a held key until it is released", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    expect(send(key("keydown", "Enter", true)).defaultPrevented).toBe(true);
    send(key("keydown", "Enter", true));
    expect(reached).toEqual([]);

    send(key("keyup", "Enter"));
    send(key("keydown", "Enter", true));
    expect(reached).toEqual(["Enter*"]);
  });

  it("keeps swallowing a held Enter when Shift is let go of it", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    send(key("keydown", "Enter", true));
    send(key("keyup", "ShiftLeft"));
    expect(send(key("keydown", "Enter", true)).defaultPrevented).toBe(true);
    expect(reached).toEqual([]);

    send(key("keyup", "Enter"));
    send(key("keydown", "Enter", true));
    expect(reached).toEqual(["Enter*"]);
  });

  it("keeps swallowing when Shift is let go before the first repeat", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    send(key("keyup", "ShiftLeft"));
    send(key("keydown", "Enter", true));
    expect(reached).toEqual([]);
  });

  it("stops at a fresh press of the held key, which goes through", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    send(key("keydown", "Enter", true));
    send(key("keydown", "Enter"));
    send(key("keydown", "Enter", true));
    expect(reached).toEqual(["Enter", "Enter*"]);
  });

  it("lets a key pressed since through, repeats and all, and still swallows the held one", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    send(key("keydown", "Enter", true));
    send(key("keydown", "KeyA"));
    send(key("keydown", "KeyA", true));
    send(key("keyup", "KeyA"));
    send(key("keydown", "Enter", true));
    expect(reached).toEqual(["KeyA", "KeyA*"]);
  });

  it("ends only when every held key is released", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    send(key("keydown", "Enter", true));
    send(key("keydown", "Escape", true));
    send(key("keyup", "Escape"));
    send(key("keydown", "Enter", true));
    expect(reached).toEqual([]);
    send(key("keyup", "Enter"));
    send(key("keydown", "Enter", true));
    expect(reached).toEqual(["Enter*"]);
  });

  it("goes away when no repeat comes in time: nothing was held", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    vi.advanceTimersByTime(HELD_KEY_WINDOW_MS);
    send(key("keydown", "Enter", true));
    expect(reached).toEqual(["Enter*"]);
  });

  it("stays while a held key repeats past that time", () => {
    const { reached, send } = behindGuard(swallowHeldKeyRepeats);
    send(key("keydown", "Enter", true));
    vi.advanceTimersByTime(HELD_KEY_WINDOW_MS * 2);
    send(key("keydown", "Enter", true));
    expect(reached).toEqual([]);
  });
});

describe("holdInput", () => {
  // Every kind of input the hold stops, as the window sees each.
  const INPUT = [
    "keydown",
    "keypress",
    "paste",
    "beforeinput",
    "input",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "drop",
  ];
  // What events are aimed at: an element in the drop's dialog, and one outside it
  // (the terminal's textarea), each able to lose the focus.
  let inDialog: { blur: () => void };
  let terminal: { blur: () => void };
  const allow = (to: EventTarget | null) => (to as unknown) === inDialog;

  beforeEach(() => {
    inDialog = { blur: vi.fn() };
    terminal = { blur: vi.fn() };
  });

  // An event of `type` at `to`; a drop carries a dataTransfer with `dragTypes`.
  function aimed(type: string, to: unknown, dragTypes = ["text/plain"]): Event {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, "target", { value: to });
    if (type === "drop") Object.defineProperty(e, "dataTransfer", { value: { types: dragTypes } });
    return e;
  }

  // The hold first, as on a window its capture listeners run before the page's.
  // What reaches the page behind it, by event type.
  function held() {
    const target = new EventTarget();
    const release = holdInput(target, allow);
    const reached: string[] = [];
    for (const type of [...INPUT, "focusin"]) {
      target.addEventListener(type, (e) => reached.push(e.type));
    }
    return { release, reached, send: (e: Event) => (target.dispatchEvent(e), e) };
  }

  it("stops every kind of input aimed outside the dialog", () => {
    const { reached, send } = held();
    for (const type of INPUT) {
      expect(send(aimed(type, terminal)).defaultPrevented, type).toBe(true);
    }
    expect(reached).toEqual([]);
  });

  it("lets the dialog's own input through", () => {
    const { reached, send } = held();
    for (const type of INPUT) {
      expect(send(aimed(type, inDialog)).defaultPrevented, type).toBe(false);
    }
    expect(reached).toEqual(INPUT);
  });

  it("leaves dropped files to useFileDrop, and stops dropped text", () => {
    const { reached, send } = held();
    expect(send(aimed("drop", terminal, ["Files"])).defaultPrevented).toBe(false);
    expect(send(aimed("drop", terminal, ["text/plain"])).defaultPrevented).toBe(true);
    expect(reached).toEqual(["drop"]);
  });

  it("takes the focus off anything outside the dialog, and leaves the dialog's", () => {
    const { send } = held();
    send(aimed("focusin", terminal));
    send(aimed("focusin", inDialog));
    expect(terminal.blur).toHaveBeenCalledTimes(1);
    expect(inDialog.blur).not.toHaveBeenCalled();
  });

  it("lets everything through once released", () => {
    const { release, reached, send } = held();
    release();
    for (const type of INPUT) {
      expect(send(aimed(type, terminal)).defaultPrevented, type).toBe(false);
    }
    send(aimed("focusin", terminal));
    expect(terminal.blur).not.toHaveBeenCalled();
    expect(reached).toEqual([...INPUT, "focusin"]);
  });
});

describe("withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A promise settled from outside, as an IPC answer is.
  function later<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("gives what the work comes to in time, and leaves no timer", async () => {
    const answer = later<string>();
    const result = withDeadline(() => answer.promise, 1000);
    vi.advanceTimersByTime(999);
    answer.resolve("folder");
    await expect(result).resolves.toBe("folder");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes on a failure in time as it is", async () => {
    const answer = later<string>();
    const result = withDeadline(() => answer.promise, 1000);
    answer.reject(new Error("no such instance"));
    await expect(result).rejects.toThrow("no such instance");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up at the deadline on work that never settles, and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const result = withDeadline((signal) => {
      seen = signal;
      return new Promise<never>(() => {});
    }, 1000);
    const caught = result.catch((e: unknown) => e);
    expect(seen?.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(await caught).toBeInstanceOf(DeadlineError);
    expect(seen?.aborted).toBe(true);
  });

  it("drops an answer that comes after the deadline", async () => {
    const answer = later<string>();
    const result = withDeadline(() => answer.promise, 1000);
    const caught = result.catch((e: unknown) => e);
    vi.advanceTimersByTime(1000);
    answer.resolve("late folder");
    expect(await caught).toBeInstanceOf(DeadlineError);
    await expect(result).rejects.toBeInstanceOf(DeadlineError);
  });

  it("lets the work stop before its next step once the deadline has passed", async () => {
    const first = later<string>();
    const steps: string[] = [];
    const result = withDeadline(async (signal) => {
      steps.push(await first.promise);
      signal.throwIfAborted();
      steps.push("describe");
      return steps;
    }, 1000);
    result.catch(() => {});
    vi.advanceTimersByTime(1000);
    first.resolve("folder");
    await vi.runAllTimersAsync();
    expect(steps).toEqual(["folder"]);
  });
});

describe("lookupTooSlowMessage", () => {
  it("says nothing was copied and what took too long, for each step", () => {
    expect(lookupTooSlowMessage("focus")).toBe(
      "Nothing copied: bringing Multi-Code to the front took over 10 seconds"
    );
    expect(lookupTooSlowMessage("folder")).toBe(
      "Nothing copied: reading the default folder took over 10 seconds"
    );
    expect(lookupTooSlowMessage("items")).toBe(
      "Nothing copied: reading the dropped files took over 10 seconds"
    );
  });

  it("counts the deadline it was given", () => {
    expect(lookupTooSlowMessage("folder", 30_000)).toMatch(/over 30 seconds$/);
  });
});
