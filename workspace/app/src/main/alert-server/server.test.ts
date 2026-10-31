// Drives the real AlertServer over a real socket. The interesting failures here are
// auth and bind scope: a token check that can be skipped, or a listener that
// answers from off-box, would let anything on the network light up contacts and
// raise dialog cards, and neither is visible from a unit test of the parser.

import { afterEach, describe, expect, it } from "vitest";
import net from "net";
import os from "os";
import { AlertServer } from "./server";
import type { AlertDelivery } from "../backends";

let running: AlertServer | null = null;

afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

const stop = JSON.stringify({
  session_id: "sess-1",
  hook_event_name: "Stop",
  stop_hook_active: false,
  background_tasks: [],
});

async function startAlerts(listener?: (d: AlertDelivery) => void) {
  const server = new AlertServer();
  await server.start();
  running = server;
  const alertEndpoint = server.getAlertEndpoint();
  const alertToken = server.getAlertToken();
  if (!alertEndpoint || !alertToken) throw new Error("server did not start");
  const received: AlertDelivery[] = [];
  server.onAlertDelivery(listener ?? ((d) => received.push(d)));
  return { server, alertEndpoint, alertToken, received };
}

interface PostOptions {
  instance?: string | null;
  origin?: string;
  authHeader?: string;
}

async function postAlert(
  url: string,
  token: string | null,
  body: string,
  opts: PostOptions = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = opts.authHeader ?? (token === null ? undefined : `Bearer ${token}`);
  if (auth !== undefined) headers.authorization = auth;
  const instance = opts.instance === undefined ? "inst-1234567890" : opts.instance;
  if (instance !== null) headers["x-multicode-instance"] = instance;
  if (opts.origin) headers.origin = opts.origin;
  return fetch(url, { method: "POST", headers, body });
}

