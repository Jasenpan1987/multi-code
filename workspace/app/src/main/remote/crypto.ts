// NaCl box sealing for the phone link, plus the desktop's long-lived identity
// keypair.
//
// The desktop keypair is what the phone pins at pairing time, so it must
// survive restarts — it lives in the app's userData dir alongside contacts.json.
// Device tokens are plain 32-byte random secrets; they authenticate a phone but
// carry no authority beyond "this device is paired", and are revocable.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import nacl from "tweetnacl";
import { app } from "electron";

export interface HostIdentity {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyB64: string;
}

interface StoredIdentity {
  publicKey: string;
  secretKey: string;
}

function identityPath(): string {
  return path.join(app.getPath("userData"), "remote-identity.json");
}

let cached: HostIdentity | null = null;

// Load the desktop keypair, generating and persisting one on first use. The file
// is written 0600 — it is the private half of the identity a paired phone
// trusts, so it should not be world-readable even inside the user's home dir.
export function getHostIdentity(): HostIdentity {
  if (cached) return cached;

  const file = identityPath();
  try {
    if (fs.existsSync(file)) {
      const stored: StoredIdentity = JSON.parse(fs.readFileSync(file, "utf8"));
      const publicKey = Buffer.from(stored.publicKey, "base64");
      const secretKey = Buffer.from(stored.secretKey, "base64");
      if (
        publicKey.length === nacl.box.publicKeyLength &&
        secretKey.length === nacl.box.secretKeyLength
      ) {
        cached = {
          publicKey: new Uint8Array(publicKey),
          secretKey: new Uint8Array(secretKey),
          publicKeyB64: stored.publicKey,
        };
        return cached;
      }
    }
  } catch {
    // Corrupt or unreadable — fall through and mint a fresh identity. Any
    // previously paired phone will fail its pinned-key check and need to
    // re-scan, which is the correct outcome for a lost key.
  }

  const pair = nacl.box.keyPair();
  const stored: StoredIdentity = {
    publicKey: Buffer.from(pair.publicKey).toString("base64"),
    secretKey: Buffer.from(pair.secretKey).toString("base64"),
  };
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });

  cached = {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    publicKeyB64: stored.publicKey,
  };
  return cached;
}

export function mintDeviceToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// A sealed channel over one WebSocket. Created after the hello exchange, when
// both public keys are known; `nacl.box.before` precomputes the shared key so
// per-frame work is just the symmetric part.
export class SealedChannel {
  private readonly sharedKey: Uint8Array;

  constructor(clientPublicKey: Uint8Array, hostSecretKey: Uint8Array) {
    this.sharedKey = nacl.box.before(clientPublicKey, hostSecretKey);
  }

  seal(plaintext: string): { nonce: string; body: string } {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const boxed = nacl.box.after(
      new Uint8Array(Buffer.from(plaintext, "utf8")),
      nonce,
      this.sharedKey
    );
    return {
      nonce: Buffer.from(nonce).toString("base64"),
      body: Buffer.from(boxed).toString("base64"),
    };
  }

  // Returns null on any failure (bad base64, wrong key, tampered ciphertext).
  // Callers treat null as a protocol violation and close the socket rather than
  // retrying, so a wrong-key peer can't probe.
  open(nonceB64: string, bodyB64: string): string | null {
    try {
      const nonce = new Uint8Array(Buffer.from(nonceB64, "base64"));
      const boxed = new Uint8Array(Buffer.from(bodyB64, "base64"));
      if (nonce.length !== nacl.box.nonceLength) return null;
      const opened = nacl.box.open.after(boxed, nonce, this.sharedKey);
      if (!opened) return null;
      return Buffer.from(opened).toString("utf8");
    } catch {
      return null;
    }
  }
}

// Constant-time compare for device tokens, so a network attacker can't time
// their way to a valid token byte by byte.
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
