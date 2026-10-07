// The brief writer on the real CLI and Bedrock, on the T-501 spike's six samples.
// Skipped unless MULTICODE_LIVE is set: it spawns `claude`, costs money, and needs
// the builder's own transcripts, which never go in the repo.
//
// Rebuild the samples with the spike's script, then run:
//   node .omt/probes/voice-secretary/t501/build_inputs.cjs <dir>
//   MULTICODE_LIVE=1 MULTICODE_LIVE_SAMPLES=<dir> npx vitest run src/main/secretary/briefWriter.live.test.ts

import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { BriefWriterInput } from "./briefWriter";

// Only the pure core runs here; process-manager would load electron and userData.
vi.mock("../process-manager", () => ({ processManager: {} }));

const { INPUT_BUDGET_CHARS, fitToBudget, writeBrief } = await import("./briefWriter");

const SAMPLES: [id: string, language: "Chinese" | "English"][] = [
  ["s1-finish-zh", "Chinese"],
  ["s2-finish-en", "English"],
  ["s3-bash-zh", "Chinese"],
  ["s4-bash-en", "English"],
  ["s5-ask-zh", "Chinese"],
  ["s6-ask-en", "English"],
];

describe.skipIf(!process.env.MULTICODE_LIVE)("brief writer on the real CLI", () => {
  const dir = process.env.MULTICODE_LIVE_SAMPLES ?? "";

  for (const [id, language] of SAMPLES) {
    it(`${id}: a ${language} brief that opens with the session's name`, async () => {
      const input: BriefWriterInput = fitToBudget(
        JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")),
        INPUT_BUDGET_CHARS
      );
      const started = Date.now();
      const brief = await writeBrief(input);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`${id} ${seconds} s ${JSON.stringify(brief)}`);

      expect(brief.ok, brief.ok ? "" : brief.reason).toBe(true);
      if (!brief.ok) return;
      expect(brief.language).toBe(language);
      expect(brief.text.slice(0, 40).toLowerCase()).toContain(input.session.toLowerCase());
      // Written for the ear: no markdown, code or paths.
      expect(brief.text).not.toMatch(/```|^#|\*\*|^- /m);
    }, 90_000);
  }
});