describe("auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const { alertEndpoint, received } = await startAlerts();
    expect((await postAlert(alertEndpoint, null, stop)).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("rejects a wrong token", async () => {
    const { alertEndpoint, received } = await startAlerts();
    expect((await postAlert(alertEndpoint, "wrong-token", stop)).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("rejects a token of the right length but wrong bytes", async () => {
    // Guards the constant-time compare: equal lengths take the timingSafeEqual
    // path, so a bug there would only show up here and not in the case above.
    const { alertEndpoint, alertToken } = await startAlerts();
    const sameLength = "x".repeat(alertToken.length);
    expect((await postAlert(alertEndpoint, sameLength, stop)).status).toBe(401);
  });

  it("rejects a non-Bearer scheme carrying the right token", async () => {
    const { alertEndpoint, alertToken } = await startAlerts();
    const res = await postAlert(alertEndpoint, alertToken, stop, {
      authHeader: `Basic ${alertToken}`,
    });
    expect(res.status).toBe(401);
  });

  it("stops accepting the old token after a restart", async () => {
    const { server, alertToken } = await startAlerts();
    await server.stop();
    await server.start();
    const fresh = server.getAlertEndpoint();
    if (!fresh) throw new Error("did not restart");
    expect((await postAlert(fresh, alertToken, stop)).status).toBe(401);
    expect(server.getAlertToken()).not.toBe(alertToken);
  });
});

describe("bind scope", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { alertEndpoint } = await startAlerts();
    expect(alertEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/alert$/);
  });

  it("refuses a connection to the machine's LAN address", async () => {
    // The real assertion about bind scope: not that the URL says 127.0.0.1, but
    // that the socket genuinely isn't answering anywhere else. Skipped on a box
    // with no external IPv4, which is a valid CI configuration.
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!external) return;

    const { server } = await startAlerts();
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
  it("allows a localhost Origin", async () => {
    const { alertEndpoint, alertToken } = await startAlerts();
    const res = await postAlert(alertEndpoint, alertToken, stop, {
      origin: "http://localhost:5173",
    });
    expect(res.status).toBe(204);
  });

  it("rejects a foreign Origin before checking auth", async () => {
    // DNS rebinding: a page the user is browsing resolves a hostname to
    // 127.0.0.1 and POSTs here. It can't read our token, but it must not even
    // get as far as the auth check.
    const { alertEndpoint, alertToken, received } = await startAlerts();
    const res = await postAlert(alertEndpoint, alertToken, stop, {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("reports its state before and after start", async () => {
    const server = new AlertServer();
    expect(server.getInfo()).toMatchObject({ running: false, port: null });
    await server.start();
    running = server;
    expect(server.getInfo().running).toBe(true);
    expect(server.getInfo().port).toBeGreaterThan(0);
  });

  it("start is idempotent", async () => {
    const { server, alertEndpoint } = await startAlerts();
    await server.start();
    expect(server.getAlertEndpoint()).toBe(alertEndpoint);
  });

  it("clears the endpoint and token on stop", async () => {
    const { server } = await startAlerts();
    await server.stop();
    running = null;
    expect(server.isRunning()).toBe(false);
    expect(server.getAlertEndpoint()).toBeNull();
    expect(server.getAlertToken()).toBeNull();
  });
});

describe("alert endpoint", () => {
  it("delivers the parsed fields to the listener and answers 204", async () => {
    const { alertEndpoint, alertToken, received } = await startAlerts();
    const permission = JSON.stringify({
      session_id: "sess-1",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "touch a.txt" },
      agent_id: "agent-7",
    });
    const res = await postAlert(alertEndpoint, alertToken, permission);
    expect(res.status).toBe(204);
    expect(received).toEqual([
      {
        instanceId: "inst-1234567890",
        event: "PermissionRequest",
        sessionId: "sess-1",
        toolName: "Bash",
        toolInput: { command: "touch a.txt" },
        toolUseId: undefined,
        agentId: "agent-7",
        payload: JSON.parse(permission),
      },
    ]);
  });

  it("passes on which spawn sent the delivery", async () => {
    const { alertEndpoint, alertToken, received } = await startAlerts();
    await fetch(alertEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alertToken}`,
        "x-multicode-instance": "inst-1",
        "x-multicode-spawn": "spawn-abc",
      },
      body: stop,
    });
    expect(received[0].spawnId).toBe("spawn-abc");
  });

  it("keeps the whole payload, so fields like background_tasks reach the listener", async () => {
    const { alertEndpoint, alertToken, received } = await startAlerts();
    await postAlert(alertEndpoint, alertToken, stop);
    expect(received[0].event).toBe("Stop");
    expect(received[0].payload.background_tasks).toEqual([]);
  });

  it("404s any other path, with or without the token", async () => {
    const { alertEndpoint, alertToken } = await startAlerts();
    const other = alertEndpoint.replace(/\/alert$/, "/mcp");
    expect((await postAlert(other, alertToken, stop)).status).toBe(404);
    expect((await postAlert(other, null, stop)).status).toBe(404);
  });

  it("answers 400 on malformed JSON without calling the listener", async () => {
    const { alertEndpoint, alertToken, received } = await startAlerts();
    expect((await postAlert(alertEndpoint, alertToken, "{not json")).status).toBe(400);
    expect((await postAlert(alertEndpoint, alertToken, "[1,2]")).status).toBe(400);
    expect(
      (await postAlert(alertEndpoint, alertToken, JSON.stringify({ tool_name: "Bash" }))).status
    ).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("answers 400 when no instance is named, since the delivery can't be attributed", async () => {
    const { alertEndpoint, alertToken, received } = await startAlerts();
    expect((await postAlert(alertEndpoint, alertToken, stop, { instance: null })).status).toBe(400);
    expect((await postAlert(alertEndpoint, alertToken, stop, { instance: "  " })).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("413s an oversized delivery without calling the listener", async () => {
    const { alertEndpoint, alertToken, received } = await startAlerts();
    const huge = JSON.stringify({
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "x".repeat(1_200_000) },
    });
    expect((await postAlert(alertEndpoint, alertToken, huge)).status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it("405s a GET", async () => {
    const { alertEndpoint, alertToken } = await startAlerts();
    const res = await fetch(alertEndpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${alertToken}` },
    });
    expect(res.status).toBe(405);
  });

  it("still answers 204 when the listener throws, and keeps serving", async () => {
    const { alertEndpoint, alertToken } = await startAlerts(() => {
      throw new Error("listener bug");
    });
    expect((await postAlert(alertEndpoint, alertToken, stop)).status).toBe(204);
    expect((await postAlert(alertEndpoint, alertToken, stop)).status).toBe(204);
  });

  it("answers 204 with no listener registered", async () => {
    const { server, alertEndpoint, alertToken } = await startAlerts();
    server.onAlertDelivery(null);
    expect((await postAlert(alertEndpoint, alertToken, stop)).status).toBe(204);
  });

  it("does not answer once the server is stopped", async () => {
    const { server, alertEndpoint } = await startAlerts();
    await server.stop();
    running = null;
    await expect(fetch(alertEndpoint, { method: "POST", body: stop })).rejects.toThrow();
  });
});
