// First setup (mockup 5.1, PRD Story 10): paired, added to the Home Screen, and
// notifications on, each marked done or next. Shown while the phone isn't paired,
// right after a pairing, and from the list's ⚙, where it is also the settings:
// notifications off, and unpairing.
//
// The Home Screen app on iOS may keep storage of its own, apart from Safari's, and a
// scanned code always opens Safari (G-306). So Safari, once paired, offers its
// pairing link to copy (step 2), and the Home Screen app, unpaired, offers to paste
// it (step 1). Where the storage did carry over the app is already paired and skips
// this.

import { useContext, useEffect, useState, type ReactNode } from "react";
import type { PairingOffer } from "../../shared/remote-protocol";
import { isStandalone, macName } from "../format";
import { offerFromText, pairingLink, type StoredPairing } from "../pairing";
import { browserEnv, inFlight, pushItem, subscriptionOf, turnOff, turnOn, unpair } from "../push";
import { navigate } from "../routes";
import { StoreContext, useActions, useApp } from "../store";
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
  const [permission, refreshPermission] = usePermission();
  // In the Home Screen app, on means this app may show them too: a subscription the
  // Mac holds from elsewhere for this phone doesn't count.
  const notificationsOn = pushEnabled && (!standalone || permission === "granted");
  // A pairing the Mac no longer accepts is as good as none.
  const forgotten = connection.state === "refused" && connection.refused !== "version";
  const paired = pairing !== null && !forgotten;
  const mac = macName(connection.hostName);

  const done = [paired, standalone, notificationsOn];
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
          <p className="m">{next < 0 ? "All set. You can leave your desk." : "Three steps before you can leave your desk."}</p>

          <Step n={1} state={stateOf(0)} title={paired ? "Paired" : forgotten ? "Pair again" : "Pair"}>
            {paired
              ? "Scanned the code from Multi-Code on your Mac."
              : standalone
                ? "Paste the pairing link you copied in Safari, or the one from Multi-Code's Phone settings on your Mac."
                : "Scan the code in Multi-Code's Phone settings on your Mac with the Camera."}
          </Step>
          {!paired && standalone && <PasteFromClipboard />}
          {!paired && <PasteLink />}

          <Step n={2} state={stateOf(1)} title="Add to Home Screen">
            Tap <span className="share">⇪</span> at the bottom of Safari, then “Add to Home Screen”. Open
            Multi-Code from the new icon.
          </Step>
          {paired && !standalone && pairing && <CopyLink pairing={pairing} />}

          <Step n={3} state={stateOf(2)} title="Turn on notifications">
            Only works from the Home Screen icon. You’ll be told when a session finishes or needs you.
          </Step>
          <Notifications
            ready={standalone && paired}
            enabled={notificationsOn}
            permission={permission}
            refreshPermission={refreshPermission}
          />

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
          {pairing && <Unpair mac={mac} />}
        </div>
      </div>
    </div>
  );
}

// A pasted pairing link, or why it can't be used here.
function checkLink(text: string): { offer: PairingOffer } | { problem: string } {
  const offer = offerFromText(text);
  if (!offer) return { problem: "That isn't a pairing link from Multi-Code." };
  // The link dials this page's own origin, so a link for another address would be
  // saved and never connect.
  if (offer.origin !== location.origin) return { problem: `That link is for ${hostOf(offer.origin)}. Open it there.` };
  return { offer };
}

