// The Tailscale checks, against the CLI's own output. No test runs the real
// `tailscale`: every CLI call goes through a stub that answers from a fixture and
// records what it was asked, so the serve command is covered without ever touching
// the machine's Tailscale.
//
// Fixtures (__fixtures__/tailscale/):
//   status-stopped.json   recorded 2026-10-29 from `tailscale status --json` on the
//                         builder's Mac (Standalone 1.98.9, Tailscale stopped), trimmed:
//                         peers, users, keys, the account name and counters removed.
//   serve-empty.json      recorded the same day from `tailscale serve status --json`.
//   everything else       built from that recording and the documented shapes
//                         (`ipnstate.Status`, `ipn.ServeConfig` in Tailscale's source),
//                         because HTTPS can't be turned on here (the builder does that
//                         at QA): status-running* differ from the recording only in
//                         BackendState, Online, Health and CertDomains.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  CHECK_MIN_INTERVAL_MS,
  CHECK_POLL_MS,
  ChecksCache,
  TAILSCALE_ADMIN_DNS_URL,
  createTailscaleChecker,
  findTailscaleCli,
  httpsCheck,
  openTailscaleApp,
  runCli,
  serveArgs,
  serveCommand,
  type CliResult,
  type RemoteChecker,
  type TailnetChecks,
} from "./tailscale";

const FIXTURES = path.join(__dirname, "__fixtures__/tailscale");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8");

const CLI = "/usr/local/bin/tailscale";
const DNS = "jasenpanmacbook-air.taile5fb0f.ts.net";
const PORT = 6768;

interface Call {
  file: string;
  args: string[];
  timeoutMs: number;
}

// A CLI that answers `status --json` and `serve status --json` from fixtures (or
// given results) and records every call. Anything else succeeds silently, and is
// recorded, which is how the serve command is seen.
function fakeCli(answers: { status?: string | CliResult; serve?: string | CliResult | (() => string) }) {
  const calls: Call[] = [];
  const asResult = (a: string | CliResult | undefined): CliResult =>
    a === undefined ? { ok: false, stdout: "", error: "not stubbed" } : typeof a === "string" ? { ok: true, stdout: a } : a;
  const run = async (file: string, args: string[], timeoutMs: number): Promise<CliResult> => {
    calls.push({ file, args, timeoutMs });
    const line = args.join(" ");
    if (line === "status --json") return asResult(answers.status);
    if (line === "serve status --json") {
      const serve = answers.serve;
      return asResult(typeof serve === "function" ? serve() : serve);
    }
    return { ok: true, stdout: "" };
  };
  return { run, calls, lines: () => calls.map((c) => c.args.join(" ")) };
}

function checkerFor(answers: Parameters<typeof fakeCli>[0], cli: string | null = CLI) {
  const fake = fakeCli(answers);
  return { ...fake, checker: createTailscaleChecker({ run: fake.run, findCli: () => cli }) };
}

describe("findTailscaleCli", () => {
  const exists = (...files: string[]) => (file: string) => files.includes(file);

  it("prefers the PATH", () => {
    expect(findTailscaleCli("/opt/x/bin:/usr/bin", undefined, exists("/opt/x/bin/tailscale", CLI))).toBe(
      "/opt/x/bin/tailscale"
    );
  });

  it("finds the Install CLI wrapper from a Dock launch's bare PATH", () => {
    expect(findTailscaleCli("/usr/bin:/bin:/usr/sbin:/sbin", undefined, exists(CLI))).toBe(CLI);
  });

  it("falls back to the app's own binary", () => {
    const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    expect(findTailscaleCli("/usr/bin:/bin", undefined, exists(app))).toBe(app);
  });

  it("finds Homebrew's on Apple Silicon", () => {
    expect(findTailscaleCli("/usr/bin", undefined, exists("/opt/homebrew/bin/tailscale"))).toBe(
      "/opt/homebrew/bin/tailscale"
    );
  });

  it("ignores relative PATH entries and returns null when there is none", () => {
    expect(findTailscaleCli("bin:.:", undefined, exists("bin/tailscale", "tailscale"))).toBeNull();
    expect(findTailscaleCli(undefined, undefined, () => false)).toBeNull();
  });
});

