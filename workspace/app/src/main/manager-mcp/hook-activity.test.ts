// The manager's own Bash/Edit/Write reaching the feed. Until this existed, the
// most privileged thing the manager did was also the only invisible thing it did:
// those calls go from its CLI straight to the machine and never touch our server.
//
// The payloads here are real deliveries captured from CLI 2.1.273 (2026-09-16),
// trimmed of the fields this module ignores. The shared `tool_use_id` across a
// call's two hooks is the property the two-phase entry rests on, so it is asserted
// rather than assumed.

import { beforeEach, describe, expect, it } from "vitest";
import {
  hookEndpointFor,
  recordHookDelivery,
  SELF_TOOL_MATCHER,
} from "./hook-activity";
import { managerActivityLog } from "./activity-log";

const TOOL_USE_ID = "toolu_bdrk_01WJDyodijpXN8vEhjTxiQg2";

function bashPre(command: string, id = TOOL_USE_ID) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: id,
    cwd: "/Users/x/Library/Application Support/multi-code/manager",
    tool_input: { command, description: "whatever" },
  };
}

function bashPost(
  command: string,
  response: Record<string, unknown>,
  id = TOOL_USE_ID
) {
  return {
    ...bashPre(command, id),
    hook_event_name: "PostToolUse",
    tool_response: {
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      ...response,
    },
  };
}

beforeEach(() => {
  managerActivityLog.reset();
});

describe("recordHookDelivery — the two phases", () => {
  it("opens a running entry marked as the manager's own work", () => {
    expect(recordHookDelivery(bashPre("git log --oneline -3"))).toBe("started");

    const [entry] = managerActivityLog.list();
    expect(entry.origin).toBe("self");
    expect(entry.tool).toBe("Bash");
    expect(entry.status).toBe("running");
    expect(entry.payload).toBe("git log --oneline -3");
  });

  it("closes that same entry on the matching tool_use_id", () => {
    recordHookDelivery(bashPre("git log --oneline -3"));
    expect(
      recordHookDelivery(bashPost("git log --oneline -3", { stdout: "e8dbb3b docs" }))
    ).toBe("finished");

    // One entry, not two: the pairing is the point.
    const entries = managerActivityLog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("ok");
    expect(entries[0].result).toContain("e8dbb3b docs");
    expect(entries[0].durationMs).toBeDefined();
  });

  it("keeps two concurrent calls apart", () => {
    // The model issues tool calls in parallel, so both PreToolUse hooks arrive
    // before either PostToolUse — measured during T-211 with start_session and
    // send_task in the same turn.
    recordHookDelivery(bashPre("pnpm test", "toolu_a"));
    recordHookDelivery(bashPre("git status", "toolu_b"));
    recordHookDelivery(bashPost("git status", { stdout: "clean" }, "toolu_b"));

    const byPayload = new Map(
      managerActivityLog.list().map((e) => [e.payload, e])
    );
    expect(byPayload.get("git status")?.status).toBe("ok");
    expect(byPayload.get("pnpm test")?.status).toBe("running");
  });

  it("records a PostToolUse whose PreToolUse it never saw", () => {
    // The app can start listening between a call's two hooks. Dropping the half
    // we did get would hide a real call, so it lands as a completed entry.
    expect(
      recordHookDelivery(bashPost("git push", { stdout: "done" }))
    ).toBe("finished");

    const entries = managerActivityLog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("ok");
    expect(entries[0].payload).toBe("git push");
  });
});

