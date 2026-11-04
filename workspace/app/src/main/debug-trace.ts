import fs from "fs";
import os from "os";
import path from "path";

// Opt-in tracing of session discovery / completion detection, the two places
// where a bug is invisible from the UI (nothing beeps, and there is nothing to
// inspect after the fact). Off unless MULTICODE_DEBUG is set, so a shipped app
// never appends to a log file forever:
//
//   MULTICODE_DEBUG=1 /Applications/Multi-Code.app/Contents/MacOS/Multi-Code
//
// Lives in its own module rather than in process-manager so backends can import
// it without pulling in the electron `app` object at module load — store.ts
// calls app.getPath() at import time, which is undefined under vitest.
const ENABLED = !!process.env.MULTICODE_DEBUG;
const LOG_PATH = path.join(os.tmpdir(), "multicode-debug.log");

export function debugTrace(msg: string): void {
  if (!ENABLED) return;
  try {
    fs.appendFileSync(LOG_PATH, msg + "\n");
  } catch {
    // Tracing must never take the app down.
  }
}
