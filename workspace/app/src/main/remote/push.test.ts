// The push module on its own (mobile-v2 T-810): the VAPID keys' file, the
// Declarative Web Push payload, and what a send's outcome becomes. web-push's send is
// mocked, so nothing reaches a push service; its key generation and JWT signing are
// the real ones. ws-server.test.ts covers who gets a push, and when.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";

let userData = "";

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const sendNotification = vi.fn();
const getVapidHeaders = vi.fn();
vi.mock("web-push", async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import("web-push") }>()).default;
  getVapidHeaders.mockImplementation(actual.getVapidHeaders);
  return { default: { ...actual, sendNotification, getVapidHeaders } };
});

const { declarativePayload, loadVapidKeys, sendPush, topicOf } = await import("./push");
const { default: webpush } = await import("web-push");

const keysFile = () => path.join(userData, "remote-push.json");
const mode = (file: string) => fs.statSync(file).mode & 0o777;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-push-"));
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("the VAPID keys", () => {
  it("are generated once, kept at 0600, and the same on every load after", () => {
    const first = loadVapidKeys();
    if (!first.ok) throw new Error(first.error);
    expect(first.created).toBe(true);
    expect(mode(keysFile())).toBe(0o600);
    expect(Buffer.from(first.keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(first.keys.privateKey, "base64url")).toHaveLength(32);
    expect(JSON.parse(fs.readFileSync(keysFile(), "utf8"))).toEqual(first.keys);

    expect(loadVapidKeys()).toEqual({ ok: true, keys: first.keys, created: false });
  });

  it("are replaced when the file is corrupt, and the replacement is 0600 too", () => {
    for (const corrupt of ["{not json", JSON.stringify({ publicKey: "abc", privateKey: "def" }), "null"]) {
      fs.writeFileSync(keysFile(), corrupt, { mode: 0o644 });
      const loaded = loadVapidKeys();
      expect(loaded, corrupt).toMatchObject({ ok: true, created: true });
      expect(mode(keysFile())).toBe(0o600);
      expect(loadVapidKeys()).toMatchObject({ ok: true, created: false });
    }
  });

  it("are an error, not an unsaved pair, when the file can't be written", () => {
    const blocker = path.join(userData, "not-a-folder");
    fs.writeFileSync(blocker, "");
    userData = blocker;
    const loaded = loadVapidKeys();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/^Couldn't save the push keys: /);
    userData = path.dirname(blocker);
  });
});

describe("the payload", () => {
  it("is Declarative Web Push, with app_badge at the top level", () => {
    const json = declarativePayload({
      title: "demo · Needs you",
      body: "Bash: pnpm test:e2e",
      navigate: "https://mac.example.ts.net/#/s/inst-1",
      tag: "inst-1",
      badge: 2,
    });
    expect(JSON.parse(json)).toEqual({
      web_push: 8030,
      notification: {
        title: "demo · Needs you",
        body: "Bash: pnpm test:e2e",
        navigate: "https://mac.example.ts.net/#/s/inst-1",
        tag: "inst-1",
      },
      app_badge: 2,
    });
  });

  it("leaves out an empty body, and the badge when there is none", () => {
    expect(JSON.parse(declarativePayload({ title: "t", body: "", navigate: "https://x/#/", tag: "a" }))).toEqual({
      web_push: 8030,
      notification: { title: "t", navigate: "https://x/#/", tag: "a" },
    });
    // Zero clears the icon's number, so it is sent.
    expect(JSON.parse(declarativePayload({ title: "t", navigate: "https://x/#/", tag: "a", badge: 0 })).app_badge).toBe(0);
  });

  it("has a Topic per session within what the push service takes", () => {
    const topic = topicOf("0b6f2c1e-9a35-4c39-8e5e-1a2b3c4d5e6f");
    expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(topicOf("0b6f2c1e-9a35-4c39-8e5e-1a2b3c4d5e6f")).toBe(topic);
    expect(topicOf("another")).not.toBe(topic);
  });
});

describe("sending", () => {
  const P256DH = crypto.createECDH("prime256v1").generateKeys().toString("base64url");
  const AUTH = crypto.randomBytes(16).toString("base64url");
  const apple = { endpoint: "https://web.push.apple.com/QK1", keys: { p256dh: P256DH, auth: AUTH } };
  const mozilla = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys: { p256dh: P256DH, auth: AUTH } };
  const refused = (statusCode: number, body = "") =>
    new webpush.WebPushError("Received unexpected response code", statusCode, {}, body, apple.endpoint);
  const authorizationOf = (call: number) => String(sendNotification.mock.calls[call][2].headers.Authorization);

  function keys() {
    const loaded = loadVapidKeys();
    if (!loaded.ok) throw new Error(loaded.error);
    return loaded.keys;
  }

  it("asks for delivery now, kept an hour, with the payload as given", async () => {
    const vapid = keys();
    const result = await sendPush(apple, '{"web_push":8030}', {
      keys: vapid,
      subject: "https://mac.example.ts.net",
      topic: "abc",
    });
    expect(result).toEqual({ ok: true });
    const [subscription, payload, options] = sendNotification.mock.calls[0];
    expect(subscription).toEqual(apple);
    expect(payload).toBe('{"web_push":8030}');
    expect(options).toMatchObject({ TTL: 3600, urgency: "high", topic: "abc", timeout: 5000 });
    expect(authorizationOf(0)).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
  });

  it("signs one JWT per push service and reuses it for an hour (Apple: refresh at most once an hour)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const vapid = keys();
    const options = { keys: vapid, subject: "https://mac.example.ts.net" };
    getVapidHeaders.mockClear();
    await sendPush(apple, "{}", options);
    await sendPush(apple, "{}", options);
    await sendPush(mozilla, "{}", options);
    expect(getVapidHeaders).toHaveBeenCalledTimes(2);
    expect(authorizationOf(1)).toBe(authorizationOf(0));
    expect(authorizationOf(2)).not.toBe(authorizationOf(0));
    const claims = (call: number) =>
      JSON.parse(Buffer.from(authorizationOf(call).split(".")[1], "base64url").toString("utf8"));
    expect(claims(0)).toMatchObject({ aud: "https://web.push.apple.com", sub: "https://mac.example.ts.net" });
    expect(claims(2)).toMatchObject({ aud: "https://updates.push.services.mozilla.com" });

    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    await sendPush(apple, "{}", options);
    expect(getVapidHeaders).toHaveBeenCalledTimes(3);
    expect(claims(3).exp).toBeGreaterThan(claims(0).exp);

    // One Apple refused is signed afresh for the next push.
    sendNotification.mockRejectedValueOnce(refused(403, JSON.stringify({ reason: "BadJwtToken" })));
    expect(await sendPush(apple, "{}", options)).toEqual({
      ok: false,
      gone: false,
      error: "The push service refused it: 403 BadJwtToken",
    });
    expect(getVapidHeaders).toHaveBeenCalledTimes(3);
    await sendPush(apple, "{}", options);
    expect(getVapidHeaders).toHaveBeenCalledTimes(4);
  });

  it("gives up on a send that never settles, as when the response is cut off after its headers", async () => {
    const options = { keys: keys(), subject: "https://mac.example.ts.net" };
    vi.useFakeTimers();
    sendNotification.mockReturnValueOnce(new Promise(() => {}));
    const pending = sendPush(apple, "{}", options);
    // The request's own agent: destroying it ends the request, whatever it is doing.
    const agent = sendNotification.mock.calls[0][2].agent as https.Agent;
    expect(agent).toBeInstanceOf(https.Agent);
    const destroy = vi.spyOn(agent, "destroy");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(destroy).toHaveBeenCalled();
    expect(await pending).toEqual({ ok: false, gone: false, error: "Couldn't send it: No answer from the push service" });
    // And a send that does settle leaves no deadline behind.
    expect(await sendPush(apple, "{}", options)).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says gone for 404 and 410, and what went wrong otherwise, without rejecting", async () => {
    const options = { keys: keys(), subject: "https://mac.example.ts.net" };
    for (const status of [404, 410]) {
      sendNotification.mockRejectedValueOnce(refused(status));
      expect(await sendPush(apple, "{}", options)).toEqual({ ok: false, gone: true });
    }
    sendNotification.mockRejectedValueOnce(refused(413, JSON.stringify({ reason: "PayloadTooLarge" })));
    expect(await sendPush(apple, "{}", options)).toMatchObject({ error: "The push service refused it: 413 PayloadTooLarge" });
    sendNotification.mockRejectedValueOnce(refused(429, "Too many requests\n"));
    expect(await sendPush(apple, "{}", options)).toMatchObject({ error: "The push service refused it: 429 Too many requests" });
    sendNotification.mockRejectedValueOnce(refused(500));
    expect(await sendPush(apple, "{}", options)).toMatchObject({ error: "The push service refused it: 500" });
    sendNotification.mockRejectedValueOnce(new Error("Socket timeout"));
    expect(await sendPush(apple, "{}", options)).toEqual({ ok: false, gone: false, error: "Couldn't send it: Socket timeout" });
    expect(await sendPush({ ...apple, endpoint: "nope" }, "{}", options)).toMatchObject({ ok: false, gone: false });
  });
});
