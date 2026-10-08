// The orchestrator with the brief writer, the speech client and the event source
// faked: each fake call stays pending until the test settles it, so every step of
// a brief (preparing, text, audio) can be looked at on its own, and a newer event
// or a clear can land while a call is still in flight.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretaryEvent, SecretaryEventListener } from "../process-manager";
import type { BriefLanguage, SecretaryBriefState } from "../../shared/types";
import type { Brief } from "./briefWriter";
import type { SpeechOptions, SpeechServer, SynthesizeResult } from "./speech";

// Anything in this module graph touching the disk is recorded, never performed.
const disk = vi.hoisted(() => {
  const writes: string[] = [];
  const WRITE = /^(write|append|mkdir|mkdtemp|rename|copy|cp|rm|unlink|truncate|symlink|link|chmod|chown|utimes|open|createWriteStream)/;
  const guard = (real: Record<string, unknown>, name: string) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(real)) {
      out[key] =
        typeof value === "function" && WRITE.test(key)
          ? () => {
              writes.push(`${name}.${key}`);
            }
          : value;
    }
    return { ...out, default: out };
  };
  return { writes, guard };
});
vi.mock("fs", async (orig) => disk.guard(await orig(), "fs"));
vi.mock("node:fs", async (orig) => disk.guard(await orig(), "fs"));
vi.mock("fs/promises", async (orig) => disk.guard(await orig(), "fs/promises"));
vi.mock("node:fs/promises", async (orig) => disk.guard(await orig(), "fs/promises"));

// The default instance's real modules. Every test builds its own secretary on
// fakes; these only keep the import from loading electron, node-pty or userData.
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../process-manager", () => ({
  processManager: {
    onSecretaryEvent: () => () => {},
    liveSecretaryEvents: () => [],
  },
}));
vi.mock("../settings-store", () => ({
  loadSpeechServer: () => {
    throw new Error("a test read the real speech settings");
  },
}));
vi.mock("./briefWriter", () => ({
  writeBriefFor: () => {
    throw new Error("a test called the real brief writer");
  },
}));

import { createSecretary, NO_SERVER_REASON } from "./index";
import { TARGET_DBFS } from "./loudness";
import type { SecretaryDeps } from "./index";

interface Pending<T> {
  settle: (value: T) => void;
  signal: AbortSignal;
}

interface WriteCall extends Pending<Brief> {
  instanceId: string;
  event: SecretaryEvent;
}

interface SpeakCall extends Pending<SynthesizeResult> {
  server: SpeechServer;
  text: string;
  language: BriefLanguage;
}

const SERVER: SpeechServer = { url: "https://tts.example.com", key: "sk-test" };
const WAV = Buffer.from("RIFF\0\0\0\0WAVEfmt fake");

const ev = (seq: number, kind: SecretaryEvent["kind"] = "finished"): SecretaryEvent => ({
  kind,
  seq,
  at: 1_000 + seq,
});

const brief = (text: string, language: BriefLanguage = "Chinese"): Brief => ({
  ok: true,
  language,
  text,
});

// Lets the orchestrator's awaits run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  let listener: SecretaryEventListener | null = null;
  const live: { instanceId: string; event: SecretaryEvent }[] = [];
  const writes: WriteCall[] = [];
  const speaks: SpeakCall[] = [];
  const sent: unknown[][] = [];
  const speech = { server: SERVER };

  // Like the real ones: an abort resolves "aborted". A test can still settle the
  // call afterwards, to play a writer that comes back anyway.
  function pending<T>(signal: AbortSignal, aborted: T, push: (p: Pending<T>) => void) {
    return new Promise<T>((resolve) => {
      signal.addEventListener("abort", () => resolve(aborted));
      push({ settle: resolve, signal });
    });
  }

  const deps: SecretaryDeps = {
    onSecretaryEvent: vi.fn((l: SecretaryEventListener) => {
      listener = l;
      return () => {
        listener = null;
      };
    }),
    liveSecretaryEvents: vi.fn(() => live),
    writeBriefFor: vi.fn((instanceId: string, event: SecretaryEvent, signal: AbortSignal) =>
      pending<Brief>(signal, { ok: false, reason: "aborted" }, (p) =>
        writes.push({ ...p, instanceId, event })
      )
    ),
    loadSpeechServer: vi.fn(() => speech.server),
    synthesize: vi.fn(
      (server: SpeechServer, text: string, language: BriefLanguage, options: SpeechOptions) =>
        pending<SynthesizeResult>(options.signal!, { ok: false, reason: "aborted" }, (p) =>
          speaks.push({ ...p, server, text, language })
        )
    ),
    send: vi.fn((...args: unknown[]) => {
      sent.push(args);
    }),
  };

  const secretary = createSecretary(deps);
  return {
    secretary,
    deps,
    live,
    writes,
    speaks,
    speech,
    // As process-manager fires it: a new event, or null when it clears.
    fire: (instanceId: string, event: SecretaryEvent | null) => listener?.(instanceId, event),
    subscribed: () => listener !== null,
    // Every secretary-brief push for the instance, in order.
    pushes: (instanceId: string) =>
      sent
        .filter(([channel, id]) => channel === "secretary-brief" && id === instanceId)
        .map(([, , state]) => state as SecretaryBriefState | null),
    modePushes: () =>
      sent.filter(([channel]) => channel === "secretary-mode").map(([, on]) => on),
    sentCount: () => sent.length,
  };
}

