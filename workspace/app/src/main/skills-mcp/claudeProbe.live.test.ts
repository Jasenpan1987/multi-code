// The probe on the real CLI, in this repository.
// Skipped unless MULTICODE_LIVE is set: it spawns `claude` and reads the builder's
// own `~/.claude/projects/`. It spends no tokens; the probe fails if it would.
//
//   MULTICODE_LIVE=1 npx vitest run src/main/skills-mcp/claudeProbe.live.test.ts

import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { encodeProjectDir } from "../backends/claude";
import { probeClaude } from "./claudeProbe";

const REPO = path.resolve(__dirname, "../../../../..");

function sessionFileCount(cwd: string): number {
  const dir = path.join(os.homedir(), ".claude/projects", encodeProjectDir(cwd));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

describe.skipIf(!process.env.MULTICODE_LIVE)("Claude probe on the real CLI", () => {
  it(
    "reads the init message, reaches no model and leaves no session file",
    async () => {
      const before = sessionFileCount(REPO);
      const started = Date.now();
      const result = await probeClaude(REPO);
      const seconds = (Date.now() - started) / 1000;

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      const { init } = result;
      console.log(
        `Claude Code ${init.version} in ${seconds.toFixed(1)} s: ` +
          `${init.mcpServers.length} MCP, ${init.plugins.length} plugins, ${init.skills.length} skills`
      );
      expect(init.skills.length).toBeGreaterThan(0);
      // Plugins load without --bare: omt is installed at project scope here.
      expect(init.plugins.map((p) => p.name)).toContain("omt");
      expect(init.skills).toContain("omt:work");
      expect(sessionFileCount(REPO)).toBe(before);
    },
    40_000
  );
});
