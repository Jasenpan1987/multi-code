// Toolbox section for the voice secretary: the Secretary Mode switch, and the
// speech server it speaks through.
//
// App-wide rather than per-instance, like the Phone section: the mode applies to
// every session, and there is one speech server.
//
// The speech key never comes back from main, only whether one is saved. So the key
// field only ever holds a key being typed: it starts empty, its placeholder says
// "set" or "not set", and it empties again once the key is saved. Left empty, it
// sends "unchanged", so saving a new address can't wipe the key.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { SecretarySettings } from "../../shared/types";
import { ipcErrorMessage, speechTestLine } from "./secretaryText";
import type { SpeechTestLine } from "./secretaryText";

interface SecretarySectionProps {
  active: boolean;
}

type ServerAction = "save" | "test" | "clear";

export function SecretarySection({ active }: SecretarySectionProps) {
  const [saved, setSaved] = useState<SecretarySettings | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [modeBusy, setModeBusy] = useState(false);
  const [serverBusy, setServerBusy] = useState<ServerAction | null>(null);
  const [testLine, setTestLine] = useState<SpeechTestLine | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-read on every expand; drafts start over from what is saved.
  useEffect(() => {
    if (!active) return;
    void window.electronAPI.getSecretarySettings().then((next) => {
      setSaved(next);
      setUrlDraft(next.speechServerUrl);
      setKeyDraft("");
    });
  }, [active]);

  if (!active) return null;

  const dirty =
    saved !== null &&
    (urlDraft.trim() !== saved.speechServerUrl || keyDraft.trim() !== "");
  const busy = serverBusy !== null;

  // Edits make the last test result about settings that are no longer shown.
  const edit = (apply: () => void) => {
    apply();
    setTestLine(null);
    setError(null);
  };

  const applySaved = (next: SecretarySettings) => {
    setSaved(next);
    setUrlDraft(next.speechServerUrl);
    setKeyDraft("");
  };

  const toggleMode = async () => {
    if (!saved) return;
    setModeBusy(true);
    setError(null);
    try {
      const next = await window.electronAPI.setSecretaryMode(!saved.secretaryMode);
      // Only the mode: an address being typed stays as it is.
      setSaved(next);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setModeBusy(false);
    }
  };

  // Resolves false when main refused the change; the error line then says why.
  const saveServer = async (): Promise<boolean> => {
    const key = keyDraft.trim();
    try {
      applySaved(
        await window.electronAPI.setSpeechServer(
          urlDraft,
          key ? { kind: "set", key } : { kind: "unchanged" }
        )
      );
      return true;
    } catch (err) {
      setError(ipcErrorMessage(err));
      return false;
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!dirty || busy) return;
    setServerBusy("save");
    setTestLine(null);
    setError(null);
    try {
      await saveServer();
    } finally {
      setServerBusy(null);
    }
  };

  // Main tests what is saved, so pending edits are saved first: the result is
  // then about the fields as they read.
  const test = async () => {
    if (busy) return;
    setServerBusy("test");
    setTestLine(null);
    setError(null);
    try {
      if (dirty && !(await saveServer())) return;
      setTestLine(speechTestLine(await window.electronAPI.testSpeechServer()));
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setServerBusy(null);
    }
  };

  // Takes effect at once and touches only the key: the saved address goes back
  // unchanged, and an address being typed stays in its field.
  const clearKey = async () => {
    if (!saved || busy) return;
    setServerBusy("clear");
    setTestLine(null);
    setError(null);
    try {
      const next = await window.electronAPI.setSpeechServer(saved.speechServerUrl, {
        kind: "clear",
      });
      setSaved(next);
      setKeyDraft("");
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setServerBusy(null);
    }
  };

  const modeOn = saved?.secretaryMode === true;
  const textOnly = saved !== null && saved.speechServerUrl === "";

  return (
    <div className="secretary-section">
      <div className="secretary-row">
        <button
          type="button"
          className="secretary-toggle"
          onClick={toggleMode}
          disabled={modeBusy || !saved}
          data-on={modeOn ? "true" : "false"}
        >
          {modeOn ? "Secretary Mode: ON" : "Secretary Mode: OFF"}
        </button>
        {textOnly ? <span className="secretary-tag">text only</span> : null}
      </div>

      <div className="secretary-hint">
        {modeOn
          ? "On for every session. Clicking a contact with a red dot plays its brief."
          : "Turn on before you step away. Clicking a contact with a red dot then plays that session's brief. Applies to every session."}
      </div>

      <form className="secretary-server" onSubmit={save}>
        <div className="secretary-server-title">Speech server</div>
        <div className="secretary-fields">
          <label className="secretary-label" htmlFor="secretary-url">
            Address
          </label>
          <input
            id="secretary-url"
            className="secretary-input"
            type="text"
            value={urlDraft}
            placeholder="none, text only"
            spellCheck={false}
            autoComplete="off"
            disabled={!saved || busy}
            onChange={(e) => edit(() => setUrlDraft(e.target.value))}
          />
          <span />

          <label className="secretary-label" htmlFor="secretary-key">
            Key
          </label>
          <input
            id="secretary-key"
            className="secretary-input"
            type="password"
            value={keyDraft}
            placeholder={
              saved?.hasSpeechKey ? "set, type a new one to replace it" : "not set"
            }
            spellCheck={false}
            autoComplete="off"
            disabled={!saved || busy}
            onChange={(e) => edit(() => setKeyDraft(e.target.value))}
          />
          {saved?.hasSpeechKey ? (
            <button
              type="button"
              className="secretary-clear"
              onClick={clearKey}
              disabled={busy}
              title="Delete the saved key"
            >
              Clear
            </button>
          ) : (
            <span />
          )}
        </div>

        <div className="secretary-row">
          <button type="submit" className="secretary-btn" disabled={!dirty || busy}>
            {serverBusy === "save" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="secretary-btn"
            onClick={test}
            disabled={!saved || busy}
          >
            {serverBusy === "test" ? "Testing…" : dirty ? "Save & test" : "Test"}
          </button>
          {testLine ? (
            <span className="secretary-test-line" data-tone={testLine.tone}>
              {testLine.text}
            </span>
          ) : null}
        </div>
      </form>

      {error ? <div className="secretary-error">{error}</div> : null}
    </div>
  );
}
