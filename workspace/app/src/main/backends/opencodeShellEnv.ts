// The builder's login-shell environment, read once per app run, for OpenCode's spawns
// (docs/knowledge/decisions.md, 2026-10-20 "OpenCode gets the builder's login-shell
// environment").
//
// Why: OpenCode 2's shared service keeps the environment of whoever starts it, for every
// client. Multi-Code opened from the Dock has the bare launchd PATH, without nvm, so a
// service it started couldn't run the builder's `npx`-launched MCP server in any
// OpenCode window, VS Code and terminals included (T-601 spike, G-604/G-605). VS Code
// resolves the shell environment the same way: an interactive login shell, a marker,
// a timeout.
//
// How: `$SHELL -l -i -c 'printf <marker>; /usr/bin/env -0'` from a minimal env, so the
// rc files build the environment a new terminal tab would get, and nothing of
// Electron's or a parent Multi-Code's leaks into it. rc files may print (a greeting, a
// fortune), so only what follows the marker is read; `env -0` separates entries with
// NUL, so values with newlines survive. The result, or the failure, is cached for the
// run: a shell that timed out once would block every spawn for another 10 s.
//
// Values are never logged: the env carries the builder's tokens.

import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import os from "os";
import { debugTrace } from "../debug-trace";

// VS Code's own bound for the same job. A login shell measured 1.4 s on the builder's
// machine (decisions.md); 10 s leaves room for a slow nvm or a cold disk.
export const SHELL_ENV_TIMEOUT_MS = 10_000;

// More than any real environment, so a runaway rc file can't fill memory.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// What the throwaway shell says about itself rather than about the builder's
// environment: its working directory, its nesting level, its last command, and the
// `TERM=dumb` it was given. node-pty sets the TUI's TERM itself.
const SHELL_BOOKKEEPING = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM"]);

// The variables the minimal env carries when the app has them. launchd gives
// SSH_AUTH_SOCK and __CF_USER_TEXT_ENCODING to every terminal tab, and the rc files
// don't usually set them: without SSH_AUTH_SOCK, `git` over ssh in the agent's shell
// (and in a service Multi-Code starts) would lose the keychain's agent.
const PASSED_THROUGH = ["HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"];

// The builder's login shell: the account's (`os.userInfo().shell`), else the inherited
// `$SHELL`, else zsh, macOS's default since 10.15.
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  let shell: string | null | undefined;
  try {
    shell = os.userInfo().shell;
  } catch {
    // No passwd entry (a container): fall through.
  }
  return shell || env.SHELL || "/bin/zsh";
}

export function minimalShellEnv(shell: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSED_THROUGH) {
    const value = env[key];
    if (value) out[key] = value;
  }
  out.HOME ??= os.homedir();
  out.SHELL = shell;
  // Keeps prompt themes and instant-prompt plugins from drawing to a terminal there
  // isn't.
  out.TERM = "dumb";
  return out;
}

// The command the login shell runs. Plain enough for sh, bash, zsh and fish; the
// marker is hex, so it needs no quoting. `/usr/bin/env` by path, so an rc's alias or
// function named `env` can't answer instead.
export function shellEnvCommand(marker: string): string {
  return `printf '%s' '${marker}'; /usr/bin/env -0`;
}