describe("the serve command", () => {
  it("is the one the Phone section shows, for the server's port", () => {
    expect(serveArgs(PORT)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:6768"]);
    expect(serveCommand(PORT)).toBe("tailscale serve --bg --https=443 http://127.0.0.1:6768");
    expect(serveCommand(51234)).toBe("tailscale serve --bg --https=443 http://127.0.0.1:51234");
  });
});

describe("TailscaleChecker.check", () => {
  it("running + ready", async () => {
    const { checker, lines } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-ready") });
    expect(await checker.check(PORT)).toEqual({
      tailscale: { state: "running", dnsName: DNS, ip: "100.103.73.2" },
      https: { state: "ready", origin: `https://${DNS}` },
    });
    expect(lines()).toEqual(["status --json", "serve status --json"]);
  });

  it("stopped (recorded): HTTPS unknown, serve not read", async () => {
    const { checker, lines } = checkerFor({ status: fixture("status-stopped") });
    expect(await checker.check(PORT)).toEqual({
      tailscale: { state: "stopped" },
      https: { state: "unknown", detail: "Needs Tailscale running." },
    });
    expect(lines()).toEqual(["status --json"]);
  });

  it("logged out counts as stopped, with why", async () => {
    const { checker } = checkerFor({ status: fixture("status-needs-login") });
    const checks = await checker.check(PORT);
    expect(checks.tailscale).toEqual({ state: "stopped", detail: "Tailscale needs you to log in." });
    expect(checks.https.state).toBe("unknown");
  });

  it("the app quit: the CLI can't reach Tailscale", async () => {
    const { checker } = checkerFor({
      status: { ok: false, stdout: "", error: "failed to connect to local Tailscale service; is Tailscale running?" },
    });
    expect((await checker.check(PORT)).tailscale).toEqual({ state: "stopped", detail: "Tailscale isn't open." });
  });

  it("missing CLI: nothing is run", async () => {
    const { checker, calls } = checkerFor({}, null);
    const checks = await checker.check(PORT);
    expect(checks.tailscale.state).toBe("missing");
    expect(checks.https.state).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("certs off: the admin console, serve not read", async () => {
    const { checker, lines } = checkerFor({ status: fixture("status-running-certs-off") });
    expect((await checker.check(PORT)).https).toEqual({ state: "certs-off", adminUrl: TAILSCALE_ADMIN_DNS_URL });
    expect(TAILSCALE_ADMIN_DNS_URL).toBe("https://login.tailscale.com/admin/dns");
    expect(lines()).toEqual(["status --json"]);
  });

  it("serve missing (recorded `{}`): the command for this port", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-empty") });
    expect((await checker.check(PORT)).https).toEqual({
      state: "serve-missing",
      command: "tailscale serve --bg --https=443 http://127.0.0.1:6768",
    });
  });

  it("serve missing: a `null` config", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: "null\n" });
    expect((await checker.check(PORT)).https.state).toBe("serve-missing");
  });

  it("serve missing: Multi-Code served on another HTTPS port, 443 free", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-other-https-port") });
    expect((await checker.check(PORT)).https.state).toBe("serve-missing");
  });

  it("serve conflict: 443 proxies to another port", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-other-port") });
    expect((await checker.check(PORT)).https).toEqual({
      state: "serve-conflict",
      detail: "Port 443 proxies to http://127.0.0.1:3000. See tailscale serve status.",
    });
  });

  it("serve conflict: 443 proxies to another host", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-other-host") });
    expect((await checker.check(PORT)).https).toEqual({
      state: "serve-conflict",
      detail: "Port 443 proxies to http://192.168.0.20:6768. See tailscale serve status.",
    });
  });

  it("serve conflict: 443 forwards TCP", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-tcp-forward") });
    expect((await checker.check(PORT)).https).toEqual({
      state: "serve-conflict",
      detail: "Port 443 forwards TCP to 127.0.0.1:22. See tailscale serve status.",
    });
  });

  it("serve conflict: a foreground serve holds 443", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-foreground-other") });
    expect((await checker.check(PORT)).https.state).toBe("serve-conflict");
  });

  it("serve conflict: ours, but Funnel makes it public", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-funnel") });
    const https = (await checker.check(PORT)).https;
    expect(https.state).toBe("serve-conflict");
    expect(https.state === "serve-conflict" && https.detail).toContain("Funnel");
  });

  it("ready only for the port the server bound", async () => {
    const { checker } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-ready") });
    expect((await checker.check(51234)).https.state).toBe("serve-conflict");
  });

  it("unknown when the CLI fails or prints something else", async () => {
    const garbage = checkerFor({ status: "Tailscale is stopped.\n" });
    expect((await garbage.checker.check(PORT)).tailscale.state).toBe("unknown");

    const timeout = checkerFor({ status: { ok: false, stdout: "", error: "timed out after 5 s" } });
    expect((await timeout.checker.check(PORT)).tailscale).toEqual({
      state: "unknown",
      detail: "tailscale status --json failed: timed out after 5 s",
    });

    const serveFails = checkerFor({
      status: fixture("status-running"),
      serve: { ok: false, stdout: "", error: "permission denied" },
    });
    expect((await serveFails.checker.check(PORT)).https).toEqual({
      state: "unknown",
      detail: "tailscale serve status --json failed: permission denied",
    });
  });

  it("reads the recorded status's shape: trailing dot gone, first IPv4", async () => {
    const status = JSON.parse(fixture("status-stopped"));
    expect(status.Self.DNSName).toBe(`${DNS}.`);
    expect(status.CertDomains).toBeNull();
    const { checker } = checkerFor({
      status: JSON.stringify({ ...status, BackendState: "Running", CertDomains: [DNS] }),
      serve: fixture("serve-ready"),
    });
    expect(await checker.check(PORT)).toEqual({
      tailscale: { state: "running", dnsName: DNS, ip: "100.103.73.2" },
      https: { state: "ready", origin: `https://${DNS}` },
    });
  });
});

