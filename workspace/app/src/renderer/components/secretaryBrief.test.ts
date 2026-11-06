import { describe, expect, it } from "vitest";
import type { SecretaryBriefState } from "../../shared/types";
import {
  IDLE,
  applyBriefUpdate,
  barControls,
  barState,
  briefKey,
  briefLang,
  editDraft,
  isReadableBrief,
  keepDrafts,
  mergeBriefSnapshot,
  queueLabel,
  readsOnEnd,
  replyView,
} from "./secretaryBrief";
import type { Drafts } from "./secretaryBrief";

const preparing = (seq: number): SecretaryBriefState => ({
  seq,
  at: seq,
  kind: "finished",
  status: "preparing",
});

const ready = (
  seq: number,
  audio: "pending" | "ready" | "unavailable",
  voiceReason?: string
): SecretaryBriefState => ({
  seq,
  at: seq,
  kind: "needs-you",
  status: "ready",
  text: "Shop wants to run the tests.",
  language: "English",
  audio,
  voiceReason,
});

const handled = (state: SecretaryBriefState): SecretaryBriefState => ({
  ...state,
  handled: true,
});

const failed = (seq: number): SecretaryBriefState => ({
  seq,
  at: seq,
  kind: "finished",
  status: "failed",
  reason: "timed out after 60 s",
});

describe("applyBriefUpdate", () => {
  it("adds and replaces a brief", () => {
    const one = applyBriefUpdate({}, "a", preparing(1));
    expect(one).toEqual({ a: preparing(1) });
    expect(applyBriefUpdate(one, "a", ready(1, "pending"))).toEqual({ a: ready(1, "pending") });
  });

  it("drops a brief on null, and leaves the map as it is when there was none", () => {
    const briefs = { a: preparing(1), b: preparing(2) };
    expect(applyBriefUpdate(briefs, "a", null)).toEqual({ b: preparing(2) });
    expect(applyBriefUpdate(briefs, "c", null)).toBe(briefs);
  });
});

describe("mergeBriefSnapshot", () => {
  it("takes the snapshot for instances no push has touched", () => {
    expect(mergeBriefSnapshot({}, { a: preparing(1) }, new Set())).toEqual({ a: preparing(1) });
  });

  it("keeps a pushed brief over the snapshot's older one", () => {
    expect(
      mergeBriefSnapshot({ a: ready(1, "ready") }, { a: preparing(1) }, new Set(["a"]))
    ).toEqual({ a: ready(1, "ready") });
  });

  it("keeps a pushed drop: the snapshot doesn't bring the brief back", () => {
    expect(mergeBriefSnapshot({}, { a: preparing(1) }, new Set(["a"]))).toEqual({});
  });

  it("keeps a brief pushed for an instance the snapshot doesn't have", () => {
    expect(
      mergeBriefSnapshot({ b: preparing(2) }, { a: preparing(1) }, new Set(["b"]))
    ).toEqual({ a: preparing(1), b: preparing(2) });
  });
});

