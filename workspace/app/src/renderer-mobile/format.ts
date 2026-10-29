// Text the screens share.

import { useEffect, useState } from "react";

// The desktop calls itself "Multi-Code on MacBook Air"; the phone shows the Mac's
// name alone (mockup 1A).
export function macName(hostName: string): string {
  return hostName.replace(/^Multi-Code on /, "") || "your Mac";
}

// How old cached content is, for the offline banner: "3 min ago".
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// The current time, re-read every `everyMs` so ages on screen keep moving.
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

// A Home Screen app (standalone), as opposed to a page in Safari. Only the former
// can receive Web Push on iOS.
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