describe("httpsCheck proxy targets", () => {
  const withRoot = (proxy: string) => ({
    TCP: { "443": { HTTPS: true } },
    Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: proxy } } } },
  });

  it("accepts the ways the CLI and older configs write this server", () => {
    for (const proxy of ["http://127.0.0.1:6768", "http://127.0.0.1:6768/", "http://localhost:6768", "localhost:6768", "6768"]) {
      expect(httpsCheck(withRoot(proxy), DNS, PORT).state, proxy).toBe("ready");
    }
  });

  it("refuses anything that isn't plain http to this server's loopback port", () => {
    for (const proxy of ["https+insecure://127.0.0.1:6768", "http://[::1]:6768", "http://127.0.0.1:6768/app", "unix:/tmp/x.sock"]) {
      expect(httpsCheck(withRoot(proxy), DNS, PORT).state, proxy).toBe("serve-conflict");
    }
  });

  it("describes a non-proxy handler at /", () => {
    const files = {
      TCP: { "443": { HTTPS: true } },
      Web: { [`${DNS}:443`]: { Handlers: { "/": { Path: "/Users/me/site" } } } },
    };
    expect(httpsCheck(files, DNS, PORT)).toEqual({
      state: "serve-conflict",
      detail: "Port 443 serves files from /Users/me/site. See tailscale serve status.",
    });
  });

  it("another mount point beside ours is a conflict: it takes paths from the phone app", () => {
    for (const mount of ["/grafana", "/bundle.js"]) {
      const config = {
        TCP: { "443": { HTTPS: true } },
        Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:6768" }, [mount]: { Proxy: "http://127.0.0.1:3000" } } } },
      };
      expect(httpsCheck(config, DNS, PORT), mount).toEqual({
        state: "serve-conflict",
        detail: `Port 443 also serves ${mount}, ahead of Multi-Code for those paths. See tailscale serve status.`,
      });
    }
  });

  it("another name on 443 doesn't touch ours (SNI keeps them apart)", () => {
    const config = {
      TCP: { "443": { HTTPS: true } },
      Web: {
        [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:6768" } } },
        "other.taile5fb0f.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
      },
    };
    expect(httpsCheck(config, DNS, PORT).state).toBe("ready");
  });
});

