// Reading the builder's login-shell env: parsed after the marker, NUL-separated,
// resolved once and cached, failures included. Every test injects the runner; the
// real shell never starts here (unit tests must not run the builder's rc files).

import { describe, expect, it } from "vitest";
import {
  createShellEnvResolver,
  minimalShellEnv,
  parseShellEnv,
  shellEnvCommand,
  type ShellRunner,
} from "./opencodeShellEnv";

const MARKER = "__MULTICODE_ENV_0123456789abcdef__";

const envBlock = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join("\0") + "\0";

describe("parseShellEnv", () => {
  it("reads what follows the marker, NUL-separated, values with newlines and = intact", () => {
    const out = MARKER + envBlock({ PATH: "/a:/b", MULTI: "line1\nline2", EQ: "a=b=c", EMPTY: "" });
    expect(parseShellEnv(out, MARKER)).toEqual({ PATH: "/a:/b", MULTI: "line1\nline2", EQ: "a=b=c", EMPTY: "" });
  });

  it("ignores whatever the rc files printed first", () => {
    const noise = "Welcome back!\nFORTUNE=not an env line\n\x1b[1mbold\x1b[0m\0X=nul in the noise\n";
    const out = Buffer.from(noise + MARKER + envBlock({ HOME: "/Users/x", NVM_DIR: "/Users/x/.nvm" }));
    expect(parseShellEnv(out, MARKER)).toEqual({ HOME: "/Users/x", NVM_DIR: "/Users/x/.nvm" });
  });

  it("drops what describes the throwaway shell, not the builder's env", () => {
    const out = MARKER + envBlock({ PATH: "/a", PWD: "/Users/x", OLDPWD: "/", SHLVL: "1", _: "/usr/bin/env", TERM: "dumb" });
    expect(parseShellEnv(out, MARKER)).toEqual({ PATH: "/a" });
  });

  it("is null without the marker or with nothing after it", () => {
    expect(parseShellEnv(envBlock({ PATH: "/a" }), MARKER)).toBeNull();
    expect(parseShellEnv("noise" + MARKER, MARKER)).toBeNull();
    expect(parseShellEnv("", MARKER)).toBeNull();
  });
});

describe("the shell it runs", () => {
  it("prints the marker, then env -0 by its full path", () => {
    expect(shellEnvCommand(MARKER)).toBe(`printf '%s' '${MARKER}'; /usr/bin/env -0`);
  });

  it("starts from a minimal env, never the app's", () => {
    const env = minimalShellEnv("/bin/zsh", {
      HOME: "/Users/x",
      USER: "x",
      LOGNAME: "x",
      TMPDIR: "/var/folders/t/",
      SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners",
      PATH: "/usr/bin:/bin",
      MULTICODE_INSTANCE_ID: "parent",
      ELECTRON_RUN_AS_NODE: "1",
      ANTHROPIC_API_KEY: "secret",
    });
    expect(env).toEqual({
      HOME: "/Users/x",
      USER: "x",
      LOGNAME: "x",
      TMPDIR: "/var/folders/t/",
      SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners",
      SHELL: "/bin/zsh",
      TERM: "dumb",
    });
  });
});

// A runner that records its calls and answers from a script.
function fakeRunner(answer: { async?: () => Promise<Buffer | null>; sync?: () => Buffer | null }) {
  const calls: { kind: "async" | "sync"; shell: string; args: string[]; env: Record<string, string>; timeoutMs: number }[] = [];
  const runner: ShellRunner = {
    run(shell, args, env, timeoutMs) {
      calls.push({ kind: "async", shell, args, env, timeoutMs });
      return answer.async ? answer.async() : Promise.resolve(null);
    },
    runSync(shell, args, env, timeoutMs) {
      calls.push({ kind: "sync", shell, args, env, timeoutMs });
      return answer.sync ? answer.sync() : null;
    },
  };
  return { runner, calls };
}

