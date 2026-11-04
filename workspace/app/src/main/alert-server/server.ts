// The local endpoint every session's alert hooks (Claude) and TUI plugin (OpenCode)
// report their state to: `/alert` (docs/specs/attention-alerts/prd.md).
//
// Bound to 127.0.0.1 on an ephemeral port. Deliberately NOT the phone link's port,
// which tailscale serve exposes to the tailnet: a delivery here lights up a contact
// and can raise a dialog card on the phone, so only the user's own processes may
// send one. Every delivery carries a token minted per run.
//
// It runs for the app's whole lifetime: a session can spawn at any moment, and its
// hooks need the port and token in the files it launches with.

import http from "http";
import crypto from "crypto";
import type { AlertDelivery } from "../backends";
import { debugTrace } from "../debug-trace";

// Request bodies here are hook deliveries, a few kilobytes. Anything bigger is a
// mistake or an attack, and reading it would only waste memory.
const MAX_BODY_BYTES = 1_000_000;

export interface AlertServerInfo {
  running: boolean;
  port: number | null;
  error?: string;
}

// Names the instance an alert delivery came from. Not a secret: the hook command
// expands it from MULTICODE_INSTANCE_ID, so it is in the hook's argv, and it only
// says which contact to light up. The token is what authenticates.
const INSTANCE_HEADER = "x-multicode-instance";
// Which spawn of that instance sent it; see SPAWN_ENV in backends/instance-env.ts.
const SPAWN_HEADER = "x-multicode-spawn";

export type AlertListener = (delivery: AlertDelivery) => void;

export class AlertServer {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private alertToken: string | null = null;
  private alertListener: AlertListener | null = null;
  private startError: string | undefined;

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  getAlertToken(): string | null {
    return this.alertToken;
  }

  getAlertEndpoint(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}/alert`;
  }

  // One listener, set by whoever routes deliveries to instances. A seam rather
  // than an import: this module must not import process-manager.
  onAlertDelivery(listener: AlertListener | null) {
    this.alertListener = listener;
  }

  getInfo(): AlertServerInfo {
    return {
      running: this.isRunning(),
      port: this.port,
      error: this.startError,
    };
  }

  // Starts on 127.0.0.1 with an OS-assigned port. Resolves with the info even on
  // failure: it runs at app startup, where nothing exists yet to show an error, and
  // sessions then spawn without alert hooks.
  async start(): Promise<AlertServerInfo> {
    if (this.httpServer) return this.getInfo();

    this.startError = undefined;
    this.alertToken = crypto.randomBytes(32).toString("base64url");

    const server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    // Registered before listen, not after, and kept for the server's whole
    // lifetime. ws-server.ts learned this the hard way: a failed bind emits
    // `error` more than once, and an unhandled 'error' on a net.Server throws,
    // which in Electron takes down the main process. Port 0 makes EADDRINUSE
    // unlikely here, but a socket error mid-life would be just as fatal.
    server.on("error", () => {});

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
    } catch (err) {
      server.close();
      this.alertToken = null;
      this.startError = (err as Error)?.message ?? "Failed to start";
      return this.getInfo();
    }

    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : null;
    this.httpServer = server;
    return this.getInfo();
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.port = null;
    this.alertToken = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    // Origin is checked to prevent DNS rebinding: a page in the user's browser
    // could otherwise POST to this port. Non-browser clients (curl in a hook, the
    // TUI plugin) send no Origin at all, which is why absence is allowed and only a
    // present-but-foreign value is rejected.
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && !isLocalOrigin(origin)) {
      res.writeHead(403).end();
      return;
    }

    let pathname: string | null;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      pathname = null;
    }

    if (pathname !== "/alert") {
      res.writeHead(404).end();
      return;
    }
    await this.handleAlert(req, res);
  }

  // A session reporting its own state through a hook (see
  // docs/specs/attention-alerts/prd.md, Story 1). The body is the CLI's hook stdin
  // JSON as is; the instance comes from a header the hook command sets.
  //
  // The 204 goes out before the listener runs: the hook is fire-and-forget on the
  // CLI's side, and nothing the listener does should hold the agent up or decide
  // what curl sees.
  private async handleAlert(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    if (!this.isAuthorized(req, this.alertToken)) {
      // No WWW-Authenticate challenge: this isn't a resource a user agent should
      // prompt for, and advertising the scheme only helps someone probing.
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const header = req.headers[INSTANCE_HEADER];
    const instanceId = typeof header === "string" ? header.trim() : "";

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      const tooLarge = (err as Error).message === "too-large";
      debugTrace(
        `[alert-hook] ${instanceId.slice(0, 8) || "-"} ${tooLarge ? "oversized" : "unreadable"} delivery dropped at ${new Date().toISOString()}`
      );
      res.writeHead(tooLarge ? 413 : 400).end();
      return;
    }

    const spawnHeader = req.headers[SPAWN_HEADER];
    const spawnId = typeof spawnHeader === "string" ? spawnHeader.trim() : "";
    const delivery = parseAlertDelivery(instanceId, raw, spawnId);
    if (!delivery) {
      debugTrace(
        `[alert-hook] ${instanceId.slice(0, 8) || "-"} malformed delivery dropped at ${new Date().toISOString()}`
      );
      res.writeHead(400).end();
      return;
    }

    res.writeHead(204).end();
    debugTrace(
      `[alert-hook] ${instanceId.slice(0, 8)} ${delivery.event} ${delivery.toolName ?? "-"} at ${new Date().toISOString()}`
    );
    try {
      this.alertListener?.(delivery);
    } catch (err) {
      // A listener bug must not take the server down with it: every other session
      // reports through this same socket.
      debugTrace(`[alert-hook] listener threw: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  private isAuthorized(
    req: http.IncomingMessage,
    expected: string | null
  ): boolean {
    if (!expected) return false;
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return false;
    return timingSafeEqualString(header.slice(prefix.length), expected);
  }
}

// The hook's stdin JSON plus the instance it came from. Null for anything that
// isn't a JSON object naming a hook event, or that names no instance: such a
// delivery can't be attributed, so it is dropped rather than guessed at.
export function parseAlertDelivery(
  instanceId: string,
  raw: string,
  spawnId = ""
): AlertDelivery | null {
  if (!instanceId) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  const event = p.hook_event_name;
  if (typeof event !== "string" || event === "") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    instanceId,
    spawnId: spawnId || undefined,
    event,
    sessionId: str(p.session_id),
    toolName: str(p.tool_name),
    toolInput: p.tool_input,
    toolUseId: str(p.tool_use_id),
    agentId: str(p.agent_id),
    payload: p,
  };
}

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        // Stop accumulating, but let the rest of the body arrive and be dropped.
        // Calling req.destroy() here resets the connection, so the caller's 413
        // never gets written and the client sees ECONNRESET instead of a status
        // it can act on.
        chunks.length = 0;
        reject(new Error("too-large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// Constant-time compare so a wrong token can't be recovered a byte at a time by
// timing the response. Length is compared first because timingSafeEqual throws
// on a mismatch, and that throw is itself observable.
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const alertServer = new AlertServer();
