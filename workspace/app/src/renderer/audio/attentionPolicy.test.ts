import { describe, expect, it } from "vitest";
import {
  ATTENTION_COOLDOWN_MS,
  shouldPlayAttentionSound,
} from "./attentionPolicy";

describe("shouldPlayAttentionSound", () => {
  it("stays silent while the user is looking at the instance", () => {
    expect(
      shouldPlayAttentionSound({
        isSelected: true,
        windowFocused: true,
        lastSoundAt: 0,
        now: ATTENTION_COOLDOWN_MS * 10,
      })
    ).toBe(false);
  });

  it("sounds when the instance is selected but the window is not focused", () => {
    expect(
      shouldPlayAttentionSound({
        isSelected: true,
        windowFocused: false,
        lastSoundAt: 0,
        now: ATTENTION_COOLDOWN_MS * 10,
      })
    ).toBe(true);
  });

  it("sounds for a different instance even while the window is focused", () => {
    expect(
      shouldPlayAttentionSound({
        isSelected: false,
        windowFocused: true,
        lastSoundAt: 0,
        now: ATTENTION_COOLDOWN_MS * 10,
      })
    ).toBe(true);
  });

  it("sounds for the first activity of an instance", () => {
    expect(
      shouldPlayAttentionSound({
        isSelected: false,
        windowFocused: false,
        lastSoundAt: 0,
        now: 1000,
      })
    ).toBe(true);
  });

  it("collapses a burst from the same instance within the cooldown", () => {
    const now = 1000;
    expect(
      shouldPlayAttentionSound({
        isSelected: false,
        windowFocused: false,
        lastSoundAt: now,
        now: now + ATTENTION_COOLDOWN_MS - 1,
      })
    ).toBe(false);
  });

  it("sounds again once the cooldown has elapsed", () => {
    const now = 1000;
    expect(
      shouldPlayAttentionSound({
        isSelected: false,
        windowFocused: false,
        lastSoundAt: now,
        now: now + ATTENTION_COOLDOWN_MS,
      })
    ).toBe(true);
  });

  it("does not start a cooldown window just because the user was watching", () => {
    // Suppressed-by-focus activities must not consume cooldown: the user
    // looked at the screen, then switched away 1s before the next event —
    // that event should still sound.
    const now = ATTENTION_COOLDOWN_MS * 10;
    expect(
      shouldPlayAttentionSound({
        isSelected: true,
        windowFocused: true,
        lastSoundAt: 0,
        now,
      })
    ).toBe(false);
    expect(
      shouldPlayAttentionSound({
        isSelected: true,
        windowFocused: false,
        lastSoundAt: 0,
        now: now + 1000,
      })
    ).toBe(true);
  });

  it("urgent activity sounds even while the user is watching the instance", () => {
    expect(
      shouldPlayAttentionSound({
        isSelected: true,
        windowFocused: true,
        lastSoundAt: 0,
        now: ATTENTION_COOLDOWN_MS * 10,
        urgent: true,
      })
    ).toBe(true);
  });

  it("urgent activity still respects the cooldown", () => {
    const now = ATTENTION_COOLDOWN_MS * 10;
    expect(
      shouldPlayAttentionSound({
        isSelected: true,
        windowFocused: true,
        lastSoundAt: now,
        now: now + 1,
        urgent: true,
      })
    ).toBe(false);
  });
});
