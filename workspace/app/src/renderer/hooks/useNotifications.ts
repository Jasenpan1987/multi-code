import { useRef, useCallback } from "react";

// Unread alerts per instance: one for each finished turn or dialog, with a burst
// inside the debounce counting once. Only acknowledging the instance clears them.
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

  const markRead = useCallback(
    (instanceId: string) => {
      const pending = debounceTimers.current.get(instanceId);
      if (pending) {
        clearTimeout(pending);
        debounceTimers.current.delete(instanceId);
      }
      // Every key press on the shown instance lands here, so only a real change
      // re-renders the app.
      if (unreadRef.current.delete(instanceId)) publish();
    },
    [publish]
  );

  return { notify, markRead, unread: unreadRef.current };
}