// The marker the resolver made up, from the command it ran.
const markerOf = (args: string[]) => /'(__MULTICODE_ENV_[0-9a-f]+__)'/.exec(args[3])![1];

describe("createShellEnvResolver", () => {
  const options = { env: { HOME: "/Users/x", USER: "x" }, shell: "/bin/zsh", timeoutMs: 10_000 };

  it("runs `$SHELL -l -i -c` once in the background and caches the result", async () => {
    let calls: ReturnType<typeof fakeRunner>["calls"] = [];
    const fake = fakeRunner({
      async: async () => Buffer.from("hello from .zshrc\n" + markerOf(calls[0].args) + envBlock({ PATH: "/nvm/bin:/usr/bin" })),
    });
    calls = fake.calls;
    const resolver = createShellEnvResolver(fake.runner, options);
    expect(resolver.peek()).toBeNull();
    const [a, b] = await Promise.all([resolver.warm(), resolver.warm()]);
    expect(a).toEqual({ PATH: "/nvm/bin:/usr/bin" });
    expect(b).toBe(a);
    expect(resolver.get()).toBe(a);
    expect(resolver.peek()).toBe(a);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "async", shell: "/bin/zsh", timeoutMs: 10_000 });
    expect(calls[0].args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    expect(calls[0].env).toEqual({ HOME: "/Users/x", USER: "x", SHELL: "/bin/zsh", TERM: "dumb" });
  });

  it("resolves synchronously when a spawn needs it before the background run", () => {
    let calls: ReturnType<typeof fakeRunner>["calls"] = [];
    const fake = fakeRunner({ sync: () => Buffer.from(markerOf(calls[0].args) + envBlock({ PATH: "/p" })) });
    calls = fake.calls;
    const resolver = createShellEnvResolver(fake.runner, options);
    expect(resolver.get()).toEqual({ PATH: "/p" });
    expect(resolver.get()).toEqual({ PATH: "/p" });
    expect(calls.map((c) => c.kind)).toEqual(["sync"]);
  });

  it("keeps the first result when a background run lands after a blocking one", async () => {
    let finish: (value: Buffer | null) => void = () => {};
    let calls: ReturnType<typeof fakeRunner>["calls"] = [];
    const fake = fakeRunner({
      async: () => new Promise((resolve) => (finish = resolve)),
      sync: () => Buffer.from(markerOf(calls[1].args) + envBlock({ WHO: "sync" })),
    });
    calls = fake.calls;
    const resolver = createShellEnvResolver(fake.runner, options);
    const warming = resolver.warm();
    expect(resolver.get()).toEqual({ WHO: "sync" });
    finish(Buffer.from(markerOf(calls[0].args) + envBlock({ WHO: "async" })));
    expect(await warming).toEqual({ WHO: "sync" });
    expect(resolver.get()).toEqual({ WHO: "sync" });
  });

  it("caches a timeout too, so no later spawn waits on the shell again", async () => {
    const fake = fakeRunner({ async: async () => null, sync: () => null });
    const resolver = createShellEnvResolver(fake.runner, options);
    expect(await resolver.warm()).toBeNull();
    expect(resolver.get()).toBeNull();
    expect(await resolver.warm()).toBeNull();
    expect(fake.calls).toHaveLength(1);
  });

  it("treats output without its marker as a failure", async () => {
    const fake = fakeRunner({ async: async () => Buffer.from(envBlock({ PATH: "/p" })) });
    const resolver = createShellEnvResolver(fake.runner, options);
    expect(await resolver.warm()).toBeNull();
  });

  it("treats a runner that throws as a failure", async () => {
    const fake = fakeRunner({ async: () => Promise.reject(new Error("spawn EACCES")) });
    const resolver = createShellEnvResolver(fake.runner, options);
    expect(await resolver.warm()).toBeNull();
    expect(resolver.peek()).toBeNull();
  });
});