beforeEach(() => {
  disk.writes.length = 0;
});

describe("mode off", () => {
  it("prepares nothing, spawns nothing and calls nothing", async () => {
    const h = harness();
    h.secretary.start(false);
    expect(h.subscribed()).toBe(true);

    h.fire("a", ev(1));
    h.fire("a", ev(2, "needs-you"));
    h.fire("a", null);
    await flush();

    expect(h.deps.writeBriefFor).not.toHaveBeenCalled();
    expect(h.deps.loadSpeechServer).not.toHaveBeenCalled();
    expect(h.deps.synthesize).not.toHaveBeenCalled();
    expect(h.deps.liveSecretaryEvents).not.toHaveBeenCalled();
    expect(h.deps.send).not.toHaveBeenCalled();
    expect(h.secretary.briefs()).toEqual({});
    expect(h.secretary.isOn()).toBe(false);
  });
});

describe("one event", () => {
  it("goes preparing, then ready with the text while audio is pending, then audio ready", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(7, "needs-you"));

    expect(h.pushes("a")).toEqual([{ seq: 7, kind: "needs-you", status: "preparing" }]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].instanceId).toBe("a");
    expect(h.writes[0].event).toEqual(ev(7, "needs-you"));

    h.writes[0].settle(brief("MSK 要跑一个删除脚本，问你行不行。"));
    await flush();
    const ready = {
      seq: 7,
      kind: "needs-you",
      status: "ready",
      text: "MSK 要跑一个删除脚本，问你行不行。",
      language: "Chinese",
    };
    expect(h.pushes("a")[1]).toEqual({ ...ready, audio: "pending" });
    expect(h.secretary.briefs()).toEqual({ a: { ...ready, audio: "pending" } });
    expect(h.secretary.audioFor("a", 7)).toBeNull();

    // The text, in its language, to the server read for this brief.
    expect(h.speaks).toHaveLength(1);
    expect(h.speaks[0]).toMatchObject({
      server: SERVER,
      text: "MSK 要跑一个删除脚本，问你行不行。",
      language: "Chinese",
    });

    h.speaks[0].settle({ ok: true, wav: WAV });
    await flush();
    expect(h.pushes("a")).toEqual([
      { seq: 7, kind: "needs-you", status: "preparing" },
      { ...ready, audio: "pending" },
      { ...ready, audio: "ready" },
    ]);
    expect(h.secretary.briefs()).toEqual({ a: { ...ready, audio: "ready" } });
    expect(h.secretary.audioFor("a", 7)).toBe(WAV);
    // The wav never rides an update.
    expect(JSON.stringify(h.pushes("a"))).not.toContain("RIFF");
  });

  it("keeps the server's audio brought to speech loudness (T-515)", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("MSK finished the migration.", "English"));
    await flush();
    // One second of a 220 Hz tone at -27 dBFS RMS, the server's level.
    const pcm = Buffer.alloc(48000);
    for (let i = 0; i < 24000; i++) {
      const v = 0.0447 * Math.SQRT2 * Math.sin((2 * Math.PI * 220 * i) / 24000);
      pcm.writeInt16LE(Math.round(v * 32768), i * 2);
    }
    const head = Buffer.alloc(44);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(36 + pcm.length, 4);
    head.write("WAVEfmt ", 8, "latin1");
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(24000, 24);
    head.writeUInt32LE(48000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36, "latin1");
    head.writeUInt32LE(pcm.length, 40);
    h.speaks[0].settle({ ok: true, wav: Buffer.concat([head, pcm]) });
    await flush();

    const kept = h.secretary.audioFor("a", 1)!;
    let sum = 0;
    for (let i = 0; i < 24000; i++) sum += (kept.readInt16LE(44 + i * 2) / 32768) ** 2;
    expect(20 * Math.log10(Math.sqrt(sum / 24000))).toBeCloseTo(TARGET_DBFS, 0);
  });

  it("is ready with audio unavailable and the reason when synthesis fails, and doesn't retry", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("MSK finished the migration.", "English"));
    await flush();
    h.speaks[0].settle({ ok: false, reason: "timed out after 15 s" });
    await flush();
    await flush();

    expect(h.pushes("a").at(-1)).toEqual({
      seq: 1,
      kind: "finished",
      status: "ready",
      text: "MSK finished the migration.",
      language: "English",
      audio: "unavailable",
      voiceReason: "timed out after 15 s",
    });
    expect(h.secretary.audioFor("a", 1)).toBeNull();
    expect(h.deps.writeBriefFor).toHaveBeenCalledTimes(1);
    expect(h.deps.synthesize).toHaveBeenCalledTimes(1);
  });

  it("goes straight to audio unavailable with no server set, without a speech call", async () => {
    const h = harness();
    h.speech.server = { url: "", key: "" };
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("MSK 做完了。"));
    await flush();

    expect(h.pushes("a")).toEqual([
      { seq: 1, kind: "finished", status: "preparing" },
      {
        seq: 1,
        kind: "finished",
        status: "ready",
        text: "MSK 做完了。",
        language: "Chinese",
        audio: "unavailable",
        voiceReason: NO_SERVER_REASON,
      },
    ]);
    expect(h.deps.synthesize).not.toHaveBeenCalled();
  });

  it("reads the server per brief, so one that comes back speaks the next brief", async () => {
    const h = harness();
    h.speech.server = { url: "", key: "" };
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("first"));
    await flush();
    expect(h.deps.synthesize).not.toHaveBeenCalled();

    h.speech.server = SERVER;
    h.fire("a", ev(2));
    h.writes[1].settle(brief("second"));
    await flush();
    expect(h.speaks).toHaveLength(1);
    expect(h.speaks[0].text).toBe("second");
    expect(h.deps.loadSpeechServer).toHaveBeenCalledTimes(2);
  });

  it("fails when the brief writer fails, and calls no speech server", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(3, "needs-you"));
    h.writes[0].settle({ ok: false, reason: "the CLI exited with code 1" });
    await flush();

    expect(h.pushes("a").at(-1)).toEqual({
      seq: 3,
      kind: "needs-you",
      status: "failed",
      reason: "the CLI exited with code 1",
    });
    expect(h.deps.loadSpeechServer).not.toHaveBeenCalled();
    expect(h.deps.synthesize).not.toHaveBeenCalled();
  });

  it("fails rather than hangs when a writer breaks its contract and throws", async () => {
    const h = harness();
    vi.mocked(h.deps.writeBriefFor).mockRejectedValueOnce(new Error("spawn ENOENT"));
    h.secretary.start(true);
    h.fire("a", ev(1));
    await flush();
    expect(h.pushes("a").at(-1)).toEqual({
      seq: 1,
      kind: "finished",
      status: "failed",
      reason: "spawn ENOENT",
    });
  });
});

