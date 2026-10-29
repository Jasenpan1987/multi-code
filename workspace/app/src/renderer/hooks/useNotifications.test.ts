// markRead tells main only when it cleared something (G-304): the alert counted, or
// one still inside the debounce. A key press on an instance with nothing unread sends
// nothing. React's hooks are stood in for, so the hook runs as a plain function.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useCallback: <T,>(fn: T) => fn,
}));

const { useNotifications } = await import("./useNotifications");

const acknowledgeInstance = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  acknowledgeInstance.mockReset();
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), electronAPI: { acknowledgeInstance } });
});

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
