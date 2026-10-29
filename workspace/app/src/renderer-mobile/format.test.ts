// The times the list and the chat print.

import { describe, expect, it } from "vitest";
import { duration, shortAge } from "./format";

describe("duration", () => {
  it("prints seconds, minutes with padded seconds, then hours with padded minutes", () => {
    expect(duration(48_000)).toBe("48s");
    expect(duration(65_000)).toBe("1m 05s");
    expect(duration(161_000)).toBe("2m 41s");
    expect(duration(200_000)).toBe("3m 20s");
    expect(duration(3_900_000)).toBe("1h 05m");
    expect(duration(-5_000)).toBe("0s");
  });
});

describe("shortAge", () => {
  // Thursday 29 October 2026, 14:32 on the phone's clock.
  const now = new Date(2026, 9, 29, 14, 32).getTime();
  const at = (days: number, hour: number, minute = 0) => new Date(2026, 9, 29 - days, hour, minute).getTime();

  it("counts minutes, then hours today", () => {
    expect(shortAge(now - 20_000, now)).toBe("now");
    expect(shortAge(now - 2 * 60_000, now)).toBe("2m");
    expect(shortAge(now - 15 * 60_000, now)).toBe("15m");
    expect(shortAge(at(0, 9), now)).toBe("5h");
  });

  it("names yesterday, the weekday within a week, the date beyond", () => {
    expect(shortAge(at(1, 23), now)).toBe("Yesterday");
    expect(shortAge(at(3, 9), now)).toBe("Mon");
    expect(shortAge(at(10, 9), now)).toBe("Oct 19");
  });

  it("goes by the calendar day, not 24 hours", () => {
    const justAfterMidnight = new Date(2026, 9, 29, 0, 30).getTime();
    expect(shortAge(at(1, 22), justAfterMidnight)).toBe("Yesterday");
    expect(shortAge(at(1, 23, 50), justAfterMidnight)).toBe("40m");
  });
});
