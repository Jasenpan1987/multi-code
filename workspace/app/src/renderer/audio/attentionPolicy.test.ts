import { describe, expect, it } from "vitest";
import {
  acknowledgesShownInstance,
  keyAcknowledgesShownInstance,
} from "./attentionPolicy";

// Stands in for an element: `closest` answers whether the element sits inside
// one of the containers named.
function elementInside(...containers: string[]) {
  return {
    closest: (selector: string) =>
      selector.split(",").some((s) => containers.includes(s.trim())) ? {} : null,
  };
}

describe("acknowledgesShownInstance", () => {
  it("counts input in the shown instance's page: terminal, compose box, toolbox", () => {
    expect(acknowledgesShownInstance(elementInside(".content"))).toBe(true);
    expect(acknowledgesShownInstance(elementInside(".toolbox"))).toBe(true);
  });

  it("does not count a click in the contact list, which acknowledges the contact clicked instead", () => {
    expect(acknowledgesShownInstance(elementInside(".sidebar"))).toBe(false);
  });

  it("does not count input to a dialog over the page", () => {
    expect(acknowledgesShownInstance(elementInside(".dialog-overlay"))).toBe(false);
  });

  it("counts a target with nowhere to look, such as the window", () => {
    expect(acknowledgesShownInstance(null)).toBe(true);
    expect(acknowledgesShownInstance({})).toBe(true);
  });
});

describe("keyAcknowledgesShownInstance", () => {
  const key = (k: string, code: string, metaKey: boolean) => ({
    key: k,
    code,
    metaKey,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });

  it("counts typing and other Cmd shortcuts", () => {
    expect(keyAcknowledgesShownInstance(key("a", "KeyA", false))).toBe(true);
    expect(keyAcknowledgesShownInstance(key("1", "Digit1", false))).toBe(true);
    expect(keyAcknowledgesShownInstance(key("c", "KeyC", true))).toBe(true);
  });

  it("does not count a modifier on its own, which comes down before its key", () => {
    // Option and Shift before the arrow of Option+Shift+Down, Cmd before a digit.
    expect(keyAcknowledgesShownInstance({ ...key("Alt", "AltLeft", false), altKey: true })).toBe(false);
    expect(keyAcknowledgesShownInstance({ ...key("Shift", "ShiftLeft", false), shiftKey: true })).toBe(false);
    expect(keyAcknowledgesShownInstance({ ...key("Control", "ControlLeft", false), ctrlKey: true })).toBe(false);
  });

  it("does not count the switch keys, which act like a click in the contact list", () => {
    expect(keyAcknowledgesShownInstance(key("Meta", "MetaLeft", true))).toBe(false);
    expect(keyAcknowledgesShownInstance(key("2", "Digit2", true))).toBe(false);
    const optShift = { ...key("ArrowDown", "ArrowDown", false), altKey: true, shiftKey: true };
    expect(keyAcknowledgesShownInstance(optShift)).toBe(false);
    expect(keyAcknowledgesShownInstance({ ...optShift, key: "ArrowUp", code: "ArrowUp" })).toBe(
      false
    );
  });

  it("counts a plain arrow, which goes to the terminal", () => {
    expect(keyAcknowledgesShownInstance(key("ArrowDown", "ArrowDown", false))).toBe(true);
  });
});
