// Overrides for a dev build (`electron .`), so the Phone section can be checked on an
// isolated instance beside the installed app. Read only when the app isn't packaged:
// a packaged Multi-Code ignores both variables, whoever starts it and however.
//
//   MULTICODE_DEV_REMOTE_PORT=<n>       the port the phone server binds instead of
//                                       6768, which the installed app holds while it
//                                       runs; 0 takes any free one.
//   MULTICODE_DEV_REMOTE_CHECKS=<file>  Tailscale and HTTPS read from this JSON file on
//                                       every check instead of from Tailscale:
//                                       `{ "tailscale": …, "https": … }` as RemoteChecks
//                                       holds them, and an optional `setUpError`. "Set
//                                       up HTTPS" then runs nothing and says so (or
//                                       gives `setUpError`), so pressing it in a dev
//                                       build can't touch the machine's Tailscale.

import fs from "fs";
import { UNKNOWN_CHECKS, type RemoteChecker, type TailnetChecks } from "./tailscale";

export interface DevOverrides {
  port?: number;
  checker?: RemoteChecker;
}

export function devOverrides(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): DevOverrides {
  if (isPackaged) return {};
  const overrides: DevOverrides = {};
  const port = env.MULTICODE_DEV_REMOTE_PORT;
  if (port && /^\d+$/.test(port) && Number(port) <= 65535) overrides.port = Number(port);
  if (env.MULTICODE_DEV_REMOTE_CHECKS) overrides.checker = fileChecker(env.MULTICODE_DEV_REMOTE_CHECKS);
  return overrides;
}

// Reads the file again on every call, so a probe changes the state by rewriting it.
export function fileChecker(file: string): RemoteChecker {
  const read = (): { checks: TailnetChecks; setUpError?: string } => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TailnetChecks> & {
        setUpError?: unknown;
      };
      return {
        checks: {
          tailscale: parsed.tailscale ?? UNKNOWN_CHECKS.tailscale,
          https: parsed.https ?? UNKNOWN_CHECKS.https,
        },
        ...(typeof parsed.setUpError === "string" ? { setUpError: parsed.setUpError } : {}),
      };
    } catch (err) {
      const detail = `Dev checks file ${file}: ${(err as Error).message}`;
      return { checks: { tailscale: { state: "unknown", detail }, https: { state: "unknown", detail } } };
    }
  };
  return {
    check: async () => read().checks,
    setUpHttps: async () => {
      const { checks, setUpError } = read();
      return {
        checks,
        error: setUpError ?? `Nothing was run: the checks come from ${file} (MULTICODE_DEV_REMOTE_CHECKS).`,
      };
    },
  };
}
