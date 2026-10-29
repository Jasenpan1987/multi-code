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

// How long something took or has run, as the chat and the working row show it:
// "48s", "2m 41s", "1m 05s", "1h 05m".
export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// A list row's age (mockup 1A): "now", "2m", "3h" today, then "Yesterday", the
// weekday within a week, and the date beyond, in the phone's own calendar.
export function shortAge(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const then = new Date(at);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return `${Math.floor(minutes / 60)}h`;
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString("en-US", { weekday: "short" });
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

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
