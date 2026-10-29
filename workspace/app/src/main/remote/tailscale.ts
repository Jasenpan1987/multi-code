// Whether a phone can reach this Mac (mobile-v2, PRD Stories 1 and 9): Tailscale is
// running, and `tailscale serve` fronts Multi-Code's port with HTTPS on this machine's
// tailnet name. The phone app lives at `https://<machine>.<tailnet>.ts.net`, which
// `tailscale serve` proxies to Multi-Code on 127.0.0.1; nothing else on the tailnet
// can reach that port.
//
// Tailscale's state is read through its own CLI, `tailscale status --json` and
// `tailscale serve status --json`, and changed in exactly one place: `setUpHttps`,
// which runs the serve command when the builder presses the Phone section's button.
// Nothing runs it automatically, and it refuses unless port 443 serves nothing at all,
// because the serve command replaces whatever is mounted at `/` without asking
// (`applyWebServe` in Tailscale's `cmd/tailscale/cli/serve_v2.go` checks only for TCP
// forwarding), and a serve config the builder made for something else must survive.
// The CLI has no way to make its write conditional on what was checked, so a serve
// configured by something else in the milliseconds between the check and the command
// would still be replaced; that needs a second program writing port 443 at the moment
// the builder presses the button.

import { execFile } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import type { RemoteChecks } from "../../shared/remote-protocol";
import { debugTrace } from "../debug-trace";

// Where MagicDNS and HTTPS Certificates are turned on for the tailnet.
export const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";

// Where the CLI is when it isn't on the PATH, which is always the case for an app
// started from the Dock: launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin. In order:
// the Standalone and App Store apps' "Install CLI" wrapper (and Homebrew on Intel),
// Homebrew on Apple Silicon, and the app's own binary, which acts as the CLI when it
// is given arguments. Measured 2026-10-29 on the builder's Mac (Standalone 1.98.9):
// /usr/local/bin/tailscale is a two-line sh script exec'ing the app's binary.
export const TAILSCALE_CLI_LOCATIONS = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

// `status --json` and `serve status --json` answer in well under a second; a CLI that
// takes longer is talking to a wedged daemon, and the check says so instead of waiting.
const READ_TIMEOUT_MS = 5_000;

// The serve command waits for the tailnet to grant HTTPS if it hasn't
// (`enableFeatureInteractive`), which never happens here because it only runs once
// certificates are on; the bound is for that case anyway.
const SERVE_TIMEOUT_MS = 30_000;

// More than any real status: a tailnet with hundreds of peers is a few hundred KB.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// The two checks this module owns. `push` is the Web Push keys' (T-810).
export type TailnetChecks = Pick<RemoteChecks, "tailscale" | "https">;

export const UNKNOWN_CHECKS: TailnetChecks = {
  tailscale: { state: "unknown" },
  https: { state: "unknown" },
};

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

export interface CliResult {
  ok: boolean;
  stdout: string;
  // Why it failed: the first line of stderr, a timeout, or the spawn error.
  error?: string;
}

// Runs a program with arguments and no shell. Injected in tests: no test runs the
// real CLI, the read-only commands included, so a test's outcome never depends on
// the machine's Tailscale.
export type CliRunner = (file: string, args: string[], timeoutMs: number) => Promise<CliResult>;

export const runCli: CliRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        file,
        args,
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ ok: true, stdout });
            return;
          }
          const timedOut = (err as { killed?: boolean }).killed === true;
          resolve({
            ok: false,
            stdout,
            error: timedOut
              ? `timed out after ${timeoutMs / 1000} s`
              : firstLine(stderr) || err.message,
          });
        }
      );
    } catch (err) {
      resolve({ ok: false, stdout: "", error: (err as Error).message });
      return;
    }
    // Closed at once, so a CLI that stops to ask a question reads end-of-file and
    // fails instead of waiting out the timeout for an answer nobody can type.
    child.stdin?.end();
  });

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The `tailscale` this app would run: the first executable one on the PATH, else the
// first of the usual locations. Null when there is none.
export function findTailscaleCli(
  pathEnv: string | undefined = process.env.PATH,
  locations: string[] = TAILSCALE_CLI_LOCATIONS,
  isExecutable: (file: string) => boolean = isExecutableFile
): string | null {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "tailscale");
    if (isExecutable(candidate)) return candidate;
  }
  return locations.find((file) => isExecutable(file)) ?? null;
}

