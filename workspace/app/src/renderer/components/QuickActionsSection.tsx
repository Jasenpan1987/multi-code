import { useState, useCallback } from "react";
import type { ReactNode } from "react";
import type { Instance } from "../../shared/types";

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

  const isRunning = instance.status === "running";
  const sessionId = instance.sessionId;

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
    try {
      await navigator.clipboard.writeText(`claude --resume ${sessionId}`);
      setResumeCopied(true);
      setTimeout(() => setResumeCopied(false), 1500);
    } catch {
      // Silently fail; clipboard might be unavailable in some contexts.
    }
  }, [sessionId]);

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
        disabled={!isRunning}
        title={isRunning ? undefined : "Instance is stopped"}
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
    </div>
  );
}
