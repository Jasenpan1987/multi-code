import { describe, expect, it } from "vitest";
import type { SecretaryBriefState } from "../../shared/types";
import {
  applyBriefUpdate,
  briefCardView,
  briefLang,
  cardOnSelect,
  mergeBriefSnapshot,
  openCardBrief,
} from "./secretaryBrief";
import type { BriefMap } from "./secretaryBrief";

const preparing = (seq: number): SecretaryBriefState => ({
  seq,
  kind: "finished",
  status: "preparing",
});

const ready = (
  seq: number,
  audio: "pending" | "ready" | "unavailable",
  voiceReason?: string
): SecretaryBriefState => ({
  seq,
  kind: "needs-you",
  status: "ready",
  text: "Portals wants to run the tests.",
  language: "English",
  audio,
  voiceReason,
});

const failed = (seq: number): SecretaryBriefState => ({
  seq,
  kind: "finished",
  status: "failed",
  reason: "timed out after 60 s",
});

describe("cardOnSelect", () => {
  const briefs: BriefMap = { a: preparing(3), b: ready(4, "ready") };

  it("opens the card for the brief's event when the contact showed a red dot", () => {
    expect(cardOnSelect("a", true, new Set(["a"]), briefs)).toEqual({ instanceId: "a", seq: 3 });
    expect(cardOnSelect("b", true, new Set(["a", "b"]), briefs)).toEqual({
      instanceId: "b",
      seq: 4,
    });
  });

  it("opens nothing with Secretary Mode off", () => {
    expect(cardOnSelect("a", false, new Set(["a"]), briefs)).toBeNull();
  });

  it("opens nothing for a contact without a red dot, brief or not", () => {
    expect(cardOnSelect("a", true, new Set(["b"]), briefs)).toBeNull();
    expect(cardOnSelect("a", true, new Set(), briefs)).toBeNull();
  });

  it("opens nothing for a red dot with no brief: the event was already dealt with", () => {
    expect(cardOnSelect("c", true, new Set(["c"]), briefs)).toBeNull();
  });
});

describe("openCardBrief", () => {
  const card = { instanceId: "a", seq: 3 };
  const view = { modeOn: true, selectedId: "a", briefs: { a: ready(3, "pending") } };

  it("shows the brief the card was opened for, as it progresses", () => {
    expect(openCardBrief(card, view)).toEqual(ready(3, "pending"));
    expect(openCardBrief(card, { ...view, briefs: { a: ready(3, "ready") } })).toEqual(
      ready(3, "ready")
    );
  });

  it("closes when another contact is shown", () => {
    expect(openCardBrief(card, { ...view, selectedId: "b" })).toBeNull();
    expect(openCardBrief(card, { ...view, selectedId: null })).toBeNull();
  });

  it("closes when Secretary Mode goes off", () => {
    expect(openCardBrief(card, { ...view, modeOn: false })).toBeNull();
  });

  it("closes when the brief is dropped (answered in the terminal)", () => {
    expect(openCardBrief(card, { ...view, briefs: {} })).toBeNull();
  });

  it("closes when a newer event replaces the brief, rather than playing it unasked", () => {
    expect(openCardBrief(card, { ...view, briefs: { a: preparing(7) } })).toBeNull();
  });

  it("is closed with no card", () => {
    expect(openCardBrief(null, view)).toBeNull();
  });
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

describe("briefCardView", () => {
  it("says preparing until the text exists, with the voice still to come", () => {
    expect(briefCardView(preparing(1))).toEqual({
      kindLabel: "Finished",
      text: null,
      language: null,
      note: { tone: "muted", text: "Preparing the brief…" },
      audioReady: false,
      voiceComing: true,
    });
  });

  it("shows the text while the voice is on its way", () => {
    const view = briefCardView(ready(1, "pending"));
    expect(view.kindLabel).toBe("Needs you");
    expect(view.text).toBe("Portals wants to run the tests.");
    expect(view.language).toBe("English");
    expect(view.note).toEqual({ tone: "muted", text: "Voice on its way…" });
    expect(view.audioReady).toBe(false);
    expect(view.voiceComing).toBe(true);
  });

  it("is playable once the audio is ready, with no note", () => {
    const view = briefCardView(ready(1, "ready"));
    expect(view.note).toBeNull();
    expect(view.audioReady).toBe(true);
    expect(view.voiceComing).toBe(false);
  });

  it("notes the voice is unavailable, with main's reason", () => {
    const view = briefCardView(ready(1, "unavailable", "no speech server set"));
    expect(view.text).toBe("Portals wants to run the tests.");
    expect(view.note).toEqual({
      tone: "warn",
      text: "Voice unavailable",
      detail: "no speech server set",
    });
    expect(view.audioReady).toBe(false);
    expect(view.voiceComing).toBe(false);
  });

  it("says in one line that no brief could be written, with the reason", () => {
    expect(briefCardView(failed(1))).toEqual({
      kindLabel: "Finished",
      text: null,
      language: null,
      note: { tone: "warn", text: "No brief could be written", detail: "timed out after 60 s" },
      audioReady: false,
      voiceComing: false,
    });
  });
});

describe("briefLang", () => {
  it("marks the text with the brief's language", () => {
    expect(briefLang("Chinese")).toBe("zh");
    expect(briefLang("English")).toBe("en");
    expect(briefLang(null)).toBeUndefined();
  });
});