describe("a newer event", () => {
  it("aborts the brief in flight, starts over, and discards the older result", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    const first = h.writes[0];

    h.fire("a", ev(2, "needs-you"));
    expect(first.signal.aborted).toBe(true);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].event.seq).toBe(2);
    // Straight from one brief to the next: no null in between.
    expect(h.pushes("a")).toEqual([
      { seq: 1, kind: "finished", status: "preparing" },
      { seq: 2, kind: "needs-you", status: "preparing" },
    ]);

    // A writer that answers anyway is ignored.
    first.settle(brief("stale"));
    await flush();
    expect(h.pushes("a")).toHaveLength(2);
    expect(h.deps.synthesize).not.toHaveBeenCalled();

    h.writes[1].settle(brief("fresh"));
    await flush();
    expect(h.pushes("a").at(-1)).toMatchObject({ seq: 2, status: "ready", text: "fresh" });
  });

  it("cancels the older brief's speech request and drops its audio", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("old"));
    await flush();
    const oldSpeech = h.speaks[0];

    h.fire("a", ev(2));
    expect(oldSpeech.signal.aborted).toBe(true);
    oldSpeech.settle({ ok: true, wav: WAV });
    await flush();
    expect(h.secretary.audioFor("a", 1)).toBeNull();
    expect(h.secretary.audioFor("a", 2)).toBeNull();
    expect(h.secretary.briefs().a).toEqual({ seq: 2, kind: "finished", status: "preparing" });
  });
});

