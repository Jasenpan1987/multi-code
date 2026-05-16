import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GitStatusUnavailable {
  available: false;
}

export interface GitFileEntry {
  path: string;
  code: string;
}

export interface GitStatusAvailable {
  available: true;
  branch: string;
  untracked: number;
  unstaged: number;
  staged: number;
  ahead: number;
  behind: number;
  newFiles: GitFileEntry[];
  modifiedFiles: GitFileEntry[];
  stagedFiles: GitFileEntry[];
}

export type GitStatus = GitStatusUnavailable | GitStatusAvailable;

const UNAVAILABLE: GitStatusUnavailable = { available: false };

async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function parsePorcelain(porcelain: string): {
  untracked: number;
  unstaged: number;
  staged: number;
  newFiles: GitFileEntry[];
  modifiedFiles: GitFileEntry[];
  stagedFiles: GitFileEntry[];
} {
  let untracked = 0;
  let unstaged = 0;
  let staged = 0;
  const newFiles: GitFileEntry[] = [];
  const modifiedFiles: GitFileEntry[] = [];
  const stagedFiles: GitFileEntry[] = [];

  for (const rawLine of porcelain.split("\n")) {
    if (rawLine.length < 3) continue;
    const xy = rawLine.slice(0, 2);
    const filePath = rawLine.slice(3);

    if (xy === "??") {
      untracked++;
      newFiles.push({ path: filePath, code: "?" });
      continue;
    }

    const x = xy[0];
    const y = xy[1];
    if (x !== " " && x !== "?") {
      staged++;
      stagedFiles.push({ path: filePath, code: x });
    }
    if (y !== " " && y !== "?") {
      unstaged++;
      modifiedFiles.push({ path: filePath, code: y });
    }
  }

  return {
    untracked,
    unstaged,
    staged,
    newFiles,
    modifiedFiles,
    stagedFiles,
  };
}

async function readBranch(cwd: string): Promise<string> {
  const out = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}

async function readAheadBehind(cwd: string): Promise<{ ahead: number; behind: number }> {
  try {
    const out = await run(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    const [aheadStr, behindStr] = out.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadStr, 10) || 0,
      behind: Number.parseInt(behindStr, 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  if (!cwd) return UNAVAILABLE;

  const dotGit = path.join(cwd, ".git");
  if (!fs.existsSync(dotGit)) return UNAVAILABLE;

  try {
    const [branch, porcelain, aheadBehind] = await Promise.all([
      readBranch(cwd),
      run(cwd, ["status", "--porcelain"]),
      readAheadBehind(cwd),
    ]);

    const counts = parsePorcelain(porcelain);

    return {
      available: true,
      branch,
      untracked: counts.untracked,
      unstaged: counts.unstaged,
      staged: counts.staged,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      newFiles: counts.newFiles,
      modifiedFiles: counts.modifiedFiles,
      stagedFiles: counts.stagedFiles,
    };
  } catch {
    return UNAVAILABLE;
  }
}
