import { useEffect, useRef, useState } from "react";
import { sendComposed } from "./composeSend";

interface ComposeBoxProps {
  instanceId: string;
  // Close the box and return keyboard focus to the terminal. Called after a
  // send, on Esc, and is also what App wires to the close button.
  onClose: () => void;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * The compose box: a hotkey-summoned overlay anchored at the bottom of the
 * active terminal for drafting a message to a claude instance. Shows every
 * character (unlike the folded TUI input), supports mouse editing, multi-line
 * text, and pasted-image attachments referenced via `@<path>` on send.
 *
 * Mounted with `key={instanceId}` by App so switching instances unmounts and
 * remounts it — which discards the draft and (via the unmount cleanup) deletes
 * any attached temp images. See Story 5 / T-005.
 */
export function ComposeBox({ instanceId, onClose }: ComposeBoxProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Tracks whether a send happened. On send the temp images must SURVIVE so
  // the CLI can read them while processing the turn (G7); on cancel / instance
  // switch they must be cleaned up. The unmount-cleanup effect reads this ref.
  const sentRef = useRef(false);
  // Keep the latest attached paths reachable from the unmount cleanup without
  // re-subscribing the effect on every change.
  const imagesRef = useRef<string[]>([]);
  imagesRef.current = images;

  // Focus the textarea when the box opens.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-grow the textarea up to a max height, scrolling past that.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // On unmount (Esc, instance switch, app close): clean up temp images unless
  // the draft was sent. This is the cleanup hook T-005 wires to instance switch.
  useEffect(() => {
    return () => {
      if (sentRef.current) return;
      for (const path of imagesRef.current) {
        void window.electronAPI.deleteTempImage(path);
      }
    };
  }, []);

  const isEmpty = text.trim() === "" && images.length === 0;

  const handleSend = () => {
    if (isEmpty) return; // empty content is a no-op; box stays open
    sentRef.current = true; // temp images must survive the send
    sendComposed(instanceId, text, images);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // Enter sends; Shift+Enter falls through to insert a newline.
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Only intercept when the clipboard carries an image; plain text falls
    // through to the textarea's native paste.
    const hasImage = Array.from(e.clipboardData.items).some((item) =>
      item.type.startsWith("image/")
    );
    if (!hasImage) return;

    e.preventDefault();
    void window.electronAPI.saveClipboardImage().then((path) => {
      // Graceful no-op if the clipboard had no image after all.
      if (path) setImages((prev) => [...prev, path]);
    });
  };

  const handleRemoveImage = (path: string) => {
    setImages((prev) => prev.filter((p) => p !== path));
    void window.electronAPI.deleteTempImage(path);
  };

  return (
    <div className="compose-box" onClick={(e) => e.stopPropagation()}>
      {images.length > 0 && (
        <div className="compose-chips">
          {images.map((path) => (
            <span key={path} className="compose-chip" title={path}>
              <span className="compose-chip-name">🖼 {basename(path)}</span>
              <button
                className="compose-chip-remove"
                onClick={() => handleRemoveImage(path)}
                aria-label="Remove image"
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="compose-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="Type a message…"
        rows={2}
        spellCheck={false}
      />
      <div className="compose-hint">
        Enter to send · Shift+Enter newline · Esc cancel
      </div>
    </div>
  );
}
