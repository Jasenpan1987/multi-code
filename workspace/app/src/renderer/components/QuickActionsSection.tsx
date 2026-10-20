import { useState, useCallback } from "react";
import type { ReactNode } from "react";
import type { Instance } from "../../shared/types";
import { RenameSessionDialog } from "./RenameSessionDialog";

// How long OpenCode's slash menu is given to draw before the Enter that runs the
// command. The manager's run_command waits 120 ms; a quick action has nobody waiting
// on it, so a little more.
const SLASH_MENU_SETTLE_MS = 250;

interface QuickActionsSectionProps {
  instance: Instance;
  active: boolean;
}

interface QuickActionButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

function QuickActionButton({
  label,
  onClick,
  disabled,
  title,
}: QuickActionButtonProps): ReactNode {
  return (
    <button
      type="button"
      className="quick-action-btn"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </button>
  );
}

export function QuickActionsSection({
  instance,
  active,
}: QuickActionsSectionProps) {
  const [vsCodeError, setVsCodeError] = useState<string | null>(null);
  const [resumeCopied, setResumeCopied] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  const isRunning = instance.status === "running";
  const sessionId = instance.sessionId;
  const isOpencode = instance.backend === "opencode";

  const handleOpenVSCode = useCallback(async () => {
    setVsCodeError(null);
    const result = await window.electronAPI.openInVSCode(instance.cwd);
    if (!result.ok) {
      setVsCodeError(
        result.error === "not-found"
          ? "VS Code not found. Install `code` from VS Code menu (Cmd+Shift+P → 'Shell Command: Install code in PATH')."
          : result.error || "Failed to open VS Code."
      );
    }
  }, [instance.cwd]);

  // Claude runs a slash command typed with its Enter in one write. OpenCode 2's slash
  // menu takes that Enter and leaves the command in the box (T-611, B-1), so the Enter
  // follows once the menu has drawn, as the manager's run_command does.
  const sendSlash = useCallback(
    (cmd: string) => {
      if (instance.backend !== "opencode") {
        window.electronAPI.writeToInstance(instance.id, `${cmd}\r`);
        return;
      }
      window.electronAPI.writeToInstance(instance.id, cmd);
      setTimeout(() => window.electronAPI.writeToInstance(instance.id, "\r"), SLASH_MENU_SETTLE_MS);
    },
    [instance.id, instance.backend]
  );

  const handleResume = useCallback(async () => {
    if (!sessionId) return;
    // Ask the main process (which owns the backend modules) for the resume
    // command — claude and opencode differ, and the renderer stays backend-
    // agnostic rather than hardcoding the flag here.
    const command = await window.electronAPI.getResumeCommand(instance.id);
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setResumeCopied(true);
      setTimeout(() => setResumeCopied(false), 1500);
    } catch {
      // Silently fail; clipboard might be unavailable in some contexts.
    }
  }, [instance.id, sessionId]);

  // Rename the current CLI session. Our own dialog collects the name, and both
  // CLIs take it inline as `/rename <name>`, so it goes in one write. (OpenCode 2's
  // bare `/rename` would have its model make a title up instead.) The alias, our
  // contact display name edited from the context menu, is a separate thing: this
  // renames the agent's session itself.
  const handleRename = useCallback(
    (name: string) => {
      window.electronAPI.writeToInstance(instance.id, `/rename ${name}\r`);
      setRenameOpen(false);
    },
    [instance.id]
  );

  if (!active) return null;

  return (
    <div className="quick-actions">
      <QuickActionButton
        label="Go to Code Base"
        onClick={handleOpenVSCode}
      />
      {vsCodeError && <div className="quick-action-error">{vsCodeError}</div>}

      <QuickActionButton
        label="Show Cost"
        onClick={() => sendSlash("/cost")}
        disabled={!isRunning || isOpencode}
        title={
          isOpencode
            ? "OpenCode has no inline cost command; its /stats page shows usage"
            : isRunning
              ? undefined
              : "Instance is stopped"
        }
      />
      <QuickActionButton
        label="Clear"
        onClick={() => sendSlash("/clear")}
        disabled={!isRunning}
        title={isRunning ? undefined : "Instance is stopped"}
      />
      <QuickActionButton
        label="Compact"
        onClick={() => sendSlash("/compact")}
        disabled={!isRunning}
        title={isRunning ? undefined : "Instance is stopped"}
      />

      <QuickActionButton
        label={resumeCopied ? "Copied!" : "Resume Elsewhere"}
        onClick={handleResume}
        disabled={!sessionId}
        title={sessionId ? undefined : "Session not ready — wait a moment"}
      />

      <QuickActionButton
        label="Rename Session"
        onClick={() => setRenameOpen(true)}
        disabled={!isRunning}
        title={isRunning ? undefined : "Instance is stopped"}
      />

      <RenameSessionDialog
        open={renameOpen}
        title="Rename Session"
        label={`New name for the ${isOpencode ? "OpenCode" : "Claude Code"} session`}
        onClose={() => setRenameOpen(false)}
        onSubmit={handleRename}
      />
    </div>
  );
}
