import { describe, expect, it, vi } from "vitest";

// getHostIdentity touches electron's app.getPath, which doesn't exist outside a
// running Electron process. Only SealedChannel/tokensMatch are under test here,
// so stub the module rather than pulling in Electron.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/multicode-test" },
}));

const { SealedChannel, tokensMatch } = await import("./crypto");
const nacl = (await import("tweetnacl")).default;

function pair() {
  const host = nacl.box.keyPair();
  const client = nacl.box.keyPair();
  return {
    host,
    client,
    // Two views of the same channel: what the desktop uses, and what the phone
    // uses. They must interoperate in both directions.
    desktop: new SealedChannel(client.publicKey, host.secretKey),
    phone: new SealedChannel(host.publicKey, client.secretKey),
  };
}

describe("SealedChannel", () => {
  it("round-trips a message between the two sides", () => {
    const { desktop, phone } = pair();
    const sealed = desktop.seal(JSON.stringify({ type: "auth-ok" }));
    expect(phone.open(sealed.nonce, sealed.body)).toBe('{"type":"auth-ok"}');
  });

  it("round-trips in the phone -> desktop direction too", () => {
    const { desktop, phone } = pair();
    const sealed = phone.seal("hello desktop");
    expect(desktop.open(sealed.nonce, sealed.body)).toBe("hello desktop");
  });

  it("preserves multi-byte characters", () => {
    // Terminal output and prompts routinely carry non-ASCII; a byte-length bug
    // here would corrupt them.
    const { desktop, phone } = pair();
    const text = "分支 ✓ café — ✅";
    const sealed = desktop.seal(text);
    expect(phone.open(sealed.nonce, sealed.body)).toBe(text);
  });

  it("uses a fresh nonce per message", () => {
    const { desktop } = pair();
    const a = desktop.seal("same");
    const b = desktop.seal("same");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.body).not.toBe(b.body);
  });

  it("rejects a ciphertext sealed for a different key", () => {
    const a = pair();
    const b = pair();
    const sealed = a.desktop.seal("secret");
    expect(b.phone.open(sealed.nonce, sealed.body)).toBeNull();
  });

  it("rejects tampered ciphertext", () => {
    const { desktop, phone } = pair();
    const sealed = desktop.seal("secret");
    const raw = Buffer.from(sealed.body, "base64");
    raw[0] ^= 0xff;
    expect(phone.open(sealed.nonce, raw.toString("base64"))).toBeNull();
  });

  it("rejects a wrong-length nonce", () => {
    const { desktop, phone } = pair();
    const sealed = desktop.seal("secret");
    expect(phone.open("AAAA", sealed.body)).toBeNull();
  });

  it("returns null rather than throwing on garbage input", () => {
    const { phone } = pair();
    expect(phone.open("!!!not base64!!!", "!!!also not!!!")).toBeNull();
  });
});

describe("tokensMatch", () => {
  it("accepts identical tokens", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  it("rejects different tokens of equal length", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
  });

  it("rejects tokens of differing length without throwing", () => {
    // timingSafeEqual throws on length mismatch, so the guard has to come first.
    expect(tokensMatch("short", "a-much-longer-token")).toBe(false);
  });

  it("rejects an empty candidate", () => {
    expect(tokensMatch("real-token", "")).toBe(false);
  });
});