// The environment after the marker, or null when the marker never came (the rc file
// exec'd something else, or the shell died first) or nothing followed it.
export function parseShellEnv(output: Buffer | string, marker: string): Record<string, string> | null {
  const text = typeof output === "string" ? output : output.toString("utf8");
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const env: Record<string, string> = {};
  for (const entry of text.slice(at + marker.length).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (SHELL_BOOKKEEPING.has(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : null;
}

// Runs the shell and returns its stdout, or null on timeout or failure. Injected in
// tests: unit tests never start the real shell.
export interface ShellRunner {
  run(shell: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<Buffer | null>;
  runSync(shell: string, args: string[], env: Record<string, string>, timeoutMs: number): Buffer | null;
}

export const defaultShellRunner: ShellRunner = {
  run(shell, args, env, timeoutMs) {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        // Detached, as VS Code does: an interactive shell with job control would
        // otherwise try to take over the controlling terminal of a Multi-Code started
        // from one (`pnpm start`).
        child = spawn(shell, args, { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
      } catch {
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (value: Buffer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const kill = () => {
        try {
          // The whole group: rc files start helpers of their own.
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        kill();
        finish(null);
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          kill();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => finish(null));
      // Exit status is not checked: the marker and the entries decide. `env -0` is the
      // last command, and an rc file's failing line doesn't make its output wrong.
      child.on("close", () => finish(Buffer.concat(chunks)));
    });
  },
  runSync(shell, args, env, timeoutMs) {
    try {
      const result = spawnSync(shell, args, {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      if (result.error) return null;
      return result.stdout;
    } catch {
      return null;
    }
  },
};

export interface ShellEnvResolver {
  // Resolves in the background and caches; the same promise for every caller.
  warm(): Promise<Record<string, string> | null>;
  // The cached result, else a synchronous resolution (blocking the caller up to the
  // timeout, once per run), else null.
  get(): Record<string, string> | null;
  // The cached result without resolving anything: null while unknown.
  peek(): Record<string, string> | null;
}

export function createShellEnvResolver(
  runner: ShellRunner = defaultShellRunner,
  options: { env?: NodeJS.ProcessEnv; shell?: string; timeoutMs?: number } = {}
): ShellEnvResolver {
  const inherited = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS;
  let done = false;
  let cached: Record<string, string> | null = null;
  let pending: Promise<Record<string, string> | null> | null = null;

  const prepare = () => {
    const shell = options.shell ?? loginShell(inherited);
    const marker = `__MULTICODE_ENV_${crypto.randomBytes(8).toString("hex")}__`;
    return { shell, marker, args: ["-l", "-i", "-c", shellEnvCommand(marker)], env: minimalShellEnv(shell, inherited) };
  };

  // The first result to land wins; a later one (the background run finishing after a
  // spawn had to resolve synchronously) is dropped.
  const settle = (output: Buffer | null, marker: string, started: number, how: string) => {
    if (done) return cached;
    done = true;
    cached = output ? parseShellEnv(output, marker) : null;
    const took = Date.now() - started;
    debugTrace(
      cached
        ? `[shell-env] login-shell env read (${how}, ${took} ms, ${Object.keys(cached).length} vars)`
        : `[shell-env] login-shell env unavailable (${how}, ${took} ms, ${output ? "no marker" : "timeout or error"}); OpenCode spawns use Multi-Code's env`
    );
    return cached;
  };

  return {
    warm() {
      if (done) return Promise.resolve(cached);
      if (!pending) {
        const { shell, marker, args, env } = prepare();
        const started = Date.now();
        pending = runner.run(shell, args, env, timeoutMs).then(
          (output) => settle(output, marker, started, "background"),
          () => settle(null, marker, started, "background")
        );
      }
      return pending;
    },
    get() {
      if (done) return cached;
      const { shell, marker, args, env } = prepare();
      const started = Date.now();
      return settle(runner.runSync(shell, args, env, timeoutMs), marker, started, "blocking");
    },
    peek() {
      return done ? cached : null;
    },
  };
}

const resolver = createShellEnvResolver();

// Starts reading the login-shell env in the background, so it is ready by the time an
// OpenCode contact spawns: called when the New Instance dialog asks whether OpenCode
// is available, and at app start when an OpenCode contact exists.
export function warmOpencodeShellEnv(): Promise<Record<string, string> | null> {
  return resolver.warm();
}

// For spawn, which is synchronous. Null means "use Multi-Code's own env".
export function opencodeShellEnv(): Record<string, string> | null {
  return resolver.get();
}

// Without blocking: the env when it is already known, else null.
export function cachedOpencodeShellEnv(): Record<string, string> | null {
  return resolver.peek();
}

// The env OpenCode's own files are found by: the service's registration, the database
// and the config sit under XDG_STATE_HOME, XDG_DATA_HOME, XDG_CONFIG_HOME and
// OPENCODE_DB as the OpenCode Multi-Code starts sees them, which is the login shell's.
// Multi-Code's own env until that is known, or when it can't be read (spawns then use
// Multi-Code's too).
export function opencodePathEnv(): NodeJS.ProcessEnv {
  return cachedOpencodeShellEnv() ?? process.env;
}
