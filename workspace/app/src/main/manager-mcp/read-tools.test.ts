// The addressing and the output text are what these tests pin down. Both are
// contracts with a model rather than with code: a name the manager can't resolve,
// or a status line it reads as finer-grained than it is, turns into the manager
// confidently doing the wrong thing.

import { describe, expect, it } from "vitest";
import {
  buildReadTools,
  clampLimit,
  formatAge,
  formatContext,
  formatSessionList,
  formatTranscript,
  resolveSession,
  type ManagerHost,
} from "./read-tools";
import type { InstanceInfo } from "../process-manager";
import type { TranscriptEntry } from "../../shared/remote-protocol";

function instance(over: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: "id-1",
    cwd: "/Users/x/code/msk",
    name: "msk",
    status: "running",
    startedAt: 1000,
    backend: "claude",
    sessionId: "ses-1",
    ...over,
  };
}

function host(over: Partial<ManagerHost> = {}): ManagerHost {
  return {
    listInstances: () => [instance()],
    readTranscript: () => [],
    hasReadableTranscript: () => true,
    ...over,
  };
}

function toolsOf(h: ManagerHost) {
  const tools = buildReadTools(h);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: byName.get("list_sessions")!,
    read: byName.get("read_session")!,
  };
}

describe("resolveSession", () => {
  const instances = [
    instance({ id: "a", name: "msk" }),
    instance({ id: "b", name: "portal-backend" }),
  ];

  it("resolves an exact name", () => {
    const r = resolveSession(instances, "portal-backend");
    expect("instance" in r && r.instance.id).toBe("b");
  });

  it("is case-insensitive and trims", () => {
    const r = resolveSession(instances, "  MSK  ");
    expect("instance" in r && r.instance.id).toBe("a");
  });

  it("lists the valid names when the name is unknown", () => {
    const r = resolveSession(instances, "ghost");
    expect("error" in r && r.error).toContain("msk, portal-backend");
    expect("error" in r && r.error).toContain("ghost");
  });

  it("names the directories when two sessions share a name", () => {
    // Happens when neither has an alias and both directories end the same way.
    const dupes = [
      instance({ id: "a", name: "api", cwd: "/one/api" }),
      instance({ id: "b", name: "api", cwd: "/two/api" }),
    ];
    const r = resolveSession(dupes, "api");
    expect("error" in r && r.error).toContain("/one/api");
    expect("error" in r && r.error).toContain("/two/api");
    expect("error" in r && r.error).toMatch(/distinct alias/);
  });

  it("rejects a missing or blank name with the valid list", () => {
    expect("error" in resolveSession(instances, undefined)).toBe(true);
    expect("error" in resolveSession(instances, "   ")).toBe(true);
    const r = resolveSession(instances, "");
    expect("error" in r && r.error).toContain("msk");
  });

  it("says none when there are no sessions at all", () => {
    const r = resolveSession([], "msk");
    expect("error" in r && r.error).toContain("(none)");
  });
});

describe("clampLimit", () => {
  it("defaults to 50", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit("many")).toBe(50);
    expect(clampLimit(NaN)).toBe(50);
  });

  it("caps at 200 and floors at 1", () => {
    expect(clampLimit(10_000)).toBe(200);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });

  it("passes a sane value through, truncating fractions", () => {
    expect(clampLimit(120)).toBe(120);
    expect(clampLimit(12.7)).toBe(12);
  });
});