describe("barState", () => {
  it("says nothing is new with no brief at all", () => {
    expect(barState(null, IDLE)).toEqual({ tone: "muted", text: "Nothing new" });
  });

  it("says the brief is being written until its text exists", () => {
    expect(barState(preparing(1), IDLE)).toEqual({ tone: "muted", text: "Writing the brief…" });
  });

  it("says the voice is on its way while the text shows", () => {
    expect(barState(ready(1, "pending"), IDLE)).toEqual({ tone: "muted", text: "Voice on its way…" });
  });

  it("is ready once the audio is, and playing while it plays", () => {
    expect(barState(ready(1, "ready"), IDLE)).toEqual({ tone: "ready", text: "Ready" });
    expect(barState(ready(1, "ready"), { ...IDLE, loading: true }).text).toBe("Loading the voice…");
    expect(barState(ready(1, "ready"), { ...IDLE, playing: true })).toEqual({
      tone: "playing",
      text: "Playing",
    });
  });

  it("says the voice is unavailable, with main's reason", () => {
    expect(barState(ready(1, "unavailable", "no speech server set"), IDLE)).toEqual({
      tone: "warn",
      text: "Voice unavailable",
      detail: "no speech server set",
    });
  });

  it("says no brief could be written, with the reason", () => {
    expect(barState(failed(1), IDLE)).toEqual({
      tone: "warn",
      text: "No brief could be written",
      detail: "timed out after 60 s",
    });
  });

  it("says when the voice couldn't play, or the brief went out of date", () => {
    expect(barState(ready(1, "ready"), { ...IDLE, failed: true })).toEqual({
      tone: "warn",
      text: "Couldn't play the voice",
    });
    expect(barState(ready(1, "ready"), { ...IDLE, stale: true }).text).toBe("This brief is out of date");
  });
});

describe("barControls", () => {
  const finished = (state: SecretaryBriefState): SecretaryBriefState => ({ ...state, kind: "finished" });

  it("offers Play only once the audio is ready, and not at all with no voice", () => {
    expect(barControls(ready(1, "ready"), IDLE)).toMatchObject({ playShown: true, canPlay: true });
    expect(barControls(ready(1, "pending"), IDLE)).toMatchObject({ playShown: true, canPlay: false });
    expect(barControls(preparing(1), IDLE)).toMatchObject({ playShown: true, canPlay: false });
    expect(barControls(ready(1, "unavailable"), IDLE)).toMatchObject({ playShown: false, canPlay: false });
    expect(barControls(failed(1), IDLE)).toMatchObject({ playShown: false, canPlay: false });
    expect(barControls(null, IDLE)).toMatchObject({ playShown: false, canPlay: false });
  });

  it("doesn't play a brief main no longer has audio for", () => {
    expect(barControls(ready(1, "ready"), { ...IDLE, stale: true }).canPlay).toBe(false);
  });

  it("stops while the brief plays or its audio is on the way", () => {
    expect(barControls(ready(1, "ready"), IDLE).canStop).toBe(false);
    expect(barControls(ready(1, "ready"), { ...IDLE, playing: true }).canStop).toBe(true);
    expect(barControls(ready(1, "ready"), { ...IDLE, loading: true }).canStop).toBe(true);
  });

  it("offers Got it on a Finished brief that still waits, never on a Needs you", () => {
    expect(barControls(finished(ready(1, "ready")), IDLE).canDismiss).toBe(true);
    expect(barControls(preparing(1), IDLE).canDismiss).toBe(true);
    expect(barControls(failed(1), IDLE).canDismiss).toBe(true);
    expect(barControls(ready(1, "ready"), IDLE).canDismiss).toBe(false);
    expect(barControls({ ...finished(ready(1, "ready")), seen: true }, IDLE).canDismiss).toBe(false);
    expect(barControls(handled(finished(ready(1, "ready"))), IDLE).canDismiss).toBe(false);
  });
});

describe("queueLabel", () => {
  it("gives the place and the count", () => {
    expect(queueLabel({ index: 2, count: 3 })).toBe("2 / 3");
  });

  it("has no place for a brief that no longer waits", () => {
    expect(queueLabel({ index: 0, count: 2 })).toBe("– / 2");
  });

  it("is nothing with an empty queue", () => {
    expect(queueLabel({ index: 0, count: 0 })).toBeNull();
  });
});

describe("readsOnEnd", () => {
  it("reads the session of a Finished brief, never a Needs you's", () => {
    expect(readsOnEnd(preparing(1))).toBe(true);
    expect(readsOnEnd(ready(1, "ready"))).toBe(false);
    expect(readsOnEnd(null)).toBe(false);
  });
});

