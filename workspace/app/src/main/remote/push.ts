// Web Push from this Mac straight to each paired phone's push service (mobile-v2
// Story 7): Apple's `web.push.apple.com` for an iPhone, with no relay of ours.
//
// `web-push` does the standard parts: the VAPID JWT that identifies this Mac (RFC
// 8292) and the payload's encryption to the phone's own keys (RFC 8291), so the push
// service only ever sees ciphertext. This module holds the VAPID keypair, writes the
// Declarative Web Push payload, and turns a send's outcome into what the server
// records on the device. ws-server.ts decides who gets what and when.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import { app } from "electron";
import webpush from "web-push";
import type { RemotePushSubscription } from "../../shared/remote-protocol";
import { debugTrace } from "../debug-trace";

export interface VapidKeys {
  // base64url, uncompressed P-256 point (65 bytes): `auth-ok.vapidPublicKey`, which
  // the phone passes to `pushManager.subscribe` as its applicationServerKey.
  publicKey: string;
  // base64url, 32 bytes. Never logged, never leaves the main process.
  privateKey: string;
}

export type VapidLoad =
  // `created`: there was no usable pair, and this is a new one. Every subscription a
  // phone made was made for the old key and can't be pushed to any more.
  | { ok: true; keys: VapidKeys; created: boolean }
  | { ok: false; error: string };

// How long the push service keeps a push for a phone it can't reach (seconds). A
// session that needed the builder an hour ago has most likely been dealt with, or
// pushed about again since.
const TTL_SECONDS = 60 * 60;

// A send whose socket has been idle this long is given up (web-push destroys the
// request), so a push service that hangs can't hold up the pushes queued behind it
// for that phone.
const SEND_TIMEOUT_MS = 5000;

// And one that hasn't settled at all by this deadline. web-push listens for its
// response's `end` but not for it being cut off: a push service that closes the
// connection after the headers leaves the send pending forever, with no socket left
// for the idle timeout to fire on. One that keeps a response trickling never idles.
// Each send has an agent of its own, destroyed at the deadline, which ends the
// request whatever state it is in.
const SEND_DEADLINE_MS = 15_000;

// Apple: "Don't refresh your JWT more frequently than once per hour" (Sending web
// push notifications in web apps and browsers). web-push signs a new one for every
// send, so the header is made here and reused for this long. web-push's default
// expiry is 12 hours, well past it.
const JWT_REUSE_MS = 60 * 60 * 1000;

// What the Home Screen app shows for a session (or the test).
export interface PushMessage {
  title: string;
  // Absent or empty: the notification is the title alone.
  body?: string;
  // The URL tapping it opens.
  navigate: string;
  // A newer notification with the same tag replaces the older one on the phone: one
  // per session (Story 7).
  tag: string;
  // The Home Screen icon's number. Absent: left as it is.
  badge?: number;
}

export type PushResult =
  | { ok: true }
  // `gone`: the push service says the subscription no longer exists (404/410), and it
  // is deleted. Anything else is `error`, for the device's `lastPushError`.
  | { ok: false; gone: true }
  | { ok: false; gone: false; error: string };

function keysPath(): string {
  return path.join(app.getPath("userData"), "remote-push.json");
}

function isKey(value: unknown, bytes: number): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").length === bytes
  );
}

// The VAPID keypair, generated once and kept in `userData/remote-push.json` at 0600
// (the private half is what lets anyone push to every paired phone). A missing or
// corrupt file gets a new pair, as remote-identity.json does: a phone subscribed with
// the old key subscribes again on its next launch, which is the right outcome for a
// lost key. Only a pair that couldn't be saved is an error: using it would break
// every subscription made with it at the next launch.
export function loadVapidKeys(): VapidLoad {
  const file = keysPath();
  try {
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VapidKeys> | null;
      if (isKey(stored?.publicKey, 65) && isKey(stored?.privateKey, 32)) {
        return { ok: true, keys: { publicKey: stored.publicKey, privateKey: stored.privateKey }, created: false };
      }
    }
  } catch {
    // Unreadable or not JSON: mint a new pair below.
  }

  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    // The mode above applies only to a file that is created; a corrupt one being
    // replaced keeps whatever it had.
    fs.chmodSync(file, 0o600);
  } catch (err) {
    return { ok: false, error: `Couldn't save the push keys: ${(err as Error)?.message ?? err}` };
  }
  return { ok: true, keys, created: true };
}

