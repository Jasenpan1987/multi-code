// The phone server's wiring: an instance acknowledged at the desk reaches the remote
// host's markSeen (G-304; ws-server.test.ts covers what markSeen does to the list), a
// session opened on a phone reaches the desk as read, and the dev-only overrides
// (dev-overrides.ts) apply only to an unpackaged app.

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ isPackaged: false }));
const fakes = vi.hoisted(() => ({
  markSeen: vi.fn(),
  readOnPhone: vi.fn(),
  readListener: null as ((id: string) => void) | null,
  setChecker: vi.fn(),
  start: vi.fn(async () => ({})),
  tailscaleChecker: { check: async () => ({}), setUpHttps: async () => ({}) },
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../process-manager", () => ({ processManager: { readOnPhone: fakes.readOnPhone } }));
vi.mock("../settings-store", () => ({
  loadSettings: () => ({ remoteEnabled: false }),
  saveSettings: () => undefined,
}));
vi.mock("./remote-host", () => ({ createRemoteHost: () => ({ markSeen: fakes.markSeen }) }));
vi.mock("./ws-server", () => ({
  remoteServer: {
    setHost: () => undefined,
    setStatusListener: () => undefined,
    setReadListener: (listener: (id: string) => void) => {
      fakes.readListener = listener;
    },
    setChecker: fakes.setChecker,
    start: fakes.start,
    stop: async () => undefined,
    getStatus: () => ({}),
  },
}));
vi.mock("./tailscale", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tailscale")>()),
  createTailscaleChecker: () => fakes.tailscaleChecker,
}));

const { acknowledgeInstance, initRemote, setRemoteEnabled } = await import("./index");

beforeEach(() => {
  vi.unstubAllEnvs();
  fakes.markSeen.mockReset();
  fakes.readOnPhone.mockReset();
  fakes.setChecker.mockReset();
  fakes.start.mockClear();
});

describe("acknowledgeInstance", () => {
  it("marks the instance seen on the phone's side", () => {
    initRemote();
    acknowledgeInstance("inst-1");
    expect(fakes.markSeen).toHaveBeenCalledWith("inst-1");
  });
});

describe("a session opened on a phone", () => {
  it("is read at the desk, and isn't acknowledged back to the phone", () => {
    initRemote();
    fakes.readListener?.("inst-1");
    expect(fakes.readOnPhone).toHaveBeenCalledWith("inst-1");
    expect(fakes.markSeen).not.toHaveBeenCalled();
  });
});

describe("dev overrides", () => {
  it("bind the dev port and read the checks file in an unpackaged app", async () => {
    electron.isPackaged = false;
    vi.stubEnv("MULTICODE_DEV_REMOTE_PORT", "0");
    vi.stubEnv("MULTICODE_DEV_REMOTE_CHECKS", "/nonexistent/checks.json");
    initRemote();
    await setRemoteEnabled(true);
    expect(fakes.start).toHaveBeenCalledWith(0);
    expect(fakes.setChecker.mock.calls[0][0]).not.toBe(fakes.tailscaleChecker);
  });

  it("are ignored by a packaged app", async () => {
    electron.isPackaged = true;
    vi.stubEnv("MULTICODE_DEV_REMOTE_PORT", "0");
    vi.stubEnv("MULTICODE_DEV_REMOTE_CHECKS", "/nonexistent/checks.json");
    initRemote();
    await setRemoteEnabled(true);
    expect(fakes.start).toHaveBeenCalledWith(undefined);
    expect(fakes.setChecker.mock.calls[0][0]).toBe(fakes.tailscaleChecker);
  });
});
