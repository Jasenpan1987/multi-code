// Drives the real ManagerMcpServer over a real socket. The interesting failures
// here are auth and bind scope — a token check that can be skipped, or a listener
// that answers from off-box, would hand every managed session to anything on the
// network, and neither is visible from a unit test of the dispatch switch.

import { afterEach, describe, expect, it } from "vitest";
import net from "net";
import os from "os";
import {
  ManagerMcpServer,
  MCP_PROTOCOL_VERSION,
  type ToolDefinition,
} from "./server";

let running: ManagerMcpServer | null = null;

afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

const HEALTH: ToolDefinition = {
  name: "probe",
  description: "test probe",
  inputSchema: { type: "object", properties: {} },
  handler: (args) => `probe:${JSON.stringify(args)}`,
};

async function startWith(...tools: ToolDefinition[]) {
  const server = new ManagerMcpServer();
  for (const t of tools) server.registerTool(t);
  await server.start();
  running = server;
  const endpoint = server.getEndpoint();
  const token = server.getToken();
  if (!endpoint || !token) throw new Error("server did not start");
  return { server, endpoint, token };
}

interface PostOptions {
  token?: string | null;
  origin?: string;
  protocolVersion?: string;
  rawBody?: string;
  authHeader?: string;
}

async function post(
  endpoint: string,
  token: string,
  body: unknown,
  opts: PostOptions = {}
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const auth =
    opts.authHeader ??
    (opts.token === null ? undefined : `Bearer ${opts.token ?? token}`);
  if (auth !== undefined) headers.authorization = auth;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.protocolVersion) {
    headers["mcp-protocol-version"] = opts.protocolVersion;
  }
  return fetch(endpoint, {
    method: "POST",
    headers,
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

describe("auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, { token: null });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, {
      token: "not-the-token",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token of the right length but wrong bytes", async () => {
    // Guards the constant-time compare: equal lengths take the timingSafeEqual
    // path, so a bug there would only show up here and not in the case above.
    const { endpoint, token } = await startWith(HEALTH);
    const sameLength = "x".repeat(token.length);
    const res = await post(endpoint, token, initialize, { token: sameLength });
    expect(res.status).toBe(401);
  });

  it("rejects a non-Bearer scheme carrying the right token", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, {
      authHeader: `Basic ${token}`,
    });
    expect(res.status).toBe(401);
  });

  it("accepts the minted token", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize);
    expect(res.status).toBe(200);
  });

  it("stops accepting the old token after a restart", async () => {
    const { server, endpoint, token } = await startWith(HEALTH);
    await server.stop();
    await server.start();
    const res = await post(server.getEndpoint()!, token, initialize, { token });
    expect(res.status).toBe(401);
    expect(server.getToken()).not.toBe(token);
    // endpoint from before the restart is stale too; keep the value used so the
    // assertion above is unambiguous about which token was replayed.
    expect(endpoint).toBeTruthy();
  });
});

describe("bind scope", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { endpoint } = await startWith(HEALTH);
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("refuses a connection to the machine's LAN address", async () => {
    // The real assertion about bind scope: not that the URL says 127.0.0.1, but
    // that the socket genuinely isn't answering anywhere else. Skipped on a box
    // with no external IPv4, which is a valid CI configuration.
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!external) return;

    const { server } = await startWith(HEALTH);
    const port = server.getInfo().port!;
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: external.address, port });
      const done = (v: string) => {
        socket.destroy();
        resolve(v);
      };
      socket.setTimeout(2000, () => done("timeout"));
      socket.once("connect", () => done("connected"));
      socket.once("error", () => done("refused"));
    });
    expect(outcome).not.toBe("connected");
  });
});

describe("origin validation", () => {
  it("allows a request with no Origin (a CLI, not a browser)", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize);
    expect(res.status).toBe(200);
  });

  it("allows a localhost Origin", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, {
      origin: "http://localhost:5173",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a foreign Origin before checking auth", async () => {
    // DNS rebinding: a page the user is browsing resolves a hostname to
    // 127.0.0.1 and POSTs here. It can't read our token, but it must not even
    // get as far as the auth check.
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });
});

describe("protocol version header", () => {
  it("accepts the advertised version", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, {
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    expect(res.status).toBe(200);
  });

  it("accepts an older supported version", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, {
      protocolVersion: "2025-03-26",
    });
    expect(res.status).toBe(200);
  });

  it("400s an unsupported version", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize, {
      protocolVersion: "1999-01-01",
    });
    expect(res.status).toBe(400);
  });

  it("accepts a missing version header", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, initialize);
    expect(res.status).toBe(200);
  });
});

