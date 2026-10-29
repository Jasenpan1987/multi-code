// The pairing link Safari copies for the Home Screen app (G-306): the desktop's own
// encoding, so the paste field and a scanned code read it alike.

import { describe, expect, it } from "vitest";
import type { PairingOffer } from "../shared/remote-protocol";
import { offerFromText, pairingLink, storedPairing } from "./pairing";

const offer: PairingOffer = {
  v: 3,
  origin: "https://mac.tailnet.ts.net",
  hostPublicKey: "host/key+=",
  deviceToken: "token",
  hostName: "Multi-Code on 潘的 MacBook Air",
};

describe("pairingLink", () => {
  it("rebuilds the link the desktop's QR encodes, and reads back as the same offer", () => {
    const link = pairingLink(storedPairing(offer));
    // As ipc-handlers.ts and the harness write it.
    expect(link).toBe(`${offer.origin}/#pair=${Buffer.from(JSON.stringify(offer), "utf8").toString("base64url")}`);
    expect(offerFromText(link)).toEqual(offer);
  });
});
