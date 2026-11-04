// A minimal phone for the harness and its test: pairs from a `#pair=` URL, does
// the handshake (pinning the desktop's key from the offer), seals every frame and
// authenticates. Run directly, it prints the sessions of every scenario:
//   node scripts/mobile-harness/client.ts '<phone url>' --control <control url>

import nacl from "tweetnacl";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import type { AuthOkFrame, ClientFrame, PairingOffer, ServerFrame } from "../../src/shared/remote-protocol";

type Frame<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

// How long pairing, the handshake and auth may take before the connect fails.
const CONNECT_TIMEOUT_MS = 5000;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export class HarnessClient {
  readonly offer: PairingOffer;
  // Resolves with the close code once the socket is gone.
  readonly closed: Promise<number>;
  authOk: AuthOkFrame | null = null;
  private socket: WebSocket;
  private keys = nacl.box.keyPair();
  private shared: Uint8Array | null = null;
  private frames: ServerFrame[] = [];
  private wake: (() => void) | null = null;

  // Fails, with the socket closed, when the desktop refuses or doesn't answer.
  static async connect(pairUrl: string, deviceName = "harness client"): Promise<HarnessClient> {
    const client = new HarnessClient(pairUrl);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.open(deviceName),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out connecting")), CONNECT_TIMEOUT_MS);
        }),
      ]);
      return client;
    } catch (err) {
      client.socket.terminate();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private constructor(pairUrl: string) {
    const code = new URL(pairUrl).hash.replace(/^#pair=/, "");
    this.offer = JSON.parse(Buffer.from(code, "base64url").toString("utf8")) as PairingOffer;
    this.socket = new WebSocket(this.offer.origin.replace(/^http/, "ws"));
    this.closed = new Promise((resolve) => this.socket.once("close", (code) => resolve(code)));
  }

  private async open(deviceName: string) {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
    const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      this.socket.once("close", () => reject(new Error("closed during the handshake")));
    });
    this.socket.send(
      JSON.stringify({ type: "client-hello", v: this.offer.v, clientPublicKey: b64(this.keys.publicKey) })
    );
    const server = await hello;
    if (server.type !== "server-hello") throw new Error(`handshake refused: ${JSON.stringify(server)}`);
    if (server.hostPublicKey !== this.offer.hostPublicKey) throw new Error("the desktop's key isn't the paired one");
    this.shared = nacl.box.before(bytes(this.offer.hostPublicKey), this.keys.secretKey);
    this.socket.on("message", (raw) => this.receive(raw.toString()));

    this.send({ type: "auth", deviceToken: this.offer.deviceToken, deviceName });
    this.authOk = await Promise.race([
      this.next("auth-ok"),
      this.closed.then((code) => Promise.reject(new Error(`auth refused: the socket closed (${code})`))),
    ]);
  }

  send(frame: ClientFrame) {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const body = nacl.box.after(new Uint8Array(Buffer.from(JSON.stringify(frame), "utf8")), nonce, this.shared!);
    this.socket.send(JSON.stringify({ type: "sealed", nonce: b64(nonce), body: b64(body) }));
  }

  // The next frame of `type` that passes `where`, skipping (and dropping) any
  // other frame received before it.
  async next<T extends ServerFrame["type"]>(
    type: T,
    where: (frame: Frame<T>) => boolean = () => true,
    timeoutMs = 3000
  ): Promise<Frame<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let frame = this.frames.shift(); frame; frame = this.frames.shift()) {
        if (frame.type === type && where(frame as Frame<T>)) return frame as Frame<T>;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  // Forget whatever has arrived, so the next `next` waits for something new.
  drain() {
    this.frames.length = 0;
  }

  close() {
    this.socket.close();
  }

  private receive(text: string) {
    const envelope = JSON.parse(text) as { type: string; nonce: string; body: string };
    if (envelope.type !== "sealed") return;
    const opened = nacl.box.open.after(bytes(envelope.body), bytes(envelope.nonce), this.shared!);
    if (!opened) return;
    this.frames.push(JSON.parse(Buffer.from(opened).toString("utf8")) as ServerFrame);
    this.wake?.();
    this.wake = null;
  }
}

async function printScenarios(pairUrl: string, control: string | undefined) {
  const client = await HarnessClient.connect(pairUrl);
  console.log(`auth-ok from "${client.authOk?.hostName}", VAPID key ${client.authOk?.vapidPublicKey ? "set" : "missing"}`);
  const print = (name: string, instances: Frame<"instances">["instances"]) => {
    console.log(`\n${name}: ${instances.length} sessions`);
    for (const i of instances) {
      console.log(`  ${i.state.padEnd(9)} ${i.backend.padEnd(8)} ${i.status.padEnd(7)} ${i.name.padEnd(20)} ${i.preview ?? ""}`);
    }
  };
  // The list the desktop sends after auth-ok, consumed first so a scenario's list
  // can't be mistaken for it.
  const initial = await client.next("instances");
  if (!control) {
    print("current scenario", initial.instances);
  } else {
    const { scenarios } = (await (await fetch(`${control}/state`)).json()) as { scenarios: string[] };
    for (const name of scenarios) {
      client.drain();
      await fetch(`${control}/scenario/${name}?live=0`, { method: "POST" });
      print(name, (await client.next("instances")).instances);
    }
  }
  client.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--control");
  const control = at >= 0 ? args[at + 1] : undefined;
  const pairUrl = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!pairUrl) {
    console.error("usage: node scripts/mobile-harness/client.ts '<phone url>' [--control <control url>]");
    process.exit(2);
  }
  printScenarios(pairUrl, control).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
