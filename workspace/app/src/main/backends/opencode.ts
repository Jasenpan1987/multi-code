import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type {
  Backend,
  CompletionDetector,
  SessionDiscovery,
  SpawnConfig,
} from "./types";

const HOME = process.env.HOME || "";

const SEARCH_PATH = [
  path.join(HOME, ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "",
].join(":");

function findOpencodeBinary(): string {
  // Try PATH-resolve first (handles nvm-installed binaries etc.)
  try {
    const resolved = execSync("command -v opencode", {
      env: { ...process.env, PATH: SEARCH_PATH },
      encoding: "utf8",
    }).trim();
    if (resolved) return resolved;
  } catch {
    // fallthrough
  }

  const candidates = [
    path.join(HOME, ".local/bin/opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "opencode";
}

const opencodePath = findOpencodeBinary();

function buildEnv(): Record<string, string> {
  return {
    ...process.env,
    PATH: SEARCH_PATH,
  } as Record<string, string>;
}

class NoopSessionDiscovery implements SessionDiscovery {
  cancel() {}
}

class NoopCompletionDetector implements CompletionDetector {
  stop() {}
}

export const opencodeBackend: Backend = {
  name: "opencode",

  spawn(_cwd: string): SpawnConfig {
    // OpenCode handles "no prior session" gracefully — always pass --continue.
    // (T-103 keeps spawn simple; richer session-existence detection is in T-106.)
    return {
      command: opencodePath,
      args: ["--continue"],
      env: buildEnv(),
    };
  },

  discoverSessionId(_cwd, _onFound): SessionDiscovery {
    // Filled in by T-106 (sqlite query against ~/.local/share/opencode/opencode.db).
    return new NoopSessionDiscovery();
  },

  createCompletionDetector(_sessionId, _onActivity): CompletionDetector {
    // Filled in by T-106.
    return new NoopCompletionDetector();
  },

  buildResumeCommand(sessionId: string): string {
    return `opencode --session ${sessionId}`;
  },
};

export function isOpencodeAvailable(): boolean {
  // Re-check at call time (PATH may differ from spawn time).
  try {
    execSync("command -v opencode", {
      env: { ...process.env, PATH: SEARCH_PATH },
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
