// Read-only access to OpenCode 2's records in `opencode.db`: session lookups, the
// transcript, the builder's turn, context usage and the context window.
//
// Contract stub (opencode-v2 T-602); T-606 implements it. Tables and shapes:
// docs/timeline/2026-10-20_opencode-v2-source-reading.md, "Database". Every function
// returns null or empty when the database can't be read, and never throws. `dbPath`
// and `configPath` are overridable for tests; tests must never read the real HOME.

import type { BuilderTurn } from "./types";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { ContextUsage } from "../../shared/types";

// `$OPENCODE_DB`, else `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`.
export function opencodeDbPath(_env: NodeJS.ProcessEnv = process.env): string {
  throw new Error("opencodeDb: not implemented (T-606)");
}

// Unknown (unreadable) counts as yes, as today: resuming a session that turns out to be
// gone costs a restart, starting fresh in its place loses the contact's history.
export function opencodeSessionExists(_sessionId: string, _dbPath?: string): boolean {
  throw new Error("opencodeDb: not implemented (T-606)");
}

// The directory's newest root session (by `time_updated`) that `isClaimed` doesn't
// veto, matching `cwd` as given or resolved. Null when there is none.
export function latestRootSession(
  _cwd: string,
  _isClaimed?: (sessionId: string) => boolean,
  _dbPath?: string
): string | null {
  throw new Error("opencodeDb: not implemented (T-606)");
}

export function readOpencodeTranscript(
  _sessionId: string,
  _limit: number,
  _dbPath?: string
): TranscriptEntry[] {
  throw new Error("opencodeDb: not implemented (T-606)");
}

export function readOpencodeBuilderTurn(
  _sessionId: string,
  _dbPath?: string
): BuilderTurn | null {
  throw new Error("opencodeDb: not implemented (T-606)");
}

export function readOpencodeContextUsage(
  _sessionId: string,
  _dbPath?: string,
  _configPath?: string
): ContextUsage | null {
  throw new Error("opencodeDb: not implemented (T-606)");
}

// The model's context window: the user's config override, then OpenCode's cached
// models.dev catalog. Null when neither knows the model.
export function readOpencodeContextWindow(
  _model: string | undefined,
  _providerId: string | undefined,
  _dbPath?: string,
  _configPath?: string
): number | null {
  throw new Error("opencodeDb: not implemented (T-606)");
}
