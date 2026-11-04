// Symlink-resolving path comparison, shared by both backends.
//
// Why this exists: both CLIs record the cwd they *resolved*, not the one they
// were handed. On macOS `/tmp` is a symlink to `/private/tmp`, so an instance
// configured with `/tmp/x` shows up in Claude's session file and OpenCode's
// sqlite as `/private/tmp/x`. A literal string compare then never matches, and
// session discovery fails silently — the instance runs fine but gets no
// completion detection, no prompt detection, and no phone notifications, with
// nothing in the UI to say why.
//
// Kept in its own module so claude.ts doesn't have to import opencode.ts (and
// with it better-sqlite3, a native dependency it has no use for).

import fs from "fs";

// Cached: session discovery polls once a second per instance, and a running
// process's path doesn't change underneath it.
const cache = new Map<string, string>();

/**
 * Resolve symlinks in `input`. Falls back to returning `input` unchanged when the
 * path doesn't exist or can't be read, so a not-yet-created directory behaves the
 * same as it did before rather than throwing.
 */
export function resolvePath(input: string): string {
  const cached = cache.get(input);
  if (cached !== undefined) return cached;

  let resolved: string;
  try {
    resolved = fs.realpathSync(input);
  } catch {
    resolved = input;
  }
  cache.set(input, resolved);
  return resolved;
}

/** True when both paths point at the same directory once symlinks are resolved. */
export function samePath(a: string, b: string): boolean {
  return resolvePath(a) === resolvePath(b);
}

// Exposed for tests, which need to observe the fallback behaviour for paths that
// are created and removed within one run.
export function clearResolvePathCache(): void {
  cache.clear();
}