describe("recordHookDelivery — what counts as a failure", () => {
  it("flags an interrupted call", () => {
    recordHookDelivery(bashPre("sleep 300"));
    recordHookDelivery(bashPost("sleep 300", { interrupted: true }));

    const [entry] = managerActivityLog.list();
    expect(entry.status).toBe("error");
    expect(entry.result).toContain("interrupted");
  });

  it("does not flag a command that merely exited non-zero", () => {
    // `git diff --quiet` exits 1 when there are changes, which is the answer, not
    // a failure. Colouring those red would teach the user to ignore the colour.
    recordHookDelivery(bashPre("git diff --quiet"));
    recordHookDelivery(
      bashPost("git diff --quiet", { stderr: "", stdout: "" })
    );
    expect(managerActivityLog.list()[0].status).toBe("ok");
  });

  it("keeps stderr in the result where it is the only output", () => {
    recordHookDelivery(bashPre("pnpm type"));
    recordHookDelivery(bashPost("pnpm type", { stderr: "error TS2339" }));
    expect(managerActivityLog.list()[0].result).toContain("error TS2339");
  });
});

describe("recordHookDelivery — payload shaping", () => {
  it("shows a bash command bare, with no JSON wrapper", () => {
    recordHookDelivery(bashPre("cd /Users/x/code/portals && git fetch"));
    expect(managerActivityLog.list()[0].payload).toBe(
      "cd /Users/x/code/portals && git fetch"
    );
  });

  it("shows which file a Write touched, not the file's contents", () => {
    // A written file body would fill the row and push four other calls out of
    // view. Which file was written is the thing the user needs to see.
    recordHookDelivery({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_use_id: "toolu_w",
      cwd: "/Users/x/code/portals",
      tool_input: {
        file_path: "/Users/x/code/portals/src/deep/config.ts",
        content: "x".repeat(5000),
      },
    });

    const { payload } = managerActivityLog.list()[0];
    expect(payload).toContain("src/deep/config.ts");
    expect(payload).toContain("content: 5000 chars");
    expect(payload).not.toContain("xxxxxxxxxx");
  });

  it("keeps an absolute path when the file is outside the cwd", () => {
    recordHookDelivery({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_use_id: "toolu_e",
      cwd: "/Users/x/Library/Application Support/multi-code/manager",
      tool_input: {
        file_path: "/Users/x/code/portals/README.md",
        old_string: "before",
        new_string: "after",
      },
    });

    const { payload } = managerActivityLog.list()[0];
    // A bare "../../.." chain would leave the user working out which repo it was.
    expect(payload).toContain("/Users/x/code/portals/README.md");
    expect(payload).toContain("old_string: before");
  });
});

describe("recordHookDelivery — deliveries to ignore", () => {
  it("ignores a delivery with no tool name or no id", () => {
    expect(recordHookDelivery({ hook_event_name: "PreToolUse" })).toBe("ignored");
    expect(
      recordHookDelivery({ hook_event_name: "PreToolUse", tool_name: "Bash" })
    ).toBe("ignored");
    expect(managerActivityLog.list()).toHaveLength(0);
  });

  it("ignores a hook event it doesn't handle", () => {
    expect(
      recordHookDelivery({
        hook_event_name: "SessionStart",
        tool_name: "Bash",
        tool_use_id: "toolu_s",
      })
    ).toBe("ignored");
    expect(managerActivityLog.list()).toHaveLength(0);
  });

  it("survives a delivery whose tool_input is the wrong shape", () => {
    expect(
      recordHookDelivery({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_odd",
        tool_input: "not an object",
      })
    ).toBe("started");
    expect(managerActivityLog.list()[0].payload).toBe("(no command)");
  });
});

describe("SELF_TOOL_MATCHER", () => {
  it("matches the tools that act", () => {
    const matcher = new RegExp(SELF_TOOL_MATCHER);
    for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(matcher.test(tool)).toBe(true);
    }
  });

  it("leaves out the tools that only look", () => {
    const matcher = new RegExp(SELF_TOOL_MATCHER);
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "BashOutput"]) {
      expect(matcher.test(tool)).toBe(false);
    }
  });
});

describe("hookEndpointFor", () => {
  it("keeps the port and swaps the path, so there is one server to secure", () => {
    expect(hookEndpointFor("http://127.0.0.1:54321/mcp")).toBe(
      "http://127.0.0.1:54321/hook"
    );
  });

  it("returns null for something that isn't a URL", () => {
    expect(hookEndpointFor("not a url")).toBeNull();
  });
});
