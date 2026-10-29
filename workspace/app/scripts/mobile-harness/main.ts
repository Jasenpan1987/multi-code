// Phone dev harness: the real RemoteServer, compiled (dist/main), serving the built
// phone app (dist/renderer-mobile) with scripted sessions instead of agents, so a
// phone screen can be built and screenshotted without the desktop. Electron runs
// it because ws-server.ts imports electron's `app`; Electron's Node strips the
// types, so there is no build step of its own. See README.md:
//   pnpm harness [--scenario <name>] [--paused] [--port <n>] [--control-port <n>]

import { app } from "electron";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attach } from "./bridge.ts";
import { startControl } from "./control.ts";
import { isScenario, SCENARIOS } from "./scenarios.ts";
import { World } from "./world.ts";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const dist = (file: string) => path.join(APP_DIR, "dist", file);

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// The path with every symlink resolved, for the part of it that exists yet.
function real(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(real(parent), path.basename(abs));
}

function fail(message: string) {
  console.error(`mobile harness: ${message}`);
  app.exit(1);
}

// Never the builder's real userData: the server writes its keys and paired devices
// there. Resolved through symlinks, so a /tmp link to it doesn't pass; checked
// before the app is ready, so a refused run stops before Chromium uses the folder.
// /tmp only, not os.tmpdir(): that is whatever TMPDIR says, which could be anywhere.
const userData = real(app.getPath("userData"));
const temp = path.join(real("/tmp"), "/");
const isolated = process.argv.some((a) => a.startsWith("--user-data-dir=")) && userData.startsWith(temp);

async function main() {
  for (const file of ["main/remote/ws-server.js", "main/secretary/dialog.js", "renderer-mobile/index.html"]) {
    if (!fs.existsSync(dist(file))) return fail(`dist/${file} is missing: run pnpm build:main && pnpm build:mobile`);
  }
  const scenario = option("scenario") ?? "home";
  if (!isScenario(scenario)) return fail(`unknown scenario "${scenario}"; one of ${SCENARIOS.join(", ")}`);

  const require = createRequire(import.meta.url);
  const { remoteServer } = require(dist("main/remote/ws-server.js")) as typeof import("../../src/main/remote/ws-server");
  const { checkChoice } = require(dist("main/secretary/dialog.js")) as typeof import("../../src/main/secretary/dialog");

  const world = new World(scenario, !process.argv.includes("--paused"));
  const bridge = attach(remoteServer, world, checkChoice, {
    hostName: option("host-name") ?? "MacBook Air",
    print: (line) => console.log(`  ${line}`),
  });
  await bridge.start(Number(option("port") ?? 0));
  const control = await startControl(world, bridge, Number(option("control-port") ?? 0));

  const quit = () => void Promise.all([bridge.stop(), control.close()]).finally(() => app.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  console.log(`
Multi-Code phone harness · scenario ${scenario}${world.live ? "" : " (paused)"} · userData ${userData}
  Phone app:   ${bridge.pairingUrl()}
  Control:     ${control.url}   (curl it for the commands)
  Screenshot:  pnpm harness:shot --control ${control.url} --route '#/'
`);
}

if (!isolated) {
  fail("run it with --user-data-dir=/tmp/mc-harness-<n> (`pnpm harness` does)");
} else {
  app.dock?.hide();
  app
    .whenReady()
    .then(main)
    .catch((err: Error) => fail(err.message));
}
