// The harness's control channel: plain HTTP on 127.0.0.1, so a shell (curl) or a
// Playwright script can switch scenario, break the connection in the ways a phone
// meets, and read back exactly what the phone sent.

import http from "node:http";
import type { Bridge } from "./bridge.ts";
import { SCENARIOS, isScenario } from "./scenarios.ts";
import type { World } from "./world.ts";

// A terminal the harness can paint: room for its boxes, and no bigger than a
// desktop window gets.
const COLS = { min: 40, max: 400 };
const ROWS = { min: 10, max: 200 };

const HELP = `Multi-Code phone harness, control channel

  GET  /                       this text
  GET  /state                  scenario, live, sessions and sockets (JSON)
  GET  /pair                   the phone URL, with its #pair= offer (JSON)
  GET  /log                    what phones sent: prompt, answer, interrupt,
                               push-subscribe, input, and each ack (JSON)
  POST /log/clear
  POST /scenario/<name>        start a scenario over; ?live=0 freezes it
                               (${SCENARIOS.join(", ")})
  POST /pause | /resume        stop / restart the working turns' clock
  POST /tick                   one step of every working turn
  POST /desk-answer/<id>       the builder answers the dialog at the desk
                               (its first option)
  POST /resize/<id>?cols=&rows=  the desktop resized that terminal
  POST /drop                   cut every socket, as a lost network does
  POST /half-open              the open sockets go quiet, pings included
  POST /offline | /online      stop / restart the server, on the same port
`;

export function startControl(world: World, bridge: Bridge, port: number) {
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      const text = typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`;
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" });
      res.end(text);
    };
    // A command that throws answers 500: in Electron's main process an uncaught
    // exception is a dialog on the builder's screen.
    try {
      route(req, reply);
    } catch (err) {
      reply(500, { ok: false, error: (err as Error).message });
    }
  });

  function route(req: http.IncomingMessage, reply: (status: number, body: unknown) => void) {
    const url = new URL(req.url ?? "/", "http://x");
    const [, command = "", arg = ""] = url.pathname.split("/");
    const done = (result: unknown = {}) => reply(200, { ok: true, ...(result as object) });
    const failed = (err: Error) => reply(500, { ok: false, error: err.message });

    if (req.method === "GET") {
      if (command === "") return reply(200, HELP);
      if (command === "state") {
        return reply(200, {
          scenario: world.scenario,
          scenarios: SCENARIOS,
          live: world.live,
          online: bridge.isOnline(),
          sessions: world.list(),
          sockets: bridge.sockets(),
        });
      }
      if (command === "pair") {
        const pairUrl = bridge.pairingUrl();
        return reply(200, { url: pairUrl, origin: new URL(pairUrl).origin });
      }
      if (command === "log") return reply(200, bridge.log);
      return reply(404, { ok: false, error: `no GET /${command}; GET / lists the commands` });
    }
    if (req.method !== "POST") return reply(405, { ok: false, error: "GET or POST" });

    switch (command) {
      case "log":
        if (arg !== "clear") break;
        bridge.log.length = 0;
        return done();
      case "scenario":
        if (!isScenario(arg)) {
          return reply(400, { ok: false, error: `unknown scenario "${arg}"`, scenarios: SCENARIOS });
        }
        world.reset(arg, url.searchParams.get("live") !== "0");
        return done({ scenario: arg, live: world.live });
      case "pause":
        world.setLive(false);
        return done();
      case "resume":
        world.setLive(true);
        return done();
      case "tick":
        world.tick();
        return done();
      case "desk-answer":
        return world.deskAnswer(arg) ? done() : reply(404, { ok: false, error: `${arg} has no dialog open` });
      case "resize": {
        const cols = Number(url.searchParams.get("cols"));
        const rows = Number(url.searchParams.get("rows"));
        const fits = (n: number, range: { min: number; max: number }) =>
          Number.isInteger(n) && n >= range.min && n <= range.max;
        if (!fits(cols, COLS) || !fits(rows, ROWS)) {
          return reply(400, {
            ok: false,
            error: `?cols= takes ${COLS.min}–${COLS.max} and ?rows= ${ROWS.min}–${ROWS.max}, whole numbers`,
          });
        }
        return bridge.resize(arg, cols, rows) ? done() : reply(404, { ok: false, error: `no session ${arg}` });
      }
      case "drop":
        return done({ dropped: bridge.drop() });
      case "half-open":
        return done({ silenced: bridge.halfOpen() });
      case "offline":
        return void bridge.offline().then(() => done(), failed);
      case "online":
        return void bridge.online().then(() => done(), failed);
    }
    reply(404, { ok: false, error: `no POST /${url.pathname.slice(1)}; GET / lists the commands` });
  }

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