describe("TailscaleChecker.setUpHttps (exec stubbed)", () => {
  it("runs exactly the shown command when serve is missing, then checks again", async () => {
    let served = false;
    const fake = fakeCli({
      status: fixture("status-running"),
      serve: () => (served ? fixture("serve-ready") : fixture("serve-empty")),
    });
    const run = async (file: string, args: string[], timeoutMs: number) => {
      const result = await fake.run(file, args, timeoutMs);
      if (args[0] === "serve" && args[1] === "--bg") served = true;
      return result;
    };
    const checker = createTailscaleChecker({ run, findCli: () => CLI });

    const result = await checker.setUpHttps(PORT);

    expect(result).toEqual({
      checks: {
        tailscale: { state: "running", dnsName: DNS, ip: "100.103.73.2" },
        https: { state: "ready", origin: `https://${DNS}` },
      },
    });
    expect(fake.lines()).toEqual([
      "status --json",
      "serve status --json",
      "serve --bg --https=443 http://127.0.0.1:6768",
      "status --json",
      "serve status --json",
    ]);
    const serve = fake.calls[2];
    expect(serve.file).toBe(CLI);
    expect(["tailscale", ...serve.args].join(" ")).toBe(serveCommand(PORT));
    expect(serve.timeoutMs).toBe(30_000);
  });

  for (const [name, status, serve] of [
    ["conflict", "status-running", "serve-other-port"],
    ["certs off", "status-running-certs-off", undefined],
    ["stopped", "status-stopped", undefined],
  ] as const) {
    it(`never runs it on ${name}`, async () => {
      const { checker, lines } = checkerFor({ status: fixture(status), serve: serve && fixture(serve) });
      const result = await checker.setUpHttps(PORT);
      expect(result.error).toMatch(/^Nothing was changed/);
      expect(lines().some((l) => l.startsWith("serve --bg"))).toBe(false);
    });
  }

  it("never runs it without a CLI", async () => {
    const { checker, calls } = checkerFor({}, null);
    expect((await checker.setUpHttps(PORT)).error).toMatch(/^Nothing was changed/);
    expect(calls).toEqual([]);
  });

  it("does nothing when HTTPS is ready already", async () => {
    const { checker, lines } = checkerFor({ status: fixture("status-running"), serve: fixture("serve-ready") });
    const result = await checker.setUpHttps(PORT);
    expect(result.error).toBeUndefined();
    expect(result.checks.https.state).toBe("ready");
    expect(lines()).toEqual(["status --json", "serve status --json"]);
  });

  it("reports a command that failed, with the checks read again", async () => {
    const fake = fakeCli({ status: fixture("status-running"), serve: fixture("serve-empty") });
    const run = async (file: string, args: string[], timeoutMs: number): Promise<CliResult> =>
      args[1] === "--bg" ? { ok: false, stdout: "", error: "serve config denied" } : fake.run(file, args, timeoutMs);
    const checker = createTailscaleChecker({ run, findCli: () => CLI });
    const result = await checker.setUpHttps(PORT);
    expect(result.error).toBe("tailscale serve failed: serve config denied");
    expect(result.checks.https.state).toBe("serve-missing");
  });
});

describe("openTailscaleApp", () => {
  it("asks macOS to open the app by name", async () => {
    const calls: Call[] = [];
    const result = await openTailscaleApp(async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { ok: true, stdout: "" };
    });
    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([["/usr/bin/open", "-a", "Tailscale"]]);
  });
});