describe("isReadableBrief", () => {
  it("reads the Finished brief the bar named", () => {
    expect(isReadableBrief({ a: preparing(1) }, "a", 1)).toBe(true);
    // Seen or handled since: still that brief, and reading it again is harmless.
    expect(isReadableBrief({ a: handled(preparing(1)) }, "a", 1)).toBe(true);
  });

  it("reads nothing once a newer event replaced it, before Got it or the end of its audio", () => {
    expect(isReadableBrief({ a: preparing(2) }, "a", 1)).toBe(false);
    expect(isReadableBrief({ a: ready(2, "pending") }, "a", 1)).toBe(false);
    expect(isReadableBrief({}, "a", 1)).toBe(false);
  });

  it("reads nothing for a Needs you", () => {
    expect(isReadableBrief({ a: ready(1, "ready") }, "a", 1)).toBe(false);
  });
});

describe("drafts", () => {
  const a = briefKey("a", 1);
  const b = briefKey("b", 2);

  it("keeps each brief's draft while stepping between them", () => {
    let drafts: Drafts = {};
    drafts = editDraft(drafts, a, "allow it, but only");
    // Stepped to b and typed there; then back to a.
    drafts = editDraft(drafts, b, "no, run the tests first");
    expect(drafts[a]).toBe("allow it, but only");
    expect(drafts[b]).toBe("no, run the tests first");
    drafts = editDraft(drafts, a, "allow it, but only this once");
    expect(drafts).toEqual({ [a]: "allow it, but only this once", [b]: "no, run the tests first" });
  });

  it("drops a draft once sent or emptied", () => {
    const drafts = { [a]: "yes", [b]: "no" };
    expect(editDraft(drafts, a, "")).toEqual({ [b]: "no" });
    const none: Drafts = {};
    expect(editDraft(none, a, "")).toBe(none);
  });

  it("drops the draft of a brief that was replaced or dropped, and keeps the rest", () => {
    const drafts = { [a]: "yes", [b]: "no" };
    const briefs = { a: ready(1, "ready"), b: ready(2, "ready") };
    expect(keepDrafts(drafts, briefs)).toBe(drafts);
    expect(keepDrafts(drafts, { a: ready(3, "ready"), b: ready(2, "ready") })).toEqual({ [b]: "no" });
    expect(keepDrafts(drafts, { b: ready(2, "ready") })).toEqual({ [b]: "no" });
  });
});

describe("briefLang", () => {
  it("marks the text with the brief's language", () => {
    expect(briefLang("Chinese")).toBe("zh");
    expect(briefLang("English")).toBe("en");
    expect(briefLang(null)).toBeUndefined();
  });
});

describe("replyView", () => {
  const dialog = { ...ready(4, "ready"), replyable: true as const };

  it("offers the box on a Needs-you the secretary can answer, until it is handled", () => {
    expect(replyView(dialog)).toEqual({ exchanges: [], boxShown: true, pending: false });
    expect(replyView({ ...dialog, handled: true }).boxShown).toBe(false);
    expect(replyView(ready(4, "ready")).boxShown).toBe(false);
    // While the brief is still being written, too: the dialog is on screen already.
    const early: SecretaryBriefState = { ...preparing(4), kind: "needs-you", replyable: true };
    expect(replyView(early).boxShown).toBe(true);
    expect(replyView({ ...preparing(4), replyable: true }).boxShown).toBe(false);
  });

  it("keeps the exchanges after the dialog is answered, and is pending while one is open", () => {
    const asked = { reply: "嗯", outcome: "asked" as const, response: "要允许吗？" };
    expect(replyView({ ...dialog, exchanges: [asked, { reply: "要" }] }).pending).toBe(true);
    const pressed = { reply: "要", outcome: "pressed" as const, response: "好" };
    expect(replyView({ ...dialog, handled: true, exchanges: [asked, pressed] })).toEqual({
      exchanges: [asked, pressed],
      boxShown: false,
      pending: false,
    });
  });
});
