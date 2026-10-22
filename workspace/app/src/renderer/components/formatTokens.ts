// Compact token counts for the contact list, where the whole figure has to fit
// beside a project name on one line.
//
// Follows the shape the CLIs use in their own `/context` output (`17.6k`), so the
// number reads the same in Multi-Code as it does in the terminal next to it.
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${trimZero((tokens / 1000).toFixed(1))}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${trimZero((tokens / 1_000_000).toFixed(2))}M`;
}

// A tenth of a k is worth showing below 10k, where 9k and 9.9k are meaningfully
// different. A trailing `.0` is not, so `9.0k` becomes `9k`.
function trimZero(value: string): string {
  return value.replace(/\.?0+$/, "");
}

// How full the window is, as a percentage — the question the user actually has.
//
// Returns "" when the window size isn't known, and callers must render nothing
// rather than substitute a default. Neither CLI records the window in its transcript,
// so it comes from config that can be missing or stale, and 45% shown for a session
// actually at 226% is worse than no percentage at all.
//
// One decimal below 10%, whole percent from there: this sits beside a project name
// in a narrow column, and nobody acts differently on 62% versus 62.4%. Below 10% the
// tenth is what moves: on a million-token window a whole percent is 10k tokens, so a
// fresh session and a few turns later both read "2%". The `.0` stays, as in Claude
// Code's own status line (`22.3k (2.0%)`).
export function formatContextPercent(
  inputTokens: number,
  contextWindow: number | undefined
): string {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "";
  }
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return "";
  const percent = (inputTokens / contextWindow) * 100;
  // 9.95 and up would print as "10.0%".
  if (percent < 9.95) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

// The colour of a context figure, as an HSL hue: green while the window is at most
// half full, through yellow at three quarters to red when full or over. Undefined
// when the window isn't known, so an unknown denominator never looks comfortable.
export function contextFillHue(
  inputTokens: number,
  contextWindow: number | undefined
): number | undefined {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return undefined;
  const ratio = inputTokens / contextWindow;
  if (ratio <= 0.5) return 120;
  if (ratio <= 0.75) return 120 - ((ratio - 0.5) / 0.25) * 75;
  return Math.max(0, 45 - ((ratio - 0.75) / 0.25) * 45);
}
