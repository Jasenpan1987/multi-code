// The thing worth testing here is the file mode. The token in this file is the
// only thing standing between any local process and the ability to dispatch work
// into every session Multi-Code manages, so 0600 is the point of the module —
// and writeFileSync's mode silently does nothing when the file already exists.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-mcp-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const { writeMcpConfig, removeMcpConfig, MCP_SERVER_NAME } = await import(
  "./config"
);

const configFile = path.join(userData, "manager-mcp.json");
const target = { endpoint: "http://127.0.0.1:54321/mcp", token: "tok_abc" };

afterEach(() => {
  removeMcpConfig();
});

describe("writeMcpConfig", () => {
  it("writes the shape the CLI expects", () => {
    const file = writeMcpConfig(target);
    expect(file).toBe(configFile);
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(parsed).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: "http://127.0.0.1:54321/mcp",
          headers: { Authorization: "Bearer tok_abc" },
        },
      },
    });
  });

  it("writes the file 0600", () => {
    writeMcpConfig(target);
    const mode = fs.statSync(configFile).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("forces 0600 even when a laxer file was already there", () => {
    // The regression this guards: writeFileSync's `mode` applies only when
    // creating, so overwriting a 0644 file left the token world-readable.
    fs.writeFileSync(configFile, "{}", { mode: 0o644 });
    fs.chmodSync(configFile, 0o644);
    writeMcpConfig(target);
    const mode = fs.statSync(configFile).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("returns null and writes nothing for a null target", () => {
    expect(writeMcpConfig(null)).toBeNull();
    expect(fs.existsSync(configFile)).toBe(false);
  });
});

describe("removeMcpConfig", () => {
  it("deletes the file so a dead token doesn't outlive the run", () => {
    writeMcpConfig(target);
    expect(fs.existsSync(configFile)).toBe(true);
    removeMcpConfig();
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("is a no-op when the file is already gone", () => {
    expect(() => removeMcpConfig()).not.toThrow();
  });
});
