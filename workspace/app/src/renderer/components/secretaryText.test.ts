import { describe, expect, it } from "vitest";
import { ipcErrorMessage, savingDropsKey, speechTestLine } from "./secretaryText";

describe("speechTestLine", () => {
  it("says OK with the round trip in seconds", () => {
    expect(speechTestLine({ ok: true, ms: 2345 })).toEqual({
      tone: "ok",
      text: "OK in 2.3 s",
    });
    expect(speechTestLine({ ok: true, ms: 80 }).text).toBe("OK in 0.1 s");
  });

  it("shows an address problem as a warning, without a step label", () => {
    expect(
      speechTestLine({
        ok: false,
        step: "address",
        reason: "no speech server set, briefs are text only",
      })
    ).toEqual({ tone: "warn", text: "No speech server set, briefs are text only" });
  });

  it("names the step that failed ahead of main's reason", () => {
    expect(
      speechTestLine({ ok: false, step: "health", reason: "unreachable (ENOTFOUND)" })
    ).toEqual({ tone: "error", text: "Health check: unreachable (ENOTFOUND)" });
    expect(
      speechTestLine({ ok: false, step: "speech", reason: "key rejected (HTTP 401)" })
    ).toEqual({ tone: "error", text: "Speech: key rejected (HTTP 401)" });
  });
});

describe("ipcErrorMessage", () => {
  it("strips Electron's invoke wrapper and the error class", () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'secretary:set-server': Error: the key can only contain printable characters without spaces"
        )
      )
    ).toBe("The key can only contain printable characters without spaces");
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'secretary:set-server': TypeError: unknown speech key change"
        )
      )
    ).toBe("Unknown speech key change");
  });

  it("passes other messages and non-errors through", () => {
    expect(ipcErrorMessage(new Error("disk full"))).toBe("Disk full");
    expect(ipcErrorMessage("nope")).toBe("Nope");
  });
});

describe("savingDropsKey", () => {
  const saved = "https://tts.example.com";
  it.each([
    ["https://tts.example.com/v1", saved, true, "", false],
    ["https://other.example.com", saved, true, "", true],
    ["https://tts.example.com:8443", saved, true, "", true],
    ["", saved, true, "", true],
    ["https://other.example.com", saved, true, "sk-new", false],
    ["https://other.example.com", saved, false, "", false],
  ])("%j from %j (key saved %j, typed %j) -> %j", (draft, from, has, typed, want) => {
    expect(savingDropsKey(draft, from, has, typed)).toBe(want);
  });
});