describe("a clear", () => {
  it("aborts the brief and drops it", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(4, "needs-you"));
    const write = h.writes[0];

    h.fire("a", null);
    expect(write.signal.aborted).toBe(true);
    expect(h.pushes("a").at(-1)).toBeNull();
    expect(h.secretary.briefs()).toEqual({});

    const before = h.sentCount();
    write.settle(brief("answered already"));
    await flush();
    expect(h.sentCount()).toBe(before);
    expect(h.deps.synthesize).not.toHaveBeenCalled();
  });

  it("drops a ready brief and its audio", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("done"));
    await flush();
    h.speaks[0].settle({ ok: true, wav: WAV });
    await flush();
    expect(h.secretary.audioFor("a", 1)).toBe(WAV);

    h.fire("a", null);
    expect(h.secretary.audioFor("a", 1)).toBeNull();
    expect(h.secretary.briefs()).toEqual({});
  });

  it("for an instance with no brief sends nothing", () => {
    const h = harness();
    h.secretary.start(true);
    const before = h.sentCount();
    h.fire("a", null);
    expect(h.sentCount()).toBe(before);
  });
});

describe("turning the mode on", () => {
  it("prepares a brief for every live event, at once", () => {
    const h = harness();
    h.live.push({ instanceId: "a", event: ev(5) }, { instanceId: "b", event: ev(6, "needs-you") });
    h.secretary.start(false);
    h.secretary.setMode(true);

    expect(h.modePushes()).toEqual([true]);
    expect(h.writes.map((w) => [w.instanceId, w.event.seq])).toEqual([
      ["a", 5],
      ["b", 6],
    ]);
    expect(h.secretary.briefs()).toEqual({
      a: { seq: 5, kind: "finished", status: "preparing" },
      b: { seq: 6, kind: "needs-you", status: "preparing" },
    });
  });

  it("at startup, with the mode saved on, prepares what is live", () => {
    const h = harness();
    h.live.push({ instanceId: "a", event: ev(1) });
    h.secretary.start(true);
    expect(h.secretary.isOn()).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it("again while on changes nothing", () => {
    const h = harness();
    h.live.push({ instanceId: "a", event: ev(1) });
    h.secretary.start(true);
    h.secretary.setMode(true);
    expect(h.writes).toHaveLength(1);
    expect(h.modePushes()).toEqual([true]);
  });
});

describe("turning the mode off", () => {
  it("aborts everything in flight, drops every brief, and ignores what comes back", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.fire("b", ev(2));
    h.writes[1].settle(brief("b is done"));
    await flush();
    const [writeA] = h.writes;
    const [speakB] = h.speaks;

    h.secretary.setMode(false);
    expect(writeA.signal.aborted).toBe(true);
    expect(speakB.signal.aborted).toBe(true);
    expect(h.pushes("a").at(-1)).toBeNull();
    expect(h.pushes("b").at(-1)).toBeNull();
    expect(h.modePushes()).toEqual([true, false]);
    expect(h.secretary.briefs()).toEqual({});

    const before = h.sentCount();
    writeA.settle(brief("late"));
    speakB.settle({ ok: true, wav: WAV });
    await flush();
    expect(h.sentCount()).toBe(before);
    expect(h.secretary.audioFor("b", 2)).toBeNull();

    // And stays off: new events start nothing.
    h.fire("c", ev(3));
    await flush();
    expect(h.writes).toHaveLength(2);
    expect(h.deps.synthesize).toHaveBeenCalledTimes(1);
  });
});

describe("audioFor", () => {
  it("returns null for a seq that is no longer the instance's brief", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("one"));
    await flush();
    h.speaks[0].settle({ ok: true, wav: WAV });
    await flush();
    expect(h.secretary.audioFor("a", 1)).toBe(WAV);
    expect(h.secretary.audioFor("a", 0)).toBeNull();
    expect(h.secretary.audioFor("b", 1)).toBeNull();

    h.fire("a", ev(2));
    expect(h.secretary.audioFor("a", 1)).toBeNull();
  });
});

describe("stop", () => {
  it("unsubscribes and aborts what is in flight", () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.secretary.stop();
    expect(h.subscribed()).toBe(false);
    expect(h.writes[0].signal.aborted).toBe(true);
    expect(h.secretary.briefs()).toEqual({});
  });
});

describe("the disk", () => {
  it("is never written: briefs and audio live in memory only", async () => {
    const h = harness();
    h.secretary.start(true);
    h.fire("a", ev(1));
    h.writes[0].settle(brief("one"));
    await flush();
    h.speaks[0].settle({ ok: true, wav: WAV });
    h.fire("b", ev(2, "needs-you"));
    h.writes[1].settle({ ok: false, reason: "timed out" });
    await flush();
    h.fire("a", null);
    h.secretary.setMode(false);
    h.secretary.setMode(true);
    h.secretary.stop();
    await flush();

    expect(disk.writes).toEqual([]);
  });
});
