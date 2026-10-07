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

  it("keeps the key on unchanged and on a blank set at the same server, and removes it on clear", () => {
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });

    setSpeechServer("https://tts.example.com/v1/", { kind: "unchanged" });
    expect(loadSpeechServer()).toEqual({ url: "https://tts.example.com", key: KEY });

    setSpeechServer("https://tts.example.com", { kind: "set", key: "   " });
    expect(loadSpeechServer().key).toBe(KEY);

    const reply = setSpeechServer("https://tts.example.com", { kind: "clear" });
    expect(reply.hasSpeechKey).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it("drops the key when the address moves to another server without a new key", () => {
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });
    const reply = setSpeechServer("https://attacker.example", { kind: "unchanged" });
    expect(reply).toMatchObject({ speechServerUrl: "https://attacker.example", hasSpeechKey: false });
    expect(loadSpeechServer().key).toBe("");
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it("drops the key on another port or scheme too, since that is another server", () => {
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });
    expect(setSpeechServer("https://tts.example.com:8443", { kind: "unchanged" }).hasSpeechKey).toBe(false);
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });
    expect(setSpeechServer("http://tts.example.com", { kind: "unchanged" }).hasSpeechKey).toBe(false);
  });

  it("never pairs a new key with the old server when saving the address fails", () => {
    setSpeechServer("https://a.example", { kind: "set", key: KEY });
    // settings.json can't be written: a directory stands in its place.
    const settingsFile = path.join(userData, "settings.json");
    const saved = fs.readFileSync(settingsFile, "utf8");
    fs.rmSync(settingsFile);
    fs.mkdirSync(settingsFile);
    try {
      expect(() =>
        setSpeechServer("https://b.example", { kind: "set", key: "sk-b-key" })
      ).toThrow();
      expect(fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : "").not.toBe("sk-b-key");
    } finally {
      fs.rmSync(settingsFile, { recursive: true });
      fs.writeFileSync(settingsFile, saved);
    }
    // A's address is still the saved one, and B's key went nowhere near it.
    expect(loadSpeechServer()).toEqual({ url: "https://a.example", key: "" });
  });

  it("keeps a key given with the move", () => {
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });
    setSpeechServer("https://other.example.com", { kind: "set", key: "sk-other-key" });
    expect(loadSpeechServer()).toEqual({ url: "https://other.example.com", key: "sk-other-key" });
  });

  it("allows an empty address, which means text only, and forgets the key with it", () => {
    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });
    const reply = setSpeechServer("", { kind: "unchanged" });
    expect(reply).toMatchObject({ speechServerUrl: "", hasSpeechKey: false });
    // Coming back from "" is a move too: no key rides along to whatever is set next.
    expect(setSpeechServer("https://attacker.example", { kind: "unchanged" }).hasSpeechKey).toBe(false);
  });

  it("writes the key through a fresh file, replacing a planted one rather than writing into it", () => {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, "planted", { mode: 0o644 });
    const elsewhere = path.join(path.dirname(keyFile), "planted-target");
    fs.writeFileSync(elsewhere, "untouched");
    fs.rmSync(keyFile);
    fs.symlinkSync(elsewhere, keyFile);

    setSpeechServer("https://tts.example.com", { kind: "set", key: KEY });

    expect(fs.lstatSync(keyFile).isSymbolicLink()).toBe(false);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyFile, "utf8")).toBe(KEY);
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched");
    expect(fs.readdirSync(path.dirname(keyFile)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
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
