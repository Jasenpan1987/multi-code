// The New Instance dialog's ways to a folder (epic new-project,
// docs/specs/new-project/prd.md): checking a typed folder before a session starts
// there, and cloning a Git repo into a folder the builder picks.
//
// A clone claims its target first with a plain mkdir, which fails when anything is
// there already, and remembers which folder it made. So the only folder ever removed
// after a failure or a cancel is that one, and a folder that was there before is
// never written to.
//
// git runs as it would in a new terminal tab: with the builder's login-shell
// environment, so their SSH key, agent and git settings apply. It runs without a shell,
// in its own process group (so no terminal to prompt on), and with nothing to prompt
// with (noPromptEnv): a login it can't do fails at once instead of waiting.

import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { lstatSync, rmSync } from "fs";
import { lstat, mkdir, rm, stat } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { warmOpencodeShellEnv } from "./backends/opencodeShellEnv";
import { debugTrace } from "./debug-trace";
import { cloneUrlOf, folderNameProblem, repoNameOf } from "../shared/gitUrl";
import type { CloneProgress, CloneResult, TypedFolder } from "../shared/types";

// A typed path as an absolute one. `~` is the home folder, and a relative path is
// taken from home, where a new terminal tab starts.
export function resolveTypedPath(input: string, home = homedir()): string {
  const text = input.trim();
  const expanded =
    text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded);
}

// stat, not lstat: a project reached through a link is still a folder. Anything stat
// can't see (missing, or no permission) is "missing".
export async function checkFolder(input: string, home = homedir()): Promise<TypedFolder> {
  const path = resolveTypedPath(input, home);
  const kind = await stat(path).then(
    (s): TypedFolder["kind"] => (s.isDirectory() ? "directory" : "file"),
    (): TypedFolder["kind"] => "missing"
  );
  return { path, kind };
}

export const NOT_A_FOLDER = (path: string) =>
  `This folder does not exist: ${path}. To make a new one, use Browse, then New Folder.`;

// git's stderr as a terminal would show it: a line ended by \r is redrawn by the next
// one (the progress counters), a line ended by \n stays. The last `keep` lines are
// kept for the error message.
export function createGitOutput(keep = 12) {
  let pending = "";
  let redrawn = false;
  const lines: string[] = [];
  return {
    // The latest line this chunk completed, or null when it completed none.
    push(chunk: string): string | null {
      pending += chunk;
      const re = /([^\r\n]*)(\r\n|\n|\r)/g;
      let latest: string | null = null;
      let end = 0;
      for (let m = re.exec(pending); m; m = re.exec(pending)) {
        end = re.lastIndex;
        const text = m[1].trimEnd();
        if (text === "") {
          // The \n of a \r\n that came in two chunks: the line stays.
          if (m[2] !== "\r") redrawn = false;
          continue;
        }
        if (redrawn) lines[lines.length - 1] = text;
        else lines.push(text);
        redrawn = m[2] === "\r";
        latest = text;
      }
      pending = pending.slice(end);
      if (lines.length > keep) lines.splice(0, lines.length - keep);
      return latest;
    },
    tail(): string {
      return [...lines, pending.trim()].filter(Boolean).join("\n");
    },
  };
}

// The percentage git reports on a progress line ("Receiving objects:  42% (…)").
export function percentOf(line: string): number | null {
  const m = /(\d{1,3})% \(/.exec(line);
  return m ? Math.min(100, Number(m[1])) : null;
}

// A short pointer for the two failures a builder can fix in a moment, after git's own
// words.
export function hintFor(output: string): string | undefined {
  if (/could not read (Username|Password)/i.test(output)) {
    return "This link needs a login git can't ask for here. Try the repo's SSH link (git@…).";
  }
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(output)) {
    return "git could not log in over SSH. Check that the same git clone works in a terminal.";
  }
  return undefined;
}

export type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface CloneDeps {
  spawn: Spawner;
  // The environment git runs with; null means Multi-Code's own.
  env: () => Promise<Record<string, string> | null>;
  // How long git gets to stop after Cancel before it is killed outright.
  killAfterMs: number;
}

// The login-shell environment OpenCode's spawns already use (a new terminal tab's).
const defaultDeps: CloneDeps = {
  spawn: nodeSpawn,
  env: warmOpencodeShellEnv,
  killAfterMs: 3000,
};

// The clone under way. `target` and `identity` are set once this clone has made
// the folder, `child` once git has been started.
interface Running {
  child: ChildProcess | null;
  target: string | null;
  identity: FolderIdentity | null;
  cancelled: boolean;
}
let running: Running | null = null;
let lastParent: string | undefined;

// Which folder this clone made, so it is removed only while the same folder is there.
// A path alone could by then name another folder (moved into place, or reached
// through a link retargeted meanwhile).
interface FolderIdentity {
  dev: number;
  ino: number;
}

// The folder the last successful clone went into, for "Clone into" next time.
export function lastClonedInto(): string | undefined {
  return lastParent;
}

// Checks the request and makes the empty target folder git clones into. The mkdir is
// the claim: it fails when anything is at the target. The path stays as typed (not
// its real path), as Open folder keeps it, so the duplicate check sees one spelling.
async function claimTarget(request: {
  url: string;
  parent: string;
  folderName: string;
}): Promise<
  { url: string; parent: string; target: string; identity: FolderIdentity } | { reason: string }
