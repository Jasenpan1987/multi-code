// What the bottom of a session's chat holds (footOf): never the compose box or Stop
// while a dialog is open or an answer's keys are still going in.

import { describe, expect, it } from "vitest";
import { footOf } from "./SessionScreen";

const base = { dialog: false, needsYou: false, answering: false, stopped: false, gone: false };

describe("footOf", () => {
  it("is the compose box when nothing else is going on", () => {
    expect(footOf(base)).toBe("compose");
  });

  it("is the dialog slot while a dialog is open, or the list says one is", () => {
    expect(footOf({ ...base, dialog: true, needsYou: true })).toBe("dialog");
    expect(footOf({ ...base, needsYou: true })).toBe("dialog");
  });

  it("keeps the compose box away until an answer's ack, after its dialog has closed", () => {
    // prompt-cleared came with the first key; the list may say working or idle.
    expect(footOf({ ...base, answering: true })).toBe("answering");
    expect(footOf({ ...base, answering: true, needsYou: true })).toBe("answering");
    // A new dialog the Mac described shows at once.
    expect(footOf({ ...base, answering: true, dialog: true, needsYou: true })).toBe("dialog");
  });

  it("says so once the session has stopped or gone", () => {
    expect(footOf({ ...base, stopped: true })).toBe("ended");
    expect(footOf({ ...base, gone: true })).toBe("ended");
  });
});
