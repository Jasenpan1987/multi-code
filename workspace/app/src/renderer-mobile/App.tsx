// The phone client. Three screens: pair, instance list, instance detail.
//
// The detail screen is the point of the whole feature. It shows, in priority
// order: the structured prompt (buttons you can tap), a free-text answer box,
// and the live terminal. The buttons are the fast path; the terminal is the
// fallback that keeps working even if a CLI update changes its option boxes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RemoteTransport, type ConnectionState } from "./transport";
import {
  clearPairing,
  getDeviceName,
  loadPairing,
  pairingFromLocation,
  pairingFromText,
  savePairing,
} from "./pairing";
import { TerminalPane } from "./TerminalPane";
import type {
  PromptOption,
  RemoteInstance,
  ServerFrame,
  StoredPairing,
  TranscriptEntry,
} from "./types";

interface ActivePrompt {
  tool: string;
  question?: string;
  options: PromptOption[];
}

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  connected: "Connected",
  "auth-failed": "Not authorized",
  disconnected: "Reconnecting…",
};

export function App() {
  const [pairing, setPairing] = useState<StoredPairing | null>(() => {
    // A fresh QR in the URL always wins over a stored pairing, so re-scanning
    // is how you recover from a revoked device or a re-keyed desktop.
    const fromUrl = pairingFromLocation();
    if (fromUrl) {
      savePairing(fromUrl);
      // Strip the token out of the address bar so it doesn't sit in history.
      history.replaceState(null, "", window.location.pathname);
      return {
        endpoints: fromUrl.endpoints,
        hostPublicKey: fromUrl.hostPublicKey,
        deviceToken: fromUrl.deviceToken,
        hostName: fromUrl.hostName,
      };
    }
    return loadPairing();
  });

  const [state, setState] = useState<ConnectionState>("idle");
  const [instances, setInstances] = useState<RemoteInstance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Map<string, ActivePrompt>>(new Map());
  const [attention, setAttention] = useState<Set<string>>(new Set());
  const [transcripts, setTranscripts] = useState<Map<string, TranscriptEntry[]>>(
    new Map()
  );
  const [errorToast, setErrorToast] = useState<string | null>(null);

  const transportRef = useRef<RemoteTransport | null>(null);
  // Terminal writes bypass React: the pane subscribes to this ref and consumes
  // chunks directly, so a fast-scrolling agent doesn't cause a re-render per byte.
  const writeRef = useRef<((data: string, reset?: boolean) => void) | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const handleFrame = useCallback((frame: ServerFrame) => {
    switch (frame.type) {
      case "instances":
        setInstances(frame.instances);
        return;

      case "snapshot":
        if (frame.instanceId === selectedIdRef.current) {
          writeRef.current?.(frame.data, true);
        }
        return;

      case "output":
        if (frame.instanceId === selectedIdRef.current) {
          writeRef.current?.(frame.data);
        }
        return;

      case "activity":
        setAttention((prev) => {
          const next = new Set(prev);
          next.add(frame.instanceId);
          return next;
        });
        // Vibrate when the agent needs something. This is the payoff of the
        // whole feature: the phone taps your leg instead of you checking the
        // desktop. Guarded because iOS Safari has no Vibration API.
        if (typeof navigator.vibrate === "function") {
          navigator.vibrate(frame.activity === "prompt" ? [80, 60, 80] : 60);
        }
        return;

      case "transcript":
        setTranscripts((prev) => {
          const next = new Map(prev);
          next.set(frame.instanceId, frame.entries);
          return next;
        });
        return;

      case "prompt-state":
        setPrompts((prev) => {
          const next = new Map(prev);
          next.set(frame.instanceId, {
            tool: frame.tool,
            question: frame.question,
            options: frame.options,
          });
          return next;
        });
        return;

      case "prompt-cleared":
        setPrompts((prev) => {
          if (!prev.has(frame.instanceId)) return prev;
          const next = new Map(prev);
          next.delete(frame.instanceId);
          return next;
        });
        return;

      case "exit":
        setPrompts((prev) => {
          if (!prev.has(frame.instanceId)) return prev;
          const next = new Map(prev);
          next.delete(frame.instanceId);
          return next;
        });
        return;

      case "error":
        setErrorToast(frame.message);
        return;

      default:
        return;
    }
  }, []);

  // One transport for the lifetime of a pairing.
  useEffect(() => {
    if (!pairing) return;

    const transport = new RemoteTransport(pairing, getDeviceName(), {
      onState: (next) => setState(next),
      onFrame: handleFrame,
    });
    transportRef.current = transport;
    transport.start();

    return () => {
      transport.stop();
      transportRef.current = null;
    };
  }, [pairing, handleFrame]);

  // Re-subscribe on (re)connect as well as on selection change: after a
  // reconnect the desktop has no memory of what this socket was watching.
  useEffect(() => {
    if (state !== "connected" || !selectedId) return;
    transportRef.current?.send({ type: "subscribe", instanceId: selectedId });
    return () => {
      transportRef.current?.send({ type: "unsubscribe", instanceId: selectedId });
    };
  }, [state, selectedId]);

  useEffect(() => {
    if (!errorToast) return;
    const timer = setTimeout(() => setErrorToast(null), 4000);
    return () => clearTimeout(timer);
  }, [errorToast]);

  const selected = useMemo(
    () => instances.find((i) => i.id === selectedId) ?? null,
    [instances, selectedId]
  );
  const activePrompt = selectedId ? prompts.get(selectedId) : undefined;

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setAttention((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleChoose = (index: number) => {
    if (!selectedId) return;
    transportRef.current?.send({
      type: "choose",
      instanceId: selectedId,
      optionIndex: index,
    });
  };

  const handleSendPrompt = (text: string) => {
    if (!selectedId || !text.trim()) return;
    transportRef.current?.send({
      type: "prompt",
      instanceId: selectedId,
      text,
    });
  };

  const handleUnpair = () => {
    clearPairing();
    transportRef.current?.stop();
    setPairing(null);
    setInstances([]);
    setSelectedId(null);
  };

  if (!pairing) {
    return <PairScreen onPaired={setPairing} />;
  }

  if (state === "auth-failed") {
    return (
      <div className="m-screen m-center">
        <h1 className="m-title">Not authorized</h1>
        <p className="m-muted">
          This device was removed from {pairing.hostName}, or the desktop
          regenerated its keys. Scan a new pairing code to reconnect.
        </p>
        <button className="m-btn m-btn-primary" onClick={handleUnpair}>
          Pair again
        </button>
      </div>
    );
  }

  return (
    <div className="m-app">
      <header className="m-header">
        {selected ? (
          <button
            className="m-back"
            onClick={() => setSelectedId(null)}
            aria-label="Back to list"
          >
            ‹
          </button>
        ) : null}
        <div className="m-header-text">
          <div className="m-header-title">
            {selected ? selected.name : pairing.hostName}
          </div>
          <div className="m-header-sub" data-state={state}>
            {STATE_LABEL[state]}
          </div>
        </div>
        {!selected ? (
          <button className="m-unpair" onClick={handleUnpair}>
            Unpair
          </button>
        ) : null}
      </header>

      {selected ? (
        <InstanceDetail
          instance={selected}
          prompt={activePrompt}
          transcript={transcripts.get(selected.id) ?? []}
          onChoose={handleChoose}
          onSend={handleSendPrompt}
          registerWrite={(fn) => {
            writeRef.current = fn;
          }}
        />
      ) : (
        <InstanceList
          instances={instances}
          attention={attention}
          onSelect={handleSelect}
          connected={state === "connected"}
        />
      )}

      {errorToast ? <div className="m-toast">{errorToast}</div> : null}
    </div>
  );
}

function PairScreen({
  onPaired,
}: {
  onPaired: (pairing: StoredPairing) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const offer = pairingFromText(text);
    if (!offer) {
      setError("That doesn't look like a valid pairing code.");
      return;
    }
    savePairing(offer);
    onPaired({
      endpoints: offer.endpoints,
      hostPublicKey: offer.hostPublicKey,
      deviceToken: offer.deviceToken,
      hostName: offer.hostName,
    });
  };

  return (
    <div className="m-screen m-center">
      <h1 className="m-title">Multi-Code</h1>
      <p className="m-muted">
        On your desktop, open the <strong>Phone</strong> section in the toolbox
        and scan the QR code with your camera. If you got here another way, paste
        the pairing code below.
      </p>
      <textarea
        className="m-input m-textarea"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        placeholder="Paste pairing code"
        rows={4}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {error ? <div className="m-error">{error}</div> : null}
      <button className="m-btn m-btn-primary" onClick={submit}>
        Connect
      </button>
    </div>
  );
}

function InstanceList({
  instances,
  attention,
  onSelect,
  connected,
}: {
  instances: RemoteInstance[];
  attention: Set<string>;
  onSelect: (id: string) => void;
  connected: boolean;
}) {
  if (!connected && instances.length === 0) {
    return (
      <div className="m-screen m-center">
        <div className="m-spinner" />
        <p className="m-muted">Looking for your desktop…</p>
      </div>
    );
  }

  if (instances.length === 0) {
    return (
      <div className="m-screen m-center">
        <p className="m-muted">No instances yet.</p>
      </div>
    );
  }

  return (
    <ul className="m-list">
      {instances.map((instance) => (
        <li key={instance.id}>
          <button className="m-row" onClick={() => onSelect(instance.id)}>
            <span
              className="m-dot"
              data-status={instance.status}
              aria-hidden="true"
            />
            <span className="m-row-text">
              <span className="m-row-name">
                {instance.name}
                {/* `activity` comes from the desktop, so a badge survives
                    reopening the app; `attention` covers events that arrived
                    while this screen was already open. Without the former, a
                    relaunched phone showed a clean list even with an agent
                    blocked. */}
                {instance.activity || attention.has(instance.id) ? (
                  <span
                    className="m-badge"
                    data-kind={instance.activity ?? "waiting"}
                    aria-label={
                      instance.activity === "prompt"
                        ? "Waiting for your answer"
                        : "Needs attention"
                    }
                  >
                    {instance.activity === "prompt" ? "?" : "!"}
                  </span>
                ) : null}
              </span>
              <span className="m-row-sub">{instance.cwd}</span>
            </span>
            <span className="m-row-backend">{instance.backend}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Human labels for the tools each backend reports, so the transcript reads as
// prose instead of as API names. Unlisted tools fall back to their own name.
const TOOL_VERBS: Record<string, string> = {
  Bash: "Ran",
  bash: "Ran",
  Read: "Read",
  read: "Read",
  Write: "Wrote",
  write: "Wrote",
  Edit: "Edited",
  edit: "Edited",
  apply_patch: "Edited",
  Grep: "Searched",
  grep: "Searched",
  Glob: "Globbed",
  glob: "Globbed",
  WebFetch: "Fetched",
  webfetch: "Fetched",
  Task: "Delegated",
  task: "Delegated",
  TodoWrite: "Updated todos",
  todowrite: "Updated todos",
};

function toolVerb(tool: string): string {
  return TOOL_VERBS[tool] ?? tool;
}

// The readable view of what the agent is doing, rendered from the CLI's own
// structured record rather than from terminal paint — so it wraps to the screen.
function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest entry in view; that's the one worth reading.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="m-transcript m-transcript-empty">
        <p className="m-muted">
          Nothing to show yet. Once the agent starts working, its progress
          appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="m-transcript">
      {entries.map((entry, index) => {
        if (entry.kind === "tool") {
          return (
            <div
              key={index}
              className="m-entry m-entry-tool"
              data-pending={entry.pending ? "true" : undefined}
            >
              <span className="m-entry-verb">{toolVerb(entry.tool ?? "")}</span>
              {entry.text ? (
                <span className="m-entry-target">{entry.text}</span>
              ) : null}
            </div>
          );
        }
        return (
          <div key={index} className={`m-entry m-entry-${entry.kind}`}>
            {entry.text}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function InstanceDetail({
  instance,
  prompt,
  transcript,
  onChoose,
  onSend,
  registerWrite,
}: {
  instance: RemoteInstance;
  prompt?: ActivePrompt;
  transcript: TranscriptEntry[];
  onChoose: (index: number) => void;
  onSend: (text: string) => void;
  registerWrite: (fn: (data: string, reset?: boolean) => void) => void;
}) {
  const [draft, setDraft] = useState("");
  const [showTerminal, setShowTerminal] = useState(false);

  // A newly arrived prompt should be visible without scrolling, so collapse the
  // terminal when one shows up.
  useEffect(() => {
    if (prompt) setShowTerminal(false);
  }, [prompt]);

  const send = () => {
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  // Multi-select boxes can't be answered by tapping one option: the CLI wants
  // each choice toggled and then a separate confirm step. Show them read-only
  // with a note, rather than buttons that would half-answer and strand the agent.
  const readOnlyOptions = prompt?.tool === "Question (multi-select)";

  return (
    <div className="m-detail">
      {prompt ? (
        <section className="m-prompt">
          <div className="m-prompt-tool">{prompt.tool}</div>
          {prompt.question ? (
            <div className="m-prompt-question">{prompt.question}</div>
          ) : null}
          {readOnlyOptions ? (
            <div className="m-prompt-note">
              This one takes several answers, so it can’t be tapped from here.
              Type your reply below, or use the terminal.
            </div>
          ) : null}
          <div className="m-prompt-options" data-readonly={readOnlyOptions || undefined}>
            {prompt.options.map((option, index) => (
              <button
                key={`${option.label}-${index}`}
                className="m-option"
                onClick={() => onChoose(index)}
                disabled={readOnlyOptions}
              >
                <span className="m-option-index">{index + 1}</span>
                <span className="m-option-text">
                  <span className="m-option-label">{option.label}</span>
                  {option.description ? (
                    <span className="m-option-desc">{option.description}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* Shown even while a prompt is up: deciding whether to allow something
          depends on what led to it. The terminal below stays collapsed because a
          120-column TUI can't reflow onto a phone. */}
      <Transcript entries={transcript} />

      <section className="m-compose">
        <textarea
          className="m-input m-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            instance.status === "running"
              ? "Reply to the agent…"
              : "This instance is offline"
          }
          rows={3}
          disabled={instance.status !== "running"}
        />
        <button
          className="m-btn m-btn-primary"
          onClick={send}
          disabled={instance.status !== "running" || !draft.trim()}
        >
          Send
        </button>
      </section>

      <button
        className="m-disclosure"
        onClick={() => setShowTerminal((v) => !v)}
        aria-expanded={showTerminal}
      >
        {showTerminal ? "▾" : "▸"} Terminal
      </button>

      {/* Kept mounted once opened so the replayed snapshot isn't lost on toggle. */}
      <TerminalPane
        key={instance.id}
        visible={showTerminal}
        registerWrite={registerWrite}
      />
    </div>
  );
}
