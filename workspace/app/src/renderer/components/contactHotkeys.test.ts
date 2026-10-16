import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HINT_DELAY_MS,
  hotkeyDigit,
  hotkeyTargets,
  listenForContactHotkeys,
} from "./contactHotkeys";

describe("hotkeyTargets", () => {
  const project = (id: string) => ({ id, isManager: false });

  it("leaves out the manager, wherever it is stored", () => {
    const mgr = { id: "m", isManager: true };
    expect(hotkeyTargets([project("a"), mgr, project("b")])).toEqual(["a", "b"]);
  });

  it("keeps only the first nine projects", () => {
    const many = Array.from({ length: 12 }, (_, i) => project(`p${i + 1}`));
    expect(hotkeyTargets(many)).toEqual(
      ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]
    );
  });
});

describe("hotkeyDigit", () => {
  const chord = (code: string, mods: Partial<Record<string, boolean>> = {}) => ({
    code,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("reads Cmd plus 1 to 9", () => {
    expect(hotkeyDigit(chord("Digit1"))).toBe(1);
    expect(hotkeyDigit(chord("Digit9"))).toBe(9);
  });

  it("ignores 0, other keys, and the digit without Cmd", () => {
    expect(hotkeyDigit(chord("Digit0"))).toBeNull();
    expect(hotkeyDigit(chord("KeyC"))).toBeNull();
    expect(hotkeyDigit(chord("Digit1", { metaKey: false }))).toBeNull();
  });

  it("ignores Cmd plus another modifier, which is some other shortcut", () => {
    expect(hotkeyDigit(chord("Digit1", { shiftKey: true }))).toBeNull();
    expect(hotkeyDigit(chord("Digit1", { altKey: true }))).toBeNull();
    expect(hotkeyDigit(chord("Digit1", { ctrlKey: true }))).toBeNull();
  });
});

describe("listenForContactHotkeys", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A window stand-in: Node's EventTarget, with key events built from plain Events.
  function setup() {
    const target = new EventTarget();
    const state = {
      targets: ["a", "b", "c"],
      paused: false,
      shown: false,
      selected: [] as string[],
    };
    const stop = listenForContactHotkeys(target, {
      targets: () => state.targets,
      select: (id) => state.selected.push(id),
      showHints: (shown) => {
        state.shown = shown;
      },
      paused: () => state.paused,
    });
    const send = (type: string, key: string, code: string, metaKey: boolean) => {
      const e = Object.assign(new Event(type, { cancelable: true }), {
        key,
        code,
        metaKey,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      });
      target.dispatchEvent(e);
      return e;
    };
    return {
      state,
      stop,
      cmdDown: () => send("keydown", "Meta", "MetaLeft", true),
      cmdUp: () => send("keyup", "Meta", "MetaLeft", false),
      cmd: (key: string, code: string) => send("keydown", key, code, true),
      plain: (key: string, code: string) => send("keydown", key, code, false),
      blur: () => target.dispatchEvent(new Event("blur")),
    };
  }

  it("shows the digits only once Cmd has been held for the delay", () => {
    const t = setup();
    t.cmdDown();
    vi.advanceTimersByTime(HINT_DELAY_MS - 1);
    expect(t.state.shown).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.state.shown).toBe(true);
  });

  it("hides them when Cmd is released, and never shows them for a quick release", () => {
    const t = setup();
    t.cmdDown();
    vi.advanceTimersByTime(HINT_DELAY_MS);
    t.cmdUp();
    expect(t.state.shown).toBe(false);

    t.cmdDown();
    vi.advanceTimersByTime(HINT_DELAY_MS / 2);
    t.cmdUp();
    vi.advanceTimersByTime(HINT_DELAY_MS * 4);
    expect(t.state.shown).toBe(false);
  });

  it("takes Cmd plus another key as some other shortcut, before or after the digits show", () => {
    const t = setup();
    t.cmdDown();
    t.cmd("c", "KeyC");
    vi.advanceTimersByTime(HINT_DELAY_MS * 4);
    expect(t.state.shown).toBe(false);

    t.cmdUp();
    t.cmdDown();
    vi.advanceTimersByTime(HINT_DELAY_MS);
    t.cmd("v", "KeyV");
    expect(t.state.shown).toBe(false);
  });

  it("hides them when the window loses focus, where the keyup never arrives", () => {
    const t = setup();
    t.cmdDown();
    vi.advanceTimersByTime(HINT_DELAY_MS);
    t.blur();
    expect(t.state.shown).toBe(false);
  });

  it("selects the contact for Cmd plus its digit and keeps the key from the terminal", () => {
    const t = setup();
    const e = t.cmd("2", "Digit2");
    expect(t.state.selected).toEqual(["b"]);
    expect(e.defaultPrevented).toBe(true);
    expect(e.cancelBubble).toBe(true);
  });

  it("keeps the digits up while Cmd is held, so a second digit can follow", () => {
    const t = setup();
    t.cmdDown();
    vi.advanceTimersByTime(HINT_DELAY_MS);
    t.cmd("1", "Digit1");
    t.cmd("3", "Digit3");
    expect(t.state.selected).toEqual(["a", "c"]);
    expect(t.state.shown).toBe(true);
  });

  it("swallows a digit with no contact behind it", () => {
    const t = setup();
    const e = t.cmd("9", "Digit9");
    expect(t.state.selected).toEqual([]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("reads the contacts at each key press, so a reorder applies at once", () => {
    const t = setup();
    t.state.targets = ["c", "a"];
    t.cmd("1", "Digit1");
    expect(t.state.selected).toEqual(["c"]);
  });

  it("lets a digit typed without Cmd through to the terminal", () => {
    const t = setup();
    const e = t.plain("1", "Digit1");
    expect(t.state.selected).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves every key to an open dialog", () => {
    const t = setup();
    t.state.paused = true;
    t.cmdDown();
    vi.advanceTimersByTime(HINT_DELAY_MS * 4);
    expect(t.state.shown).toBe(false);
    const e = t.cmd("1", "Digit1");
    expect(t.state.selected).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("stops listening, and drops a pending show, once stopped", () => {
    const t = setup();
    t.cmdDown();
    t.stop();
    vi.advanceTimersByTime(HINT_DELAY_MS * 4);
    expect(t.state.shown).toBe(false);
    t.cmd("1", "Digit1");
    expect(t.state.selected).toEqual([]);
  });
});
