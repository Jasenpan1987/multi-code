// The dev build's overrides (dev-overrides.ts): read only when unpackaged, and the
// checks file read again on every check, so a probe moves the Phone section through
// every state by rewriting it. "Set up HTTPS" never runs anything here.

import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { devOverrides, fileChecker } from "./dev-overrides";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-dev-checks-"));
const file = path.join(dir, "checks.json");

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("devOverrides", () => {
  const env = { MULTICODE_DEV_REMOTE_PORT: "6999", MULTICODE_DEV_REMOTE_CHECKS: file };

  it("is empty in a packaged app, whatever the environment says", () => {
    expect(devOverrides(true, env)).toEqual({});
  });

  it("gives the port and a file checker in a dev build", () => {
    const overrides = devOverrides(false, env);
    expect(overrides.port).toBe(6999);
    expect(overrides.checker).toBeDefined();
  });

  it("takes 0 for any free port, and ignores a port that isn't one", () => {
    expect(devOverrides(false, { MULTICODE_DEV_REMOTE_PORT: "0" }).port).toBe(0);
    expect(devOverrides(false, { MULTICODE_DEV_REMOTE_PORT: "70000" }).port).toBeUndefined();
    expect(devOverrides(false, { MULTICODE_DEV_REMOTE_PORT: "abc" }).port).toBeUndefined();
    expect(devOverrides(false, {})).toEqual({});
  });
});

describe("fileChecker", () => {
  it("reads the checks again on every call", async () => {
    const checker = fileChecker(file);
    fs.writeFileSync(file, JSON.stringify({ tailscale: { state: "stopped" } }));
    expect(await checker.check(1)).toEqual({ tailscale: { state: "stopped" }, https: { state: "unknown" } });

    const ready = {
      tailscale: { state: "running", dnsName: "mac.example.ts.net" },
      https: { state: "ready", origin: "https://mac.example.ts.net" },
    };
    fs.writeFileSync(file, JSON.stringify(ready));
    expect(await checker.check(1)).toEqual(ready);
  });

  it("says what is wrong with a file it can't read", async () => {
    const checks = await fileChecker(path.join(dir, "missing.json")).check(1);
    expect(checks.tailscale).toMatchObject({ state: "unknown", detail: expect.stringContaining("missing.json") });
  });

  it("runs nothing for Set up HTTPS, and says so or gives the file's error", async () => {
    const checker = fileChecker(file);
    const serveMissing = { tailscale: { state: "running", dnsName: "m" }, https: { state: "serve-missing", command: "x" } };
    fs.writeFileSync(file, JSON.stringify(serveMissing));
    const result = await checker.setUpHttps(1);
    expect(result.checks.https).toEqual(serveMissing.https);
    expect(result.error).toMatch(/^Nothing was run/);

    fs.writeFileSync(file, JSON.stringify({ ...serveMissing, setUpError: "tailscale serve failed: nope" }));
    expect((await checker.setUpHttps(1)).error).toBe("tailscale serve failed: nope");
  });
});