// For a phone that can't scan its way here: the Home Screen app, which on iOS keeps
// storage of its own and isn't where a scanned code opens.
function PasteLink() {
  const actions = useActions();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const pair = () => {
    const checked = checkLink(text);
    if ("problem" in checked) {
      setProblem(checked.problem);
      return;
    }
    setProblem(null);
    actions.pair(checked.offer);
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

// The hand-off's second half, in the Home Screen app: one tap reads the link Safari
// copied (iOS shows its Paste bubble), pairs, and empties the clipboard, which held
// the device token.
function PasteFromClipboard() {
  const actions = useActions();
  const [problem, setProblem] = useState<string | null>(null);
  if (typeof navigator.clipboard?.readText !== "function") return null;
  const paste = async () => {
    setProblem(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setProblem("Couldn't read the clipboard. Paste the link below instead.");
      return;
    }
    if (!text.trim()) {
      setProblem("The clipboard is empty. Copy the pairing link in Safari first.");
      return;
    }
    const checked = checkLink(text);
    if ("problem" in checked) {
      setProblem(checked.problem);
      return;
    }
    actions.pair(checked.offer);
    navigate({ screen: "setup" }, { replace: true });
    navigator.clipboard.writeText("").catch(() => {});
  };
  return (
    <div className="handoff">
      <button className="btn primary block" onClick={() => void paste()}>
        Paste pairing link
      </button>
      {problem && <p className="bad">{problem}</p>}
    </div>
  );
}

// The hand-off's first half, in Safari once paired: the pairing link, rebuilt from
// what was saved, for the Home Screen app to paste.
function CopyLink({ pairing }: { pairing: StoredPairing }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  if (typeof navigator.clipboard?.writeText !== "function") return null;
  const copy = () => {
    navigator.clipboard.writeText(pairingLink(pairing)).then(
      () => setCopied("yes"),
      () => setCopied("failed")
    );
  };
  return (
    <div className="handoff">
      <button className="btn block" onClick={copy}>
        {copied === "yes" ? "Copied ✓" : "Copy pairing link"}
      </button>
      <p className={copied === "failed" ? "bad" : "m small"}>
        {copied === "failed"
          ? "Couldn't copy it. Paste the link from your Mac's Phone settings instead."
          : "The new icon may open unpaired: copy this first, then tap “Paste pairing link” there."}
      </p>
    </div>
  );
}

// Notification permission as it is now, read again when the app comes back (from
// iOS Settings, say) and after asking.
function usePermission(): [NotificationPermission | null, () => void] {
  const [permission, setPermission] = useState(browserEnv.permission);
  useEffect(() => {
    const update = () => setPermission(browserEnv.permission());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return [permission, () => setPermission(browserEnv.permission())];
}

// Step 3's button and what became of it; once on, the place to turn them off.
// `ready`: the Home Screen app, paired. Elsewhere the button stays disabled (step 2
// says why).
function Notifications({
  ready,
  enabled,
  permission,
  refreshPermission,
}: {
  ready: boolean;
  enabled: boolean;
  permission: NotificationPermission | null;
  refreshPermission: () => void;
}) {
  const store = useContext(StoreContext)!;
  const push = useApp((s) => s.push);
  const item = useApp((s) => pushItem(s.outbox));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const on = async () => {
    setBusy(true);
    setProblem(null);
    const result = await turnOn(store);
    refreshPermission();
    setBusy(false);
    if (!result.ok && result.message) setProblem(`Couldn't turn them on: ${result.message}`);
  };
  const off = async () => {
    setBusy(true);
    setProblem(null);
    await turnOff(store);
    setBusy(false);
  };

  let button: { label: string; kind: "primary" | "ghost"; action?: () => Promise<void> };
  let note: string | null = null;
  let bad = false;
  const pending = inFlight(item) ? item : null;

  if (!ready) {
    button = { label: enabled ? "Notifications are on" : "Turn on notifications", kind: "primary" };
  } else if (permission === null) {
    button = { label: "Turn on notifications", kind: "primary" };
    note = "This iPhone can't get notifications from a web app. They need iOS 16.4 or later.";
  } else if (!push) {
    button = { label: "Turn on notifications", kind: "primary" };
    note = "Waiting for your Mac…";
  } else if (push.vapidPublicKey === "") {
    button = { label: "Turn on notifications", kind: "primary" };
    note = "Your Mac can't send notifications right now. Its Phone settings say why.";
  } else if (busy || pending) {
    const turningOff = pending ? subscriptionOf(pending) === null : enabled;
    button = { label: turningOff ? "Turning off…" : "Turning on…", kind: turningOff ? "ghost" : "primary" };
    if (pending?.status === "waiting") note = "Waiting for your Mac…";
  } else {
    button = enabled
      ? { label: "Turn off notifications", kind: "ghost", action: off }
      : { label: "Turn on notifications", kind: "primary", action: on };
    if (problem) {
      note = problem;
      bad = true;
    } else if (item?.status === "refused") {
      note = `Your Mac couldn't turn them ${subscriptionOf(item) ? "on" : "off"}: ${item.refusal?.message ?? "it said no"}.`;
      bad = true;
    } else if (!enabled && permission === "denied") {
      note = "Notifications are blocked for Multi-Code. Allow them in Settings › Notifications › Multi-Code, then tap again.";
    }
  }

  const { label, kind, action } = button;
  return (
    <>
      <button
        className={`btn ${kind} block`}
        data-push={enabled ? "on" : "off"}
        disabled={!action}
        onClick={action ? () => void action() : undefined}
      >
        {label}
      </button>
      {note && <p className={bad ? "bad" : "m small"}>{note}</p>}
    </>
  );
}

// Forgets the Mac on this phone, after a second tap. The Mac still knows the phone
// until it is revoked there, which the note says.
function Unpair({ mac }: { mac: string }) {
  const store = useContext(StoreContext)!;
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className="btn ghost block unpair" onClick={() => setAsking(true)}>
        Unpair from {mac}
      </button>
    );
  }
  return (
    <div className="confirm">
      <p>
        Forget {mac} on this phone? Its sessions and notifications stop here. To cut the phone off for good, revoke it
        in Multi-Code’s Phone settings on the Mac.
      </p>
      <div className="row">
        <button className="btn ghost" onClick={() => setAsking(false)}>
          Cancel
        </button>
        <button className="btn danger" onClick={() => void unpair(store)}>
          Unpair
        </button>
      </div>
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