// What the Phone section's button runs, as argv after the CLI's path and as the line
// the section shows before it runs. `--bg` keeps it after the command exits and across
// reboots (kb/1242); 443, so the origin needs no port.
export function serveArgs(port: number): string[] {
  return ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`];
}

export function serveCommand(port: number): string {
  return ["tailscale", ...serveArgs(port)].join(" ");
}

// ---------------------------------------------------------------------------
// Reading what the CLI reports
// ---------------------------------------------------------------------------

// The parts of `tailscale status --json` read here (`ipnstate.Status`). Measured
// 2026-10-29 against 1.98.9 while stopped: BackendState "Stopped", Self.DNSName with
// its trailing dot, CertDomains null. CertDomains lists, without trailing dots, the
// names the tailnet issues certificates for, which is none until HTTPS Certificates
// are enabled in the admin console.
interface StatusJson {
  BackendState?: string;
  TailscaleIPs?: string[] | null;
  Self?: { DNSName?: string; TailscaleIPs?: string[] | null } | null;
  CertDomains?: string[] | null;
}

// `tailscale serve status --json` prints the node's `ipn.ServeConfig` (`ipn/serve.go`):
// `{}` when nothing is served (measured), else TCP handlers keyed by port and web
// handlers keyed by "<sni name>:<port>", then by mount point. A `tailscale serve`
// running in the foreground (no --bg) keeps its config under Foreground, keyed by its
// session, for as long as that command runs.
interface TcpHandlerJson {
  HTTPS?: boolean;
  HTTP?: boolean;
  TCPForward?: string;
}

interface HttpHandlerJson {
  Path?: string;
  Proxy?: string;
  Text?: string;
  Redirect?: string;
}

interface ServeConfigJson {
  TCP?: Record<string, TcpHandlerJson | null> | null;
  Web?: Record<string, { Handlers?: Record<string, HttpHandlerJson | null> | null } | null> | null;
  AllowFunnel?: Record<string, boolean> | null;
  Foreground?: Record<string, ServeConfigJson | null> | null;
}

// This machine's tailnet name as the origin uses it: no trailing dot, lower case.
function dnsNameOf(status: StatusJson): string {
  return (status.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
}

export function tailscaleCheck(status: StatusJson): RemoteChecks["tailscale"] {
  switch (status.BackendState) {
    case "Running": {
      const ips = status.Self?.TailscaleIPs ?? status.TailscaleIPs ?? [];
      const ip = Array.isArray(ips) ? ips.find((a) => net.isIPv4(a)) : undefined;
      return { state: "running", dnsName: dnsNameOf(status), ...(ip ? { ip } : {}) };
    }
    case "Stopped":
      return { state: "stopped" };
    case "NeedsLogin":
      return { state: "stopped", detail: "Tailscale needs you to log in." };
    case "NeedsMachineAuth":
      return {
        state: "stopped",
        detail: "This Mac is waiting to be approved in the Tailscale admin console.",
      };
    case "Starting":
      return { state: "unknown", detail: "Tailscale is starting." };
    default:
      return { state: "unknown", detail: `Tailscale reports state ${status.BackendState ?? "(none)"}.` };
  }
}

export function certsEnabled(status: StatusJson, dnsName: string): boolean {
  const domains = status.CertDomains;
  return (
    Array.isArray(domains) &&
    domains.some((d) => typeof d === "string" && d.replace(/\.$/, "").toLowerCase() === dnsName)
  );
}

// A handler's Proxy target as a URL. The CLI stores what it expanded
// (`http://127.0.0.1:6768` for every way of writing it), but the field's own comment
// allows `localhost:3030` and `3030`, which older configs may hold.
function proxyUrl(proxy: string): URL | null {
  const expanded = /^\d+$/.test(proxy)
    ? `http://127.0.0.1:${proxy}`
    : proxy.includes("://")
      ? proxy
      : `http://${proxy}`;
  try {
    return new URL(expanded);
  } catch {
    return null;
  }
}

// Whether a handler proxies to this server: plain http to the loopback address it
// binds, on its port, with no path prefix. `localhost` counts: Go's dialer tries
// 127.0.0.1 when ::1 refuses.
function isOurProxy(handler: HttpHandlerJson, port: number): boolean {
  if (!handler.Proxy) return false;
  const url = proxyUrl(handler.Proxy);
  if (!url) return false;
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    Number(url.port) === port &&
    (url.pathname === "/" || url.pathname === "")
  );
}

