// The MCP server the manager agent connects to.
//
// Hand-rolled rather than taking @modelcontextprotocol/sdk. The SDK is 4.3MB
// across 17 direct dependencies — two HTTP frameworks (express and hono), an
// OAuth stack (jose, pkce-challenge), a JSON-schema validator, a rate limiter —
// and a tools-only server that never pushes to its client needs none of it. What
// the Streamable HTTP spec actually requires of such a server is small: one
// endpoint, four JSON-RPC methods, and plain JSON responses. Specifically, the
// spec lets a server answer GET with 405 (no server-initiated SSE), makes
// Mcp-Session-Id a MAY, and allows a POST response to be `application/json`
// rather than an SSE stream.
//
// Bound to 127.0.0.1 on an ephemeral port. Deliberately NOT port 6768: that one
// binds 0.0.0.0 and is reachable over Tailscale for the phone, while these tools
// drive work in every repository the user has open. An exposed port here would
// let anything that can reach the machine dispatch tasks to every session.

import http from "http";
import crypto from "crypto";
import { managerActivityLog } from "./activity-log";
import { recordHookDelivery } from "./hook-activity";
import type { HookDelivery } from "./hook-activity";

// Advertised in the initialize result. A client that asked for a different
// revision still gets this one and decides for itself whether it can proceed —
// that is what the spec's version negotiation says to do.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

// Revisions this server will accept in an MCP-Protocol-Version header. Anything
// else must be answered with 400 per the spec.
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

// The spec: a server that receives no MCP-Protocol-Version header "SHOULD assume
// protocol version 2025-03-26", for clients written against the older revision.
const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

// Request bodies here are JSON-RPC messages, never payloads. Anything bigger is
// a mistake or an attack, and reading it would only waste memory.
const MAX_BODY_BYTES = 1_000_000;

