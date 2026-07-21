import { useState, useCallback } from "react";
import type { ReactNode } from "react";
import type { Instance } from "../../shared/types";
import { RenameSessionDialog } from "./RenameSessionDialog";

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

  const sendSlash = useCallback(
    (cmd: string) => {
      window.electronAPI.writeToInstance(instance.id, `${cmd}\r`);
    },
    [instance.id]
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

  // Rename the current CLI session. Our own dialog collects the name; how it
  // reaches the agent differs per backend because their `/rename` commands work
  // differently (this is the "our dialog, per-backend adapter" approach):
  //   - claude:   `/rename <name>` takes the name inline — send it in one shot.
  //   - opencode: `/rename` takes NO argument; it opens opencode's own inline
  //               rename dialog. So we send `/rename\r` to open that dialog,
  //               wait briefly for it to appear, then type the name + Enter.
  // The alias (our contact display name, edited via the context menu) is a
  // separate concept — this renames the agent's session itself.
  const handleRename = useCallback(
    (name: string) => {
      const write = (data: string) =>
        window.electronAPI.writeToInstance(instance.id, data);
      if (instance.backend === "opencode") {
        // Open opencode's rename dialog, then fill + submit once it's up.
        write("/rename\r");
        setTimeout(() => write(`${name}\r`), 250);
      } else {
        write(`/rename ${name}\r`);
      }
      setRenameOpen(false);
    },
    [instance.id, instance.backend]
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
            ? "OpenCode does not have an inline cost command"
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
        backendLabel={isOpencode ? "OpenCode" : "Claude Code"}
        onClose={() => setRenameOpen(false)}
        onSubmit={handleRename}
      />
    </div>
  );
}