describe("runCli", () => {
  // Harmless system programs only, never `tailscale`.
  it("returns stdout and closes stdin so nothing waits for input", async () => {
    expect(await runCli("/bin/echo", ["hello"], 5000)).toEqual({ ok: true, stdout: "hello\n" });
    // `cat` with no file reads stdin until end-of-file: it returns at once only
    // because stdin is closed.
    const started = Date.now();
    expect(await runCli("/bin/cat", [], 5000)).toEqual({ ok: true, stdout: "" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("times out and says so", async () => {
    const result = await runCli("/bin/sleep", ["5"], 200);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timed out after 0.2 s");
  });

  it("reports a missing program", async () => {
    const result = await runCli("/nonexistent/tailscale", ["status"], 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("ChecksCache", () => {
  const ready = (n: number): TailnetChecks => ({
    tailscale: { state: "running", dnsName: DNS, ip: `100.103.73.${n}` },
    https: { state: "ready", origin: `https://${DNS}` },
  });

  // A checker whose answers the test releases by hand.
  function manualChecker() {
    const pending: Array<(checks: TailnetChecks) => void> = [];
    const ports: number[] = [];
    let setups = 0;
    let setupResult: TailnetChecks = ready(9);
    const checker: RemoteChecker = {
      check: (port) => {
        ports.push(port);
        return new Promise((resolve) => pending.push(resolve));
      },
      setUpHttps: async () => {
        setups++;
        return { checks: setupResult };
      },
    };
    return {
      checker,
      ports,
      pending,
      get setups() {
        return setups;
      },
      setSetupResult(c: TailnetChecks) {
        setupResult = c;
      },
    };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks on watch, then every 30 s, and tells only of changes", async () => {
    let changes = 0;
    const cache = new ChecksCache(() => changes++);
    const answers = [ready(1), ready(1), ready(2)];
    cache.setChecker({ check: async () => answers.shift()!, setUpHttps: async () => ({ checks: ready(0) }) });

    await cache.watch(PORT);
    expect(cache.current()).toEqual(ready(1));
    expect(changes).toBe(1);

    await vi.advanceTimersByTimeAsync(CHECK_POLL_MS);
    expect(answers).toHaveLength(1);
    expect(changes).toBe(1);

    await vi.advanceTimersByTimeAsync(CHECK_POLL_MS);
    expect(cache.current()).toEqual(ready(2));
    expect(changes).toBe(2);
  });

  it("status requests refresh at most every 5 s", async () => {
    const m = manualChecker();
    const cache = new ChecksCache(() => undefined);
    cache.setChecker(m.checker);
    const watched = cache.watch(PORT);
    m.pending.shift()!(ready(1));
    await watched;

    void cache.refresh();
    expect(m.ports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CHECK_MIN_INTERVAL_MS);
    void cache.refresh();
    void cache.refresh();
    // One check at a time: the second request joins the first.
    expect(m.ports).toEqual([PORT, PORT]);
  });

  it("does nothing while not watching, and stops on unwatch", async () => {
    const m = manualChecker();
    const cache = new ChecksCache(() => undefined);
    cache.setChecker(m.checker);
    await cache.refresh(true);
    expect(m.ports).toEqual([]);

    const first = cache.watch(PORT);
    m.pending.shift()!(ready(4));
    await first;
    expect(cache.current()).toEqual(ready(4));
    // Unknown again once stopped: it described the listener that closed.
    cache.unwatch();
    expect(cache.current().tailscale.state).toBe("unknown");

    const watched = cache.watch(PORT);
    cache.unwatch();
    // The check from before unwatch lands late: dropped.
    m.pending.shift()!(ready(5));
    await watched;
    expect(cache.current().tailscale.state).toBe("unknown");

    await vi.advanceTimersByTimeAsync(CHECK_POLL_MS * 3);
    expect(m.ports).toHaveLength(2);
  });

  it("a check that started before the serve command can't undo its result", async () => {
    const m = manualChecker();
    let changes = 0;
    const cache = new ChecksCache(() => changes++);
    cache.setChecker(m.checker);
    const watched = cache.watch(PORT);

    const missing: TailnetChecks = {
      tailscale: ready(1).tailscale,
      https: { state: "serve-missing", command: serveCommand(PORT) },
    };
    m.setSetupResult(ready(1));
    const setup = await cache.setUpHttps();
    expect(setup.checks).toEqual(ready(1));
    expect(cache.current()).toEqual(ready(1));

    m.pending.shift()!(missing);
    await watched;
    expect(cache.current()).toEqual(ready(1));
  });

  it("a setup still running across a restart doesn't stand in for the new watch's check", async () => {
    const ports: number[] = [];
    let finishSetup: (checks: TailnetChecks) => void = () => undefined;
    const cache = new ChecksCache(() => undefined);
    cache.setChecker({
      check: async (port) => {
        ports.push(port);
        return ready(port);
      },
      setUpHttps: () => new Promise((resolve) => (finishSetup = (checks) => resolve({ checks }))),
    });
    await cache.watch(PORT);
    const setup = cache.setUpHttps();

    // Phone link off and on again, on another port, while the serve command runs.
    cache.unwatch();
    await cache.watch(7777);
    expect(ports).toEqual([PORT, 7777]);
    expect(cache.current()).toEqual(ready(7777));

    // The old setup lands 5 s later: dropped, and it doesn't count as a fresh check
    // that would hold off the status request right after it.
    await vi.advanceTimersByTimeAsync(CHECK_MIN_INTERVAL_MS);
    finishSetup(ready(1));
    await setup;
    expect(cache.current()).toEqual(ready(7777));
    await cache.refresh();
    expect(ports).toEqual([PORT, 7777, 7777]);
  });

  it("two presses run the setup once; not watching runs nothing", async () => {
    const m = manualChecker();
    const cache = new ChecksCache(() => undefined);
    cache.setChecker(m.checker);

    expect((await cache.setUpHttps()).error).toBe("Turn the phone link on first.");
    expect(m.setups).toBe(0);

    const watched = cache.watch(PORT);
    m.pending.shift()!(ready(1));
    await watched;
    await Promise.all([cache.setUpHttps(), cache.setUpHttps()]);
    expect(m.setups).toBe(1);
  });

  it("a checker that throws reads as unknown", async () => {
    const cache = new ChecksCache(() => undefined);
    cache.setChecker({
      check: async () => {
        throw new Error("boom");
      },
      setUpHttps: async () => ({ checks: ready(0) }),
    });
    await cache.watch(PORT);
    expect(cache.current().tailscale).toEqual({ state: "unknown", detail: "Checking Tailscale failed: boom" });
  });
});