function describeHandler(handler: HttpHandlerJson): string {
  if (handler.Proxy) return `proxies to ${handler.Proxy}`;
  if (handler.Path) return `serves files from ${handler.Path}`;
  if (handler.Redirect) return `redirects to ${handler.Redirect}`;
  if (handler.Text !== undefined) return "serves a text response";
  return "has a handler Multi-Code doesn't know";
}

function lookup<T>(map: Record<string, T> | null | undefined, key: string): T | undefined {
  if (!map) return undefined;
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === key) return v;
  return undefined;
}

// What port 443 of this machine does, from the serve config, for Multi-Code on `port`.
// Ready only when `/` of `<dnsName>:443` proxies here over HTTPS, nothing else is
// mounted beside it, and Funnel is off; missing when nothing at all is on 443; anything
// else is a conflict, described. A second mount point counts as a conflict because
// Tailscale gives it the paths under it ahead of `/`: one at `/bundle.js` or `/sw.js`
// would take the phone app's own files.
export function httpsCheck(serve: ServeConfigJson | null, dnsName: string, port: number): RemoteChecks["https"] {
  const configs = [serve, ...Object.values(serve?.Foreground ?? {})].filter(
    (c): c is ServeConfigJson => !!c && typeof c === "object"
  );
  const hostPort = `${dnsName}:443`;
  let tcp: TcpHandlerJson | undefined;
  // Mount point → handler for `<dnsName>:443`, the background config's first.
  const handlers: Record<string, HttpHandlerJson> = {};
  const otherHosts: string[] = [];
  let funnel = false;
  for (const config of configs) {
    tcp ??= config.TCP?.["443"] ?? undefined;
    for (const [mount, handler] of Object.entries(lookup(config.Web, hostPort)?.Handlers ?? {})) {
      if (handler && !(mount in handlers)) handlers[mount] = handler;
    }
    for (const key of Object.keys(config.Web ?? {})) {
      if (key.endsWith(":443") && key.toLowerCase() !== hostPort) otherHosts.push(key);
    }
    funnel ||= lookup(config.AllowFunnel, hostPort) === true;
  }

  const root = handlers["/"];
  const mounts = Object.keys(handlers);
  if (tcp?.HTTPS && root && isOurProxy(root, port)) {
    const others = mounts.filter((m) => m !== "/");
    if (others.length > 0) {
      return {
        state: "serve-conflict",
        detail: `Port 443 also serves ${others.join(", ")}, ahead of Multi-Code for those paths. See tailscale serve status.`,
      };
    }
    if (funnel) {
      return {
        state: "serve-conflict",
        detail:
          "Funnel is on for port 443, which puts Multi-Code on the public internet. " +
          "Turn Funnel off (tailscale funnel status shows it).",
      };
    }
    return { state: "ready", origin: `https://${dnsName}` };
  }

  if (!tcp && mounts.length === 0 && otherHosts.length === 0) {
    return { state: "serve-missing", command: serveCommand(port) };
  }

  let detail: string;
  if (tcp?.TCPForward) detail = `Port 443 forwards TCP to ${tcp.TCPForward}.`;
  else if (tcp && !tcp.HTTPS && tcp.HTTP) detail = "Port 443 serves plain HTTP.";
  else if (root) detail = `Port 443 ${describeHandler(root)}.`;
  else if (mounts.length > 0) detail = `Port 443 serves ${mounts.join(", ")}.`;
  else if (otherHosts.length > 0) detail = `Port 443 serves ${otherHosts.join(", ")}.`;
  else detail = "Port 443 is in use.";
  return { state: "serve-conflict", detail: `${detail} See tailscale serve status.` };
}

// The CLI's answer to a command that can't reach Tailscale at all
// (`fixTailscaledConnectError` in `cmd/tailscale/cli/cli.go`): on macOS, "failed to
// connect to local Tailscale service; is Tailscale running?", which is what a quit
// app gives. Anything else stays unknown, with what the CLI said.
function isNotRunningError(error: string | undefined): boolean {
  return /failed to connect to local tailscale/i.test(error ?? "");
}

