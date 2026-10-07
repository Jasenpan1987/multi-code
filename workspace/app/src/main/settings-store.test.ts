// The secretary's settings: the two new fields round-trip through settings.json,
// and the speech key lives only in its own 0600 file. Whatever the renderer gets
// back (settings-get and every secretary:* reply) must not contain the key.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// A space on purpose, like the real "Application Support".
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode settings-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const {
  loadSettings,
  saveSettings,
  loadSecretarySettings,
  loadSpeechServer,
  setSecretaryMode,
  setSpeechServer,
} = await import("./settings-store");

const settingsFile = path.join(userData, "settings.json");
const keyFile = path.join(userData, "speech-key");
const KEY = "sk-live-9f8e7d6c5b4a3210";
const modeOf = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

beforeEach(() => {
  fs.rmSync(settingsFile, { force: true });
  fs.rmSync(keyFile, { force: true });
});

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("secretary settings", () => {
  it("default to off, no server, no key", () => {
    expect(loadSettings()).toEqual({
      theme: "light",
      remoteEnabled: false,
      secretaryMode: false,
      speechServerUrl: "",
    });
    expect(loadSecretarySettings()).toEqual({
      secretaryMode: false,
      speechServerUrl: "",
      hasSpeechKey: false,
    });
    expect(loadSpeechServer()).toEqual({ url: "", key: "" });
  });

  it("keep Secretary Mode across a reload without touching other settings", () => {
    saveSettings({ ...loadSettings(), theme: "dark", remoteEnabled: true });
    expect(setSecretaryMode(true).secretaryMode).toBe(true);
    expect(loadSettings()).toMatchObject({
      theme: "dark",
      remoteEnabled: true,
      secretaryMode: true,
    });
    expect(setSecretaryMode(false).secretaryMode).toBe(false);
    expect(loadSettings().secretaryMode).toBe(false);
  });

  it("only take a real true or a string from settings.json", () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ secretaryMode: "yes", speechServerUrl: 42, speechKey: KEY })
    );
    expect(loadSettings()).toEqual({
      theme: "light",
      remoteEnabled: false,
      secretaryMode: false,
      speechServerUrl: "",
    });
  });
});

describe("setSpeechServer", () => {
  it("writes the key to its own 0600 file and never into settings.json", () => {
    const reply = setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });

    expect(reply).toEqual({
      secretaryMode: false,
      speechServerUrl: "https://tts.example.com",
      hasSpeechKey: true,
    });
    expect(fs.readFileSync(keyFile, "utf8")).toBe(KEY);
    expect(modeOf(keyFile)).toBe("600");
    expect(fs.readFileSync(settingsFile, "utf8")).not.toContain(KEY);
    expect(loadSpeechServer()).toEqual({ url: "https://tts.example.com", key: KEY });
  });

  it("never hands the key back to the renderer", () => {
    const replies = [
      setSpeechServer("https://tts.example.com", { kind: "set", key: KEY }),
      setSecretaryMode(true),
      loadSecretarySettings(),
      loadSettings(),
      setSpeechServer("https://tts.example.com", { kind: "unchanged" }),
    ];
    for (const reply of replies) expect(JSON.stringify(reply)).not.toContain(KEY);
  });

  it("tightens a key file that was world-readable", () => {
    fs.writeFileSync(keyFile, "old", { mode: 0o644 });
    fs.chmodSync(keyFile, 0o644);
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });
    expect(modeOf(keyFile)).toBe("600");
    expect(fs.readFileSync(keyFile, "utf8")).toBe(KEY);
  });

  it("keeps the key on unchanged and on a blank set, and removes it on clear", () => {
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });

    setSpeechServer("https://other.example.com", { kind: "unchanged" });
    expect(loadSpeechServer()).toEqual({ url: "https://other.example.com", key: KEY });

    setSpeechServer("https://other.example.com", { kind: "set", key: "   " });
    expect(loadSpeechServer().key).toBe(KEY);

    const reply = setSpeechServer("https://other.example.com", { kind: "clear" });
    expect(reply.hasSpeechKey).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it("allows an empty address, which means text only, and keeps the key", () => {
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });
    const reply = setSpeechServer("", { kind: "unchanged" });
    expect(reply).toMatchObject({ speechServerUrl: "", hasSpeechKey: true });
  });

  it("trims a pasted key and normalizes the address", () => {
    setSpeechServer("  https://tts.example.com/v1/ ", { kind: "set", key: `  ${KEY}\n` });
    expect(loadSpeechServer()).toEqual({ url: "https://tts.example.com", key: KEY });
  });

  it("refuses a key with spaces or control characters, without echoing it", () => {
    const bad = "sk-has a-space";
    expect(() =>
      setSpeechServer("https://tts.example.com", { kind: "set", key: bad })
    ).toThrow(/printable/);
    try {
      setSpeechServer("https://tts.example.com", { kind: "set", key: bad });
    } catch (err) {
      expect(String(err)).not.toContain(bad);
    }
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it("refuses a malformed change rather than guessing", () => {
    expect(() =>
      setSpeechServer("https://tts.example.com", { kind: "nope" } as never)
    ).toThrow();
    expect(() => setSpeechServer("https://tts.example.com", null as never)).toThrow();
    expect(() => setSpeechServer(7 as never, { kind: "unchanged" })).toThrow();
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});
