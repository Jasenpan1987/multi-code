import { describe, expect, it } from "vitest";
import { briefSentence } from "./briefSentence";

describe("briefSentence", () => {
  it("is a brief's first sentence, in Chinese or English", () => {
    expect(briefSentence("Shop 那边，登录修好了。测试全部通过。")).toBe("Shop 那边，登录修好了。");
    expect(briefSentence("Shop finished the login fix. All tests pass.")).toBe("Shop finished the login fix.");
    expect(briefSentence("Shop needs you！它要跑一个脚本。")).toBe("Shop needs you！");
  });

  it("doesn't stop at a sentence end too soon to say anything, or inside a word", () => {
    expect(briefSentence("OK. Shop is done with it.")).toBe("OK. Shop is done with it.");
    expect(briefSentence("Shop ran v1.2.3 of the build. Nothing failed.")).toBe("Shop ran v1.2.3 of the build.");
  });

  it("is one line, cut at 140 characters without a sentence end", () => {
    expect(briefSentence("Shop\nis done.\n\nNext.")).toBe("Shop is done.");
    const long = "字".repeat(200);
    expect(Array.from(briefSentence(long))).toHaveLength(140);
    expect(briefSentence(long).endsWith("…")).toBe(true);
    expect(briefSentence("")).toBe("");
  });
});