// The Declarative Web Push message (WebKit, iOS 18.4+): the system shows
// `notification` itself, without waking the phone's service worker, so a push always
// ends in a notification (Safari revokes permission from a site whose push shows
// none). A browser without it hands the same JSON to the service worker's `push`
// handler (T-811), which shows `notification` the same way. `app_badge` is a top-level
// member: WebKit moved it out of `notification` with the standard (295319@main,
// 2025-05), and reads only the top-level one since.
export function declarativePayload(message: PushMessage): string {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: message.title,
      ...(message.body ? { body: message.body } : {}),
      navigate: message.navigate,
      tag: message.tag,
    },
    ...(message.badge !== undefined ? { app_badge: message.badge } : {}),
  });
}

// The push service's Topic for a session's pushes: one it still holds for a phone
// that is offline is replaced by the next (RFC 8030 §5.4). At most 32 characters of
// the base64url alphabet, which an instance id isn't guaranteed to be.
export function topicOf(instanceId: string): string {
  return crypto.createHash("sha256").update(instanceId).digest("base64url").slice(0, 32);
}

const authorizations = new Map<string, { header: string; at: number }>();

// The `Authorization: vapid t=<JWT>, k=<public key>` header for one push service,
// reused for JWT_REUSE_MS. Keyed on everything signed into it, so a new subject (the
// origin moved) or a new keypair signs afresh.
function authorization(endpoint: string, subject: string, keys: VapidKeys): string {
  const audience = new URL(endpoint).origin;
  const key = `${audience} ${subject} ${keys.publicKey}`;
  const cached = authorizations.get(key);
  if (cached && Date.now() - cached.at < JWT_REUSE_MS) return cached.header;
  const { Authorization } = webpush.getVapidHeaders(audience, subject, keys.publicKey, keys.privateKey, "aes128gcm");
  authorizations.set(key, { header: Authorization, at: Date.now() });
  return Authorization;
}

// Send one push, encrypted to `subscription`. Never rejects: every failure comes
// back as a result, so nothing reaches the activity path that raised it.
// `subject` is the VAPID JWT's contact, the phone app's HTTPS origin: Apple rejects a
// `.local` or `localhost` one (BadJwtToken), and that origin is the one name this Mac
// has that it doesn't.
export async function sendPush(
  subscription: RemotePushSubscription,
  payload: string,
  options: { keys: VapidKeys; subject: string; topic?: string }
): Promise<PushResult> {
  let audience = "";
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const agent = new https.Agent();
  try {
    audience = new URL(subscription.endpoint).origin;
    const sent = webpush.sendNotification(subscription, payload, {
      TTL: TTL_SECONDS,
      urgency: "high",
      timeout: SEND_TIMEOUT_MS,
      agent,
      ...(options.topic ? { topic: options.topic } : {}),
      // Signed here rather than by web-push (`vapidDetails`), to reuse it; see
      // JWT_REUSE_MS.
      headers: { Authorization: authorization(subscription.endpoint, options.subject, options.keys) },
    });
    const late = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        agent.destroy();
        reject(new Error("No answer from the push service"));
      }, SEND_DEADLINE_MS);
      deadline.unref?.();
    });
    await Promise.race([sent, late]);
    return { ok: true };
  } catch (err) {
    if (err instanceof webpush.WebPushError) {
      const status = err.statusCode;
      const reason = reasonOf(err.body);
      debugTrace(`[push] ${audience} refused: ${status} ${reason}`);
      if (status === 404 || status === 410) return { ok: false, gone: true };
      // A refused token (BadJwtToken, VapidPkHashMismatch) is signed afresh next time.
      if (status === 403) {
        for (const key of authorizations.keys()) if (key.startsWith(`${audience} `)) authorizations.delete(key);
      }
      return { ok: false, gone: false, error: `The push service refused it: ${status}${reason ? ` ${reason}` : ""}` };
    }
    const message = (err as Error)?.message ?? String(err);
    debugTrace(`[push] ${audience || "(bad endpoint)"} failed: ${message}`);
    return { ok: false, gone: false, error: `Couldn't send it: ${message}` };
  } finally {
    clearTimeout(deadline);
    // Its one connection, done with: nothing else sends through this agent.
    agent.destroy();
  }
}

// Apple answers a refusal with `{"reason": "BadJwtToken"}`; other services with text,
// or nothing.
function reasonOf(body: unknown): string {
  if (typeof body !== "string" || !body) return "";
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed?.reason === "string") return parsed.reason;
  } catch {
    // Not JSON.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 80);
}