function parseJson<T>(stdout: string): T | null | undefined {
  try {
    return JSON.parse(stdout) as T | null;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

export interface HttpsSetup {
  checks: TailnetChecks;
  // Why the serve command didn't run or didn't work. Absent when it ran and worked,
  // or when HTTPS was ready already.
  error?: string;
}

export interface RemoteChecker {
  // Never rejects: a failure is a check state with a detail.
  check(port: number): Promise<TailnetChecks>;
  // Runs the serve command for `port` when, checked again first, https is
  // `serve-missing`; then checks again.
  setUpHttps(port: number): Promise<HttpsSetup>;
}

// For a server that wasn't given a checker (tests, the phone harness): nothing is
// known, so no pairing offer is made.
export const UNCHECKED: RemoteChecker = {
  check: async () => UNKNOWN_CHECKS,
  setUpHttps: async () => ({ checks: UNKNOWN_CHECKS, error: "Tailscale isn't checked here." }),
};

// Why the serve command didn't run, by the https state found just before.
const NOT_NOW: Record<Exclude<RemoteChecks["https"]["state"], "ready">, string> = {
  "certs-off": "turn on HTTPS Certificates in the admin console first.",
  "serve-missing": "the tailscale command wasn't found.",
  "serve-conflict": "port 443 already serves something else.",
  unknown: "Tailscale isn't ready.",
};

export function createTailscaleChecker(
  deps: { run?: CliRunner; findCli?: () => string | null } = {}
): RemoteChecker {
  const run = deps.run ?? runCli;
  const findCli = deps.findCli ?? (() => findTailscaleCli());

  const inspect = async (port: number): Promise<{ checks: TailnetChecks; cli: string | null }> => {
    const cli = findCli();
    if (!cli) {
      return {
        cli,
        checks: {
          tailscale: { state: "missing", detail: "No tailscale command on the PATH or in /Applications/Tailscale.app." },
          https: { state: "unknown", detail: "Needs Tailscale." },
        },
      };
    }

    const statusRun = await run(cli, ["status", "--json"], READ_TIMEOUT_MS);
    const status = statusRun.ok ? parseJson<StatusJson>(statusRun.stdout) : undefined;
    if (!status || typeof status !== "object") {
      const notRunning = !statusRun.ok && isNotRunningError(statusRun.error);
      return {
        cli,
        checks: {
          tailscale: notRunning
            ? { state: "stopped", detail: "Tailscale isn't open." }
            : {
                state: "unknown",
                detail: statusRun.ok
                  ? "tailscale status --json printed something that isn't JSON."
                  : `tailscale status --json failed: ${statusRun.error}`,
              },
          https: { state: "unknown", detail: "Needs Tailscale running." },
        },
      };
    }

    const tailscale = tailscaleCheck(status);
    if (tailscale.state !== "running") {
      return { cli, checks: { tailscale, https: { state: "unknown", detail: "Needs Tailscale running." } } };
    }
    if (!tailscale.dnsName) {
      return {
        cli,
        checks: { tailscale, https: { state: "unknown", detail: "Tailscale gave this Mac no DNS name." } },
      };
    }
    if (!certsEnabled(status, tailscale.dnsName)) {
      return { cli, checks: { tailscale, https: { state: "certs-off", adminUrl: TAILSCALE_ADMIN_DNS_URL } } };
    }

    const serveRun = await run(cli, ["serve", "status", "--json"], READ_TIMEOUT_MS);
    const serve = serveRun.ok ? parseJson<ServeConfigJson>(serveRun.stdout) : undefined;
    if (serve === undefined || (serve !== null && typeof serve !== "object")) {
      return {
        cli,
        checks: {
          tailscale,
          https: {
            state: "unknown",
            detail: serveRun.ok
              ? "tailscale serve status --json printed something that isn't JSON."
              : `tailscale serve status --json failed: ${serveRun.error}`,
          },
        },
      };
    }
    return { cli, checks: { tailscale, https: httpsCheck(serve, tailscale.dnsName, port) } };
  };

  return {
    async check(port) {
      try {
        return (await inspect(port)).checks;
      } catch (err) {
        const detail = `Checking Tailscale failed: ${(err as Error).message}`;
        return { tailscale: { state: "unknown", detail }, https: { state: "unknown", detail } };
      }
    },

    async setUpHttps(port) {
      const before = await inspect(port).catch(() => null);
      if (!before) return { checks: UNKNOWN_CHECKS, error: "Checking Tailscale failed." };
      const https = before.checks.https;
      if (https.state === "ready") return { checks: before.checks };
      if (https.state !== "serve-missing" || !before.cli) {
        return { checks: before.checks, error: `Nothing was changed: ${NOT_NOW[https.state]}` };
      }
      const args = serveArgs(port);
      const result = await run(before.cli, args, SERVE_TIMEOUT_MS);
      debugTrace(
        `[remote] ${serveCommand(port)} (${before.cli}): ${result.ok ? "ok" : `failed: ${result.error}`}`
      );
      const after = await inspect(port).catch(() => null);
      return {
        checks: after?.checks ?? UNKNOWN_CHECKS,
        ...(result.ok ? {} : { error: `tailscale serve failed: ${result.error}` }),
      };
    },
  };
}

// The Tailscale app, brought forward (or started) for the builder to switch it on.
// Called only from the Phone section's button.
export async function openTailscaleApp(run: CliRunner = runCli): Promise<{ ok: boolean; error?: string }> {
  const result = await run("/usr/bin/open", ["-a", "Tailscale"], READ_TIMEOUT_MS);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

// ---------------------------------------------------------------------------
// The checks as the Phone section sees them
// ---------------------------------------------------------------------------

// Status requests refresh at most this often...
export const CHECK_MIN_INTERVAL_MS = 5_000;
// ...and the server re-checks on its own this often while it listens, so Tailscale
// stopped or serve removed shows without the section being reopened.
export const CHECK_POLL_MS = 30_000;

// The last checks, refreshed in the background so reading them costs nothing (the
// server's status is read on every connect and disconnect), with `onChange` called
// when a refresh changes them. Checks only while the server listens, and knows
// nothing otherwise: the proxy target is the port it bound.
export class ChecksCache {
  private checker: RemoteChecker = UNCHECKED;
  private value: TailnetChecks = UNKNOWN_CHECKS;
  private port: number | null = null;
  private checkedAt = 0;
  private running: Promise<void> | null = null;
  private settingUp: Promise<HttpsSetup> | null = null;
  // Bumped whenever results in flight must be dropped: on unwatch, and when the
  // serve command starts (a check that began before it would undo its result).
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onChange: () => void) {}

  setChecker(checker: RemoteChecker) {
    this.checker = checker;
  }

  current(): TailnetChecks {
    return this.value;
  }

  // The server started listening on `port`: check now, and every 30 s from here.
  watch(port: number): Promise<void> {
    this.unwatch();
    this.port = port;
    this.timer = setInterval(() => void this.refresh(true), CHECK_POLL_MS);
    // A pending check must not hold the process open at quit time.
    this.timer.unref?.();
    return this.refresh(true);
  }

  // The server stopped. The checks go back to unknown: they described the listener
  // that just closed, and a restart must not mint an offer from them before its own
  // check lands. A check or setup still running finishes on its own, and its result
  // is dropped. The server reports the stop itself, so no change is told here.
  unwatch() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.port = null;
    this.running = null;
    this.settingUp = null;
    this.value = UNKNOWN_CHECKS;
    this.generation++;
  }

  // One check at a time, at most every 5 s unless `force`.
  refresh(force = false): Promise<void> {
    if (this.port === null) return Promise.resolve();
    if (this.settingUp) return this.settingUp.then(() => undefined);
    if (this.running) return this.running;
    if (!force && Date.now() - this.checkedAt < CHECK_MIN_INTERVAL_MS) return Promise.resolve();

    const generation = this.generation;
    this.checkedAt = Date.now();
    const run: Promise<void> = this.checker
      .check(this.port)
      .catch((err: Error) => {
        const detail = `Checking Tailscale failed: ${err?.message}`;
        return { tailscale: { state: "unknown", detail }, https: { state: "unknown", detail } } as TailnetChecks;
      })
      .then((checks) => {
        this.store(generation, checks);
      })
      .finally(() => {
        if (this.running === run) this.running = null;
      });
    this.running = run;
    return run;
  }

  // The Phone section's button. A second press while it runs gets the same result.
  setUpHttps(): Promise<HttpsSetup> {
    if (this.port === null) {
      return Promise.resolve({ checks: this.value, error: "Turn the phone link on first." });
    }
    if (!this.settingUp) {
      const port = this.port;
      const generation = ++this.generation;
      this.running = null;
      const setup: Promise<HttpsSetup> = this.checker
        .setUpHttps(port)
        .catch((err: Error) => ({ checks: this.value, error: `Setting up HTTPS failed: ${err?.message}` }))
        .then((result) => {
          if (this.store(generation, result.checks)) this.checkedAt = Date.now();
          return result;
        })
        .finally(() => {
          if (this.settingUp === setup) this.settingUp = null;
        });
      this.settingUp = setup;
    }
    return this.settingUp;
  }

  // False when the result is from before an unwatch or a setup, and was dropped.
  private store(generation: number, checks: TailnetChecks): boolean {
    if (generation !== this.generation) return false;
    const changed = JSON.stringify(checks) !== JSON.stringify(this.value);
    this.value = checks;
    if (changed) this.onChange();
    return true;
  }
}