> {
  const url = cloneUrlOf(request.url);
  if (!url) return { reason: "This is not a Git URL. Paste an https:// link or an SSH link (git@…)." };
  const name = request.folderName.trim() || repoNameOf(url);
  const problem = name === "" ? "Enter a folder name" : folderNameProblem(name);
  if (problem) return { reason: problem };
  const checked = await checkFolder(request.parent);
  if (checked.kind !== "directory") return { reason: NOT_A_FOLDER(checked.path) };
  const parent = checked.path;
  const target = join(parent, name);
  try {
    await mkdir(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { reason: code === "EEXIST" ? `${target} already exists` : `Can't make ${target}: ${String(err)}` };
  }
  const made = await lstat(target);
  return { url, parent, target, identity: { dev: made.dev, ino: made.ino } };
}

// Removes the folder this clone made, and nothing else. True when it is gone (git may
// have removed it already); false when it is still there, or another folder now is.
async function removeOwnFolder(target: string, identity: FolderIdentity): Promise<boolean> {
  try {
    const now = await lstat(target);
    if (!now.isDirectory() || now.dev !== identity.dev || now.ino !== identity.ino) return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  return rm(target, { recursive: true, force: true }).then(
    () => true,
    () => false
  );
}

function removeOwnFolderSync(target: string, identity: FolderIdentity): void {
  try {
    const now = lstatSync(target);
    if (now.isDirectory() && now.dev === identity.dev && now.ino === identity.ino) {
      rmSync(target, { recursive: true, force: true });
    }
  } catch {
    // Quitting anyway; a folder left here is refused as "already exists" next time.
  }
}

// git, and ssh under it, must never ask: no terminal prompt, no askpass program
// (GIT_ASKPASS set but empty also overrides `core.askPass`), and no Git Credential
// Manager window. Stored logins (the keychain, an ssh agent) still work.
export function noPromptEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== "SSH_ASKPASS") env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS_REQUIRE = "never";
  env.GCM_INTERACTIVE = "never";
  return env;
}

export async function cloneRepo(
  request: { url: string; parent: string; folderName: string },
  onProgress: (progress: CloneProgress) => void,
  deps: CloneDeps = defaultDeps
): Promise<CloneResult> {
  if (running) return { kind: "refused", reason: "A clone is already running" };
  // Claimed before anything is awaited, so a second clone can't slip in meanwhile.
  const claim: Running = { child: null, target: null, identity: null, cancelled: false };
  running = claim;
  // Released on every way out, or every later clone would be refused.
  const claimed = await claimTarget(request).catch((err: unknown) => ({ reason: String(err) }));
  if ("reason" in claimed) {
    running = null;
    return { kind: "refused", reason: claimed.reason };
  }
  const { url, parent, target, identity } = claimed;
  claim.target = target;
  claim.identity = identity;

  const shellEnv = await deps.env().catch(() => null);
  const env = noPromptEnv(shellEnv ?? process.env);
  const output = createGitOutput();

  return new Promise<CloneResult>((settle) => {
    let finished = false;
    const finish = async (code: number | null, error: string | null) => {
      if (finished) return;
      finished = true;
      if (code === 0 && !claim.cancelled) {
        running = null;
        lastParent = parent;
        debugTrace(`[clone] done ${target}`);
        settle({ kind: "done", path: target });
        return;
      }
      const removed = await removeOwnFolder(target, identity);
      running = null;
      const what = removed ? "removed" : "left in place";
      if (claim.cancelled) {
        debugTrace(`[clone] cancelled, ${what} ${target}`);
        settle({ kind: "cancelled", path: target, removed });
        return;
      }
      const said = error ?? output.tail();
      debugTrace(`[clone] failed (exit ${code}), ${what} ${target}`);
      settle({
        kind: "failed",
        path: target,
        removed,
        output: said || `git exited with code ${code}`,
        hint: hintFor(said),
      });
    };

    // Cancelled while the env was read: git never starts.
    if (claim.cancelled) {
      void finish(null, null);
      return;
    }
    let child: ChildProcess;
    try {
      child = deps.spawn("git", ["clone", "--progress", "--", url, target], {
        cwd: parent,
        env,
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
    } catch (err) {
      void finish(null, String(err));
      return;
    }
    claim.child = child;
    debugTrace(`[clone] start into ${target}`);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const line = output.push(chunk);
      if (line !== null) onProgress({ line, percent: percentOf(line) });
    });
    // A git that never started may send no "close".
    child.on("error", (err) => {
      if (child.pid !== undefined) return;
      void finish(
        null,
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "git was not found. Install git (xcode-select --install) and try again."
          : String(err)
      );
    });
    // After git's own exit, once every process holding its stderr has let go.
    child.on("close", (code) => void finish(code, null));
  });
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, sig);
  } catch {
    // The group is gone already, or never formed: the leader alone.
    child.kill(sig);
  }
}

// Stops the running clone: the whole group, as git starts helpers (ssh, index-pack).
// It gets a moment to stop on its own; then whatever of the group is still there is
// killed, git itself gone or not, since a helper left holding stderr would keep the
// clone from ever finishing.
export function cancelClone(deps: Pick<CloneDeps, "killAfterMs"> = defaultDeps): void {
  const current = running;
  if (!current || current.cancelled) return;
  current.cancelled = true;
  const { child } = current;
  if (!child) return; // not started yet: cloneRepo sees `cancelled` and never starts it
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (running === current) killGroup(child, "SIGKILL");
  }, deps.killAfterMs);
  child.once("close", () => clearTimeout(timer));
}

// Multi-Code is quitting: git is killed at once (it runs in its own group, so it would
// outlive the app and keep downloading), and the folder this clone made goes with it.
export function abortCloneForQuit(): void {
  const current = running;
  if (!current) return;
  current.cancelled = true;
  if (current.child) killGroup(current.child, "SIGKILL");
  if (current.target && current.identity) removeOwnFolderSync(current.target, current.identity);
}
