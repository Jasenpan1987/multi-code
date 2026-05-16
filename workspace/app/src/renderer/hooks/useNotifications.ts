import { useRef, useCallback } from "react";

export function useNotifications() {
  const unreadRef = useRef(new Set<string>());
  const debounceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const notify = useCallback(
    (instanceId: string, _instanceName: string) => {
      // Debounce: wait 500ms of silence before notifying
      const existing = debounceTimers.current.get(instanceId);
      if (existing) clearTimeout(existing);

      debounceTimers.current.set(
        instanceId,
        setTimeout(() => {
          unreadRef.current.add(instanceId);

          // Dispatch event for UI to update (badge + blink only, no system notification)
          window.dispatchEvent(
            new CustomEvent("unread-update", {
              detail: { unread: new Set(unreadRef.current) },
            })
          );

          debounceTimers.current.delete(instanceId);
        }, 500)
      );
    },
    []
  );

  const markRead = useCallback((instanceId: string) => {
    const pending = debounceTimers.current.get(instanceId);
    if (pending) {
      clearTimeout(pending);
      debounceTimers.current.delete(instanceId);
    }
    unreadRef.current.delete(instanceId);
    window.dispatchEvent(
      new CustomEvent("unread-update", {
        detail: { unread: new Set(unreadRef.current) },
      })
    );
  }, []);


  return { notify, markRead, unread: unreadRef.current };
}
