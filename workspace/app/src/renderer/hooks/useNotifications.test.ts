// markRead tells main only when it cleared something (G-304): the alert counted, or
// one still inside the debounce. A key press on an instance with nothing unread sends
// nothing. readOnPhone clears the same way and tells main nothing: the phone read it.
// React's hooks are stood in for, so the hook runs as a plain function.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useCallback: <T,>(fn: T) => fn,
}));

const { useNotifications } = await import("./useNotifications");

const acknowledgeInstance = vi.fn();
const dispatchEvent = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  acknowledgeInstance.mockReset();
  dispatchEvent.mockReset();
  vi.stubGlobal("window", { dispatchEvent, electronAPI: { acknowledgeInstance } });
});

// The counts the app was last told of.
const published = () => (dispatchEvent.mock.lastCall![0] as CustomEvent).detail.unread as Map<string, number>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("markRead", () => {
  it("acknowledges an instance whose alert was counted, once", () => {
    const { notify, markRead, unread } = useNotifications();
    notify("a", "alpha");
    vi.advanceTimersByTime(500);
    expect(unread.get("a")).toBe(1);

    markRead("a");
    markRead("a");

    expect(unread.has("a")).toBe(false);
    expect(acknowledgeInstance).toHaveBeenCalledTimes(1);
    expect(acknowledgeInstance).toHaveBeenCalledWith("a");
  });

  it("acknowledges an alert still inside the debounce, which then never counts", () => {
    const { notify, markRead, unread } = useNotifications();
    notify("a", "alpha");
    markRead("a");
    vi.advanceTimersByTime(500);

    expect(unread.has("a")).toBe(false);
    expect(acknowledgeInstance).toHaveBeenCalledWith("a");
  });

  it("sends nothing for an instance with nothing unread", () => {
    const { notify, markRead } = useNotifications();
    notify("b", "beta");
    vi.advanceTimersByTime(500);

    markRead("a");

    expect(acknowledgeInstance).not.toHaveBeenCalled();
  });
});

describe("readOnPhone", () => {
  it("clears a counted alert, tells the app, and acknowledges nothing", () => {
    const { notify, readOnPhone, unread } = useNotifications();
    notify("a", "alpha");
    vi.advanceTimersByTime(500);
    notify("b", "beta");
    vi.advanceTimersByTime(500);
    expect(published()).toEqual(new Map([["a", 1], ["b", 1]]));

    readOnPhone("a");

    expect(unread.has("a")).toBe(false);
    expect(published()).toEqual(new Map([["b", 1]]));
    expect(acknowledgeInstance).not.toHaveBeenCalled();
  });

  it("drops an alert still inside the debounce, which then never counts", () => {
    const { notify, readOnPhone, unread } = useNotifications();
    // Main sends the read right after the activity that started the count.
    notify("a", "alpha");
    readOnPhone("a");
    vi.advanceTimersByTime(500);

    expect(unread.has("a")).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(acknowledgeInstance).not.toHaveBeenCalled();
  });

  it("leaves nothing for a later markRead to acknowledge", () => {
    const { notify, markRead, readOnPhone } = useNotifications();
    notify("a", "alpha");
    vi.advanceTimersByTime(500);
    readOnPhone("a");

    markRead("a");

    expect(acknowledgeInstance).not.toHaveBeenCalled();
  });

  it("counts the next alert as usual", () => {
    const { notify, readOnPhone, unread } = useNotifications();
    readOnPhone("a");
    notify("a", "alpha");
    vi.advanceTimersByTime(500);

    expect(unread.get("a")).toBe(1);
  });
});