describe("formatAge", () => {
  const now = 1_000_000_000;
  it("reports never for an absent or zero timestamp", () => {
    expect(formatAge(undefined, now)).toBe("never");
    expect(formatAge(0, now)).toBe("never");
  });
  it("scales the unit", () => {
    expect(formatAge(now - 10_000, now)).toBe("just now");
    expect(formatAge(now - 4 * 60_000, now)).toBe("4m ago");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
  it("doesn't produce a negative age from clock skew", () => {
    expect(formatAge(now + 5000, now)).toBe("just now");
  });
});

describe("formatSessionList", () => {
  const now = 2_000_000;

  it("renders one line per session with the addressable name first", () => {
    const out = formatSessionList(
      [
        instance({
          name: "msk",
          backend: "claude",
          contextUsage: { inputTokens: 453023, updatedAt: 1, model: "claude-opus-5" },
          lastActivityAt: now - 120_000,
        }),
      ],
      now
    );
    expect(out).toContain("name=msk");
    expect(out).toContain("backend=claude");
    expect(out).toContain("status=running");
    expect(out).toContain("context=453023 tokens");
    expect(out).toContain("model=claude-opus-5");
    expect(out).toContain("last-activity=2m ago");
    expect(out).toContain("cwd=/Users/x/code/msk");
  });

  it("gives raw token counts, not abbreviations", () => {
    // The UI abbreviates for space; a model comparing two sessions needs the
    // actual number, and "453k" would lose the comparison.
    const out = formatSessionList(
      [instance({ contextUsage: { inputTokens: 453023, updatedAt: 1 } })],
      now
    );
    expect(out).toContain("453023");
    expect(out).not.toContain("453k");
  });

  it("says unknown rather than zero when usage hasn't been read", () => {
    const out = formatSessionList([instance({ contextUsage: undefined })], now);
    expect(out).toContain("context=unknown");
    expect(out).not.toContain("context=0");
  });

  it("marks a stopped session", () => {
    const out = formatSessionList([instance({ status: "stopped" })], now);
    expect(out).toContain("status=stopped");
  });

  it("falls back to the transcript's age when no live activity was seen", () => {
    // A session resumed with --continue has a long history but fires no activity
    // this app run, so lastActivityAt is absent and "never" would be misleading.
    const out = formatSessionList(
      [
        instance({
          lastActivityAt: undefined,
          contextUsage: { inputTokens: 100, updatedAt: now - 5 * 60_000 },
        }),
      ],
      now
    );
    expect(out).toContain("last-activity=5m ago");
    expect(out).not.toContain("last-activity=never");
  });

  it("prefers the live activity signal over the transcript's age", () => {
    const out = formatSessionList(
      [
        instance({
          lastActivityAt: now - 60_000,
          contextUsage: { inputTokens: 100, updatedAt: now - 3 * 3_600_000 },
        }),
      ],
      now
    );
    expect(out).toContain("last-activity=1m ago");
  });

  it("still says never when there is neither signal", () => {
    const out = formatSessionList(
      [instance({ lastActivityAt: undefined, contextUsage: undefined })],
      now
    );
    expect(out).toContain("last-activity=never");
  });

  it("reports the live run state rather than just running", () => {
    const out = formatSessionList([instance({ runState: "blocked" })], now);
    expect(out).toContain("status=blocked");
    expect(out).not.toContain("status=running");
  });

  it("falls back to stopped when there is no live state", () => {
    const out = formatSessionList(
      [instance({ status: "stopped", runState: undefined })],
      now
    );
    expect(out).toContain("status=stopped");
  });

  it("explains each state, and that blocked belongs to the user", () => {
    // Without this the manager treats blocked as something to work around, which is
    // how it ends up trying to answer a permission prompt on the user's behalf.
    const out = formatSessionList([instance()], now);
    expect(out).toMatch(/blocked = stopped on a decision only the user can make/);
    expect(out).toMatch(/you cannot answer it for them/);
  });

  it("handles an empty fleet without pretending something is wrong", () => {
    expect(formatSessionList([], now)).toMatch(/No sessions/);
  });

  it("counts sessions in the header", () => {
    const out = formatSessionList(
      [instance({ id: "a", name: "one" }), instance({ id: "b", name: "two" })],
      now
    );
    expect(out.split("\n")[0]).toBe("2 sessions:");
  });
});

describe("formatTranscript", () => {
  const entries: TranscriptEntry[] = [
    { kind: "user", text: "fix the failing test" },
    { kind: "assistant", text: "looking now" },
    { kind: "tool", tool: "Bash", text: "pnpm test" },
    { kind: "tool", tool: "Edit", text: "src/foo.ts", pending: true },
  ];

  it("labels each entry by role, and names the tool", () => {
    const out = formatTranscript("msk", entries, 50);
    expect(out).toContain("user: fix the failing test");
    expect(out).toContain("assistant: looking now");
    expect(out).toContain("tool Bash: pnpm test");
  });

  it("flags the tool the session is still on", () => {
    const out = formatTranscript("msk", entries, 50);
    expect(out).toContain("tool Edit [still running]: src/foo.ts");
  });

  it("says it is the whole transcript when fewer entries than asked for", () => {
    expect(formatTranscript("msk", entries, 50)).toMatch(/entire transcript \(4 entries\)/);
  });

  it("says it is a tail when the limit was reached", () => {
    expect(formatTranscript("msk", entries, 4)).toMatch(/last 4 transcript entries/);
  });

  it("reports an empty transcript plainly", () => {
    expect(formatTranscript("msk", [], 50)).toMatch(/no readable transcript/);
  });
});

describe("read_session tool", () => {
  it("passes the clamped limit through to the host", () => {
    let asked = -1;
    const tools = toolsOf(
      host({
        readTranscript: (_id, limit) => {
          asked = limit;
          return [{ kind: "user", text: "hi" }];
        },
      })
    );
    tools.read.handler({ name: "msk", limit: 9999 });
    expect(asked).toBe(200);
  });

  it("addresses the host by internal id, not by the name the model used", () => {
    let gotId = "";
    const tools = toolsOf(
      host({
        listInstances: () => [instance({ id: "internal-42", name: "msk" })],
        readTranscript: (id) => {
          gotId = id;
          return [];
        },
      })
    );
    tools.read.handler({ name: "MSK" });
    expect(gotId).toBe("internal-42");
  });

  // Reversed at T-214. Refusing a stopped session cost a real capability for no
  // safety gain — the transcript is a file on disk — and it fired on the very first
  // question ever asked of the manager.
  it("reads a stopped session, labelling it as history", () => {
    const tools = toolsOf(
      host({
        listInstances: () => [
          instance({ status: "stopped", sessionId: undefined }),
        ],
        readTranscript: () => [{ kind: "assistant", text: "did the thing" }],
      })
    );
    const out = tools.read.handler({ name: "msk" }) as string;
    expect(out).toContain("did the thing");
    expect(out).toMatch(/is STOPPED/);
    expect(out).toMatch(/history, not work in progress/);
  });

  it("does not label a running session as stopped", () => {
    const tools = toolsOf(
      host({ readTranscript: () => [{ kind: "assistant", text: "working" }] })
    );
    expect(tools.read.handler({ name: "msk" })).not.toMatch(/STOPPED/);
  });

  it("refuses when there is no transcript anywhere, and says which case it is", () => {
    const tools = toolsOf(host({ hasReadableTranscript: () => false }));
    expect(() => tools.read.handler({ name: "msk" })).toThrow(
      /no transcript on disk/
    );
  });

  it("refuses an unknown name, listing what exists", () => {
    const tools = toolsOf(host());
    expect(() => tools.read.handler({ name: "nope" })).toThrow(/msk/);
  });

  it("never reads the transcript of a session it refused", () => {
    let called = false;
    const tools = toolsOf(
      host({
        hasReadableTranscript: () => false,
        readTranscript: () => {
          called = true;
          return [];
        },
      })
    );
    expect(() => tools.read.handler({ name: "msk" })).toThrow();
    expect(called).toBe(false);
  });
});

describe("tool definitions", () => {
  it("exposes exactly the two read tools", () => {
    expect(buildReadTools(host()).map((t) => t.name)).toEqual([
      "list_sessions",
      "read_session",
    ]);
  });

  it("tells the model reading is cheaper than asking", () => {
    // The description is the only thing steering the manager away from burning a
    // target's turn on a status question it could have read.
    const { read } = toolsOf(host());
    expect(read.description).toMatch(/costs the target session nothing/);
    expect(read.description).toMatch(/Prefer this over asking/);
  });

  it("takes no arguments for list_sessions", () => {
    const { list } = toolsOf(host());
    expect(list.inputSchema.properties).toEqual({});
  });
});

// "Which session should I hand off?" is a question about fullness, and a raw token
// count doesn't answer it: 271k is nearly full on a 200k window and comfortable on
// a 1M one. So the percentage goes in the tool output whenever it can be computed.
describe("formatContext", () => {
  it("reports a percentage when the window is known", () => {
    expect(
      formatContext({ inputTokens: 500_000, updatedAt: 1, contextWindow: 1_000_000 })
    ).toBe("500000/1000000 tokens (50% full)");
  });

  it("falls back to the bare count when the window is unknown", () => {
    expect(formatContext({ inputTokens: 271_243, updatedAt: 1 })).toBe(
      "271243 tokens"
    );
  });

  it("says unknown when there is no usage at all", () => {
    expect(formatContext(undefined)).toBe("unknown");
  });

  it("does not hide an over-full session", () => {
    expect(
      formatContext({ inputTokens: 226_000, updatedAt: 1, contextWindow: 100_000 })
    ).toBe("226000/100000 tokens (226% full)");
  });
});

describe("formatSessionList — context", () => {
  it("carries the percentage through into the tool output", () => {
    const out = formatSessionList([
      instance({
        contextUsage: {
          inputTokens: 900_000,
          updatedAt: 1,
          contextWindow: 1_000_000,
          model: "claude-opus-5",
        },
      }),
    ]);
    expect(out).toContain("90% full");
    expect(out).toContain("model=claude-opus-5");
  });

  it("shows a bare count for a session whose window is unknown", () => {
    const out = formatSessionList([
      instance({ contextUsage: { inputTokens: 90_090, updatedAt: 1 } }),
    ]);
    expect(out).toContain("context=90090 tokens");
    expect(out).not.toContain("% full");
  });
});