describe("methods and routing", () => {
  it("initialize declares a tools capability and the protocol version", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const body = await (await post(endpoint, token, initialize)).json();
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.capabilities.tools).toEqual({ listChanged: false });
    expect(body.result.serverInfo.name).toBe("multi-code-manager");
    expect(body.id).toBe(1);
  });

  it("answers ping", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const body = await (
      await post(endpoint, token, { jsonrpc: "2.0", id: 7, method: "ping" })
    ).json();
    expect(body.result).toEqual({});
    expect(body.error).toBeUndefined();
  });

  it("lists registered tools with their schemas", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const body = await (
      await post(endpoint, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]).toEqual({
      name: "probe",
      description: "test probe",
      inputSchema: { type: "object", properties: {} },
    });
  });

  it("202s a notification and sends no body", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("405s GET, since this server offers no SSE stream", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
  });

  it("405s DELETE, since this server keeps no sessions", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await fetch(endpoint, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });

  it("404s a path other than /mcp", async () => {
    const { server, token } = await startWith(HEALTH);
    const port = server.getInfo().port!;
    const res = await fetch(`http://127.0.0.1:${port}/elsewhere`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns a JSON-RPC parse error for a malformed body", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, null, { rawBody: "{not json" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it("returns method-not-found for an unknown method", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const body = await (
      await post(endpoint, token, { jsonrpc: "2.0", id: 3, method: "nope" })
    ).json();
    expect(body.error.code).toBe(-32601);
  });

  it("413s a body over the size cap", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const res = await post(endpoint, token, null, {
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "ping",
        params: { pad: "x".repeat(1_100_000) },
      }),
    });
    expect(res.status).toBe(413);
  });
});

describe("tools/call", () => {
  it("passes arguments through and wraps the result as text content", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const body = await (
      await post(endpoint, token, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "probe", arguments: { alias: "msk" } },
      })
    ).json();
    expect(body.result.isError).toBe(false);
    expect(body.result.content).toEqual([
      { type: "text", text: 'probe:{"alias":"msk"}' },
    ]);
  });

  it("defaults missing arguments to an empty object", async () => {
    const { endpoint, token } = await startWith(HEALTH);
    const body = await (
      await post(endpoint, token, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "probe" },
      })
    ).json();
    expect(body.result.content[0].text).toBe("probe:{}");
  });

  it("turns a thrown handler into isError with the reason, not a transport error", async () => {
    // This is the path every refusal in the later write tools takes: the manager
    // has to be able to read why it was refused and tell the user, which it can't
    // do with a JSON-RPC error.
    const { endpoint, token } = await startWith({
      name: "refuser",
      description: "always refuses",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        throw new Error("target is waiting on a decision from you");
      },
    });
    const body = await (
      await post(endpoint, token, {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "refuser" },
      })
    ).json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(
      "target is waiting on a decision from you"
    );
  });

  it("awaits an async handler", async () => {
    const { endpoint, token } = await startWith({
      name: "slow",
      description: "async",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "done";
      },
    });
    const body = await (
      await post(endpoint, token, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "slow" },
      })
    ).json();
    expect(body.result.content[0].text).toBe("done");
  });

  it("errors on an unknown tool name and names the ones that exist", async () => {
    // -32602 (invalid params), not -32601: tools/call exists, params.name is what
    // is wrong. Matches the example in the MCP tools spec.
    const { endpoint, token } = await startWith(HEALTH);
    const body = await (
      await post(endpoint, token, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "ghost" },
      })
    ).json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("ghost");
    expect(body.error.message).toContain("probe");
  });
});

describe("registration seam", () => {
  it("refuses a duplicate tool name", () => {
    const server = new ManagerMcpServer();
    server.registerTool(HEALTH);
    expect(() => server.registerTool(HEALTH)).toThrow(/already registered/);
  });

  it("reports its tools and state before and after start", async () => {
    const server = new ManagerMcpServer();
    server.registerTool(HEALTH);
    expect(server.getInfo()).toMatchObject({
      running: false,
      port: null,
      endpoint: null,
      toolNames: ["probe"],
    });
    await server.start();
    running = server;
    expect(server.getInfo().running).toBe(true);
    expect(server.getInfo().port).toBeGreaterThan(0);
  });

  it("stop clears the port, token and endpoint", async () => {
    const { server } = await startWith(HEALTH);
    await server.stop();
    running = null;
    expect(server.isRunning()).toBe(false);
    expect(server.getToken()).toBeNull();
    expect(server.getEndpoint()).toBeNull();
  });

  it("start is idempotent", async () => {
    const { server, endpoint } = await startWith(HEALTH);
    await server.start();
    expect(server.getEndpoint()).toBe(endpoint);
  });
});