// JSON-RPC 2.0 error codes. METHOD_NOT_FOUND is for an unknown JSON-RPC method;
// an unknown *tool* is INVALID_PARAMS, because tools/call itself exists and it is
// `params.name` that's wrong. The MCP tools spec uses -32602 in exactly that
// example.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema for the tool's arguments, handed to the client verbatim.
  inputSchema: Record<string, unknown>;
  // Returns the text the model sees. Throwing is the way to report a tool
  // failure: the server converts it into an MCP result with isError set, which
  // is what lets the model read the reason and react, rather than a transport
  // error it can only fail on. Tool authors never touch the protocol.
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface McpServerInfo {
  running: boolean;
  port: number | null;
  endpoint: string | null;
  toolNames: string[];
  error?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class ManagerMcpServer {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private startError: string | undefined;
  private tools = new Map<string, ToolDefinition>();
  private readonly startedAt = Date.now();

  // Tools are registered by the wiring layer (index.ts) rather than declared
  // here, so this module stays free of any dependency on process-manager.
  registerTool(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) {
      throw new Error(`MCP tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  getToken(): string | null {
    return this.token;
  }

  getEndpoint(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}/mcp`;
  }

  getInfo(): McpServerInfo {
    return {
      running: this.isRunning(),
      port: this.port,
      endpoint: this.getEndpoint(),
      toolNames: [...this.tools.keys()],
      error: this.startError,
    };
  }

  // Starts on 127.0.0.1 with an OS-assigned port. Resolves with the info even on
  // failure — a manager that can't reach its tools should be reported in the UI,
  // not thrown from app startup where nothing exists yet to show the error.
  async start(): Promise<McpServerInfo> {
    if (this.httpServer) return this.getInfo();

    this.startError = undefined;
    this.token = crypto.randomBytes(32).toString("base64url");

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
      this.token = null;
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
    this.token = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    // The spec requires validating Origin to prevent DNS rebinding: a page in
    // the user's browser could otherwise POST to this port. Non-browser clients
    // (the CLI) send no Origin at all, which is why absence is allowed and only
    // a present-but-foreign value is rejected.
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && !isLocalOrigin(origin)) {
      res.writeHead(403).end();
      return;
    }

    if (!this.isAuthorized(req)) {
      // No WWW-Authenticate challenge: this isn't a resource a user agent should
      // prompt for, and advertising the scheme only helps someone probing.
      res.writeHead(401).end();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Not an MCP endpoint: the manager's CLI reporting a tool it ran itself. Kept
    // on this server because it needs exactly the same protection as the tools —
    // loopback bind and the same bearer token — and standing up a second listener
    // would mean a second thing to secure. Handled before the MCP-Protocol-Version
    // check below, which has nothing to say about it.
    if (pathname === "/hook") {
      await this.handleHook(req, res);
      return;
    }

    if (pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const version = req.headers["mcp-protocol-version"];
    const claimed = typeof version === "string" ? version : undefined;
    if (claimed !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.has(claimed)) {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: `Unsupported MCP-Protocol-Version: ${claimed}`,
          supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        })
      );
      return;
    }

    // GET is where a client asks for a server-initiated SSE stream. This server
    // never pushes — every tool answers inline — and the spec permits 405 for
    // exactly that case. Same for DELETE, which only exists to end a session,
    // and this server keeps none.
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      res.writeHead((err as Error).message === "too-large" ? 413 : 400).end();
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      sendJson(res, 400, errorResponse(null, PARSE_ERROR, "Parse error"));
      return;
    }
    if (typeof message !== "object" || message === null) {
      sendJson(res, 400, errorResponse(null, INVALID_REQUEST, "Invalid Request"));
      return;
    }

    // A message with no id is a notification (or a response to us, which we
    // never solicit). The spec: accept it with 202 and no body.
    const isNotification = message.id === undefined || message.id === null;
    if (isNotification) {
      res.writeHead(202).end();
      return;
    }

    const response = await this.dispatch(message);
    sendJson(res, 200, response);
  }

  // The manager's own Bash/Edit/Write, reported by a hook in its CLI. See
  // hook-activity.ts for what is recorded and why reads are left out.
  //
  // Always answers 204 once it has a body, whatever the content turns out to be.
  // The hook is fire-and-forget on the CLI's side and a non-2xx would only make
  // curl noisy; nothing the manager does should depend on this succeeding.
  private async handleHook(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      // A delivery too large to accept is still a call worth showing: a manager
      // writing a megabyte into someone's repo is precisely the event this feed
      // exists for, and silence would be the worst of the three outcomes.
      if ((err as Error).message === "too-large") {
        managerActivityLog.startSelf(
          `oversize-${Date.now()}`,
          "(unreported tool)",
          {
            payload:
              "The manager ran a tool whose hook report was too large to record. The call itself was not affected.",
          }
        );
        res.writeHead(413).end();
        return;
      }
      res.writeHead(400).end();
      return;
    }

    try {
      recordHookDelivery(JSON.parse(raw) as HookDelivery);
    } catch {
      // Malformed JSON from our own hook command means the command is wrong, not
      // that the manager did anything unusual. Nothing to record.
      res.writeHead(400).end();
      return;
    }
    res.writeHead(204).end();
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const expected = this.token;
    if (!expected) return false;
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return false;
    return timingSafeEqualString(header.slice(prefix.length), expected);
  }

  private async dispatch(message: JsonRpcMessage): Promise<object> {
    const id = message.id ?? null;

    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            // listChanged false because tools are registered once at startup.
            // Claiming true would oblige us to emit notifications, which needs
            // the SSE stream this server deliberately doesn't have.
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "multi-code-manager", version: "1" },
          },
        };

      // Not in the tools spec page but part of the base protocol, and clients
      // use it as a liveness check. Answering an empty result is the whole
      // contract; leaving it to fall through to METHOD_NOT_FOUND would make a
      // healthy server look broken.
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [...this.tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case "tools/call":
        return this.callTool(id, message.params);

      default:
        return errorResponse(
          id,
          METHOD_NOT_FOUND,
          `Method not found: ${String(message.method)}`
        );
    }
  }

  // Also the single choke point where the activity feed is recorded. Every call
  // travels through here — reads, writes, refusals, and anything a later task
  // registers — so logging here means no tool can be added that dispatches work
  // invisibly, which is the condition the manager was given its autonomy under.
  private async callTool(
    id: string | number | null,
    params: Record<string, unknown> | undefined
  ): Promise<object> {
    const name = typeof params?.name === "string" ? params.name : "";
    const args =
      typeof params?.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};

    const logId = managerActivityLog.start(name || "(no tool name)", args);

    const tool = this.tools.get(name);
    if (!tool) {
      // Name the tools that do exist. The manager reaching for a tool it doesn't
      // have is usually a stale idea of what's registered, and a bare "unknown"
      // leaves it guessing.
      const known = [...this.tools.keys()].join(", ") || "(none)";
      const message = `Unknown tool: ${name}. Available: ${known}`;
      managerActivityLog.finish(logId, { ok: false, text: message });
      return errorResponse(id, INVALID_PARAMS, message);
    }

    try {
      const text = await tool.handler(args);
      managerActivityLog.finish(logId, { ok: true, text });
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError: false },
      };
    } catch (err) {
      // A thrown handler is a tool failure, not a transport failure, so it comes
      // back as a result with isError. The model reads the reason and can act on
      // it — a JSON-RPC error would just be an opaque failure. This is the path
      // every refusal in the later write tools travels.
      const reason = err instanceof Error ? err.message : String(err);
      managerActivityLog.finish(logId, { ok: false, text: reason });
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: reason }], isError: true },
      };
    }
  }

  // Exposed for the health tool so it doesn't need its own clock.
  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  toolCount(): number {
    return this.tools.size;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string
) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res: http.ServerResponse, status: number, body: object) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    // charset is not optional in practice. JSON defaults to UTF-8 per RFC 8259,
    // but HTTP/1.1's own default for text is ISO-8859-1, and a client taking that
    // path renders every non-ASCII byte as mojibake. Observed 2026-09-15: an
    // OpenCode transcript containing Chinese arrived at the manager as
    // "ÈáçÊñ∞ËØªÂèñ" — the exact mac-roman reading of correct UTF-8 bytes — which
    // made reading any non-English session useless.
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
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

export const managerMcpServer = new ManagerMcpServer();
export const MCP_ASSUMED_PROTOCOL_VERSION = ASSUMED_PROTOCOL_VERSION;
