import { useRef, useCallback } from "react";

// Unread alerts per instance: one for each finished turn or dialog, with a burst
// inside the debounce counting once. Acknowledging the instance at the desk clears
// them, and so does reading it on a paired phone.
export function useNotifications() {
  const unreadRef = useRef(new Map<string, number>());
  const debounceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const publish = useCallback(() => {
    // Dispatch event for UI to update (badge + blink only, no system notification)
    window.dispatchEvent(
      new CustomEvent("unread-update", {
        detail: { unread: new Map(unreadRef.current) },
      })
    );
  }, []);

  const notify = useCallback(
    (instanceId: string, _instanceName: string) => {
      // Debounce: wait 500ms of silence before notifying
      const existing = debounceTimers.current.get(instanceId);
      if (existing) clearTimeout(existing);

      debounceTimers.current.set(
        instanceId,
        setTimeout(() => {
          unreadRef.current.set(
            instanceId,
            (unreadRef.current.get(instanceId) ?? 0) + 1
          );
          publish();
          debounceTimers.current.delete(instanceId);
        }, 500)
      );
    },
    [publish]
  );

  // Drop the instance's count and any alert still inside the debounce, saying
  // whether there was either. Every key press on the shown instance lands here, so
  // only a real change re-renders the app.
  const clear = useCallback(
    (instanceId: string): boolean => {
      const pending = debounceTimers.current.get(instanceId);
      if (pending) {
        clearTimeout(pending);
        debounceTimers.current.delete(instanceId);
      }
      const hadUnread = unreadRef.current.delete(instanceId);
      if (hadUnread) publish();
      return !!pending || hadUnread;
    },
    [publish]
  );

  // Read at the desk: only a real change tells main, and a session read here stops
  // being Finished on the phone.
  const markRead = useCallback(
    (instanceId: string) => {
      if (clear(instanceId)) window.electronAPI.acknowledgeInstance(instanceId);
    },
    [clear]
  );

  // Read on a paired phone (main's `instance-read-on-phone`). The phone has settled
  // its own side, so nothing goes back to main: an acknowledgement would only echo
  // the phone's read back to it.
  const readOnPhone = useCallback(
    (instanceId: string) => {
      clear(instanceId);
    },
    [clear]
  );

  return { notify, markRead, readOnPhone, unread: unreadRef.current };
}
