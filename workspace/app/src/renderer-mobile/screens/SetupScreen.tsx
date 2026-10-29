// First setup (mockup 5.1, PRD Story 10): paired, added to the Home Screen, and
// notifications on, each marked done or next. Shown while the phone isn't paired,
// right after a pairing, and from the list's ⚙.

import { useState, type ReactNode } from "react";
import { isStandalone, macName } from "../format";
import { offerFromText } from "../pairing";
import { navigate } from "../routes";
import { useActions, useApp } from "../store";
import "./setup.css";

type StepState = "done" | "next" | "later";

function Step({ n, state, title, children }: { n: number; state: StepState; title: string; children: ReactNode }) {
  return (
    <div className="step" data-state={state}>
      <span className={`n ${state === "done" ? "ok" : state === "next" ? "cur" : ""}`}>{state === "done" ? "✓" : n}</span>
      <div className="st">
        <b>{title}</b>
        <span>{children}</span>
      </div>
    </div>
  );
}

export function SetupScreen() {
  const pairing = useApp((s) => s.pairing);
  const connection = useApp((s) => s.connection);
  const pushEnabled = useApp((s) => s.push?.enabled === true);
  const standalone = isStandalone();
  // A pairing the Mac no longer accepts is as good as none.
  const forgotten = connection.state === "refused" && connection.refused !== "version";
  const paired = pairing !== null && !forgotten;
  const mac = macName(connection.hostName);

  const done = [paired, standalone, pushEnabled];
  const next = done.indexOf(false);
  const stateOf = (i: number): StepState => (done[i] ? "done" : i === next ? "next" : "later");

  const title = !paired
    ? "Pair with your Mac"
    : connection.state === "connected"
      ? `Connected to ${mac}`
      : `Paired with ${mac}`;

  return (
    <div className="screen setup-screen">
      <div className="screen-body">
        <div className="setup">
          <img className="logo" src="icons/icon-180.png" alt="" />
          <h1>{title}</h1>
          <p className="m">Three steps before you can leave your desk.</p>

          <Step n={1} state={stateOf(0)} title={paired ? "Paired" : forgotten ? "Pair again" : "Pair"}>
            {paired
              ? "Scanned the code from Multi-Code on your Mac."
              : standalone
                ? "Paste the pairing link from Multi-Code's Phone settings on your Mac."
                : "Scan the code in Multi-Code's Phone settings on your Mac with the Camera."}
          </Step>
          {!paired && <PasteLink />}

          <Step n={2} state={stateOf(1)} title="Add to Home Screen">
            Tap <span className="share">⇪</span> at the bottom of Safari, then “Add to Home Screen”. Open
            Multi-Code from the new icon.
          </Step>

          <Step n={3} state={stateOf(2)} title="Turn on notifications">
            Only works from the Home Screen icon. You’ll be told when a session finishes or needs you.
          </Step>
          {/* mobile-v2 T-811: asks for permission, subscribes and sends push-subscribe. */}
          <button className="btn primary block" disabled={!standalone || !paired || pushEnabled}>
            {pushEnabled ? "Notifications are on" : "Turn on notifications"}
          </button>

          {pairing && (
            <p className="m small">
              {hostOf(pairing.origin)} · reachable only inside your tailnet
            </p>
          )}
          {paired && (
            <button className="btn ghost block" onClick={() => navigate({ screen: "list" })}>
              Sessions ›
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// For a phone that can't scan its way here: the Home Screen app, which on iOS keeps
// storage of its own and isn't where a scanned code opens.
function PasteLink() {
  const actions = useActions();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const pair = () => {
    const offer = offerFromText(text);
    if (!offer) {
      setProblem("That isn't a pairing link from Multi-Code.");
      return;
    }
    // The link dials this page's own origin, so a link for another address would
    // be saved and never connect.
    if (offer.origin !== location.origin) {
      setProblem(`That link is for ${hostOf(offer.origin)}. Open it there.`);
      return;
    }
    setProblem(null);
    actions.pair(offer);
    // As a scanned code does: on to the next step.
    navigate({ screen: "setup" }, { replace: true });
  };
  return (
    <div className="paste">
      <input
        type="url"
        value={text}
        placeholder="Or paste the pairing link"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setProblem(null);
        }}
      />
      <button className="btn" disabled={!text.trim()} onClick={pair}>
        Pair
      </button>
      {problem && <p className="bad">{problem}</p>}
    </div>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
