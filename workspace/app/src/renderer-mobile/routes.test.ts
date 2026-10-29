import { describe, expect, it } from "vitest";
import { hashOf, openIdOf, parseHash, type Route } from "./routes";

describe("routes", () => {
  it("reads every screen from the hash, and writes it back", () => {
    const routes: [string, Route][] = [
      ["#/", { screen: "list" }],
      ["#/setup", { screen: "setup" }],
      ["#/s/multi-code", { screen: "session", id: "multi-code" }],
      ["#/s/multi-code/term", { screen: "terminal", id: "multi-code" }],
      ["#/s/a%2Fb%20c", { screen: "session", id: "a/b c" }],
    ];
    for (const [hash, route] of routes) {
      expect(parseHash(hash)).toEqual(route);
      expect(hashOf(route)).toBe(hash);
    }
  });

  it("falls back to the list for anything else", () => {
    for (const hash of ["", "#", "#/nope", "#/s/", "#/s/a/b", "#/s/%E0%A4%A"]) {
      expect(parseHash(hash)).toEqual({ screen: "list" });
    }
  });

  it("opens one subscription for a session's chat and its terminal", () => {
    expect(openIdOf({ screen: "session", id: "a" })).toBe("a");
    expect(openIdOf({ screen: "terminal", id: "a" })).toBe("a");
    expect(openIdOf({ screen: "list" })).toBeNull();
    expect(openIdOf({ screen: "setup" })).toBeNull();
  });
});
