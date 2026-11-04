import type { FileDiffFailReason } from "../../shared/types";

// Map a diff failure to the one line shown in place of the columns. Kept out of
// the component so the wording lives in one place and is unit-testable.
// `detail` is whatever the main process attached — a row count for too-large, an
// error message for failed.
export function diffErrorMessage(
  reason: FileDiffFailReason,
  detail?: string
): string {
  switch (reason) {
    case "binary":
      return "Binary file — no diff to show";
    case "too-large":
      return detail
        ? `Diff too large to show (${detail}) — open it in your editor`
        : "Diff too large to show — open it in your editor";
    case "no-changes":
      return "No changes";
    case "not-found":
      return "File not found";
    case "failed":
      return detail
        ? `Could not read the diff: ${detail}`
        : "Could not read the diff";
  }
}

// Whether to offer "Go To" alongside the message: only useful when the file is
// real and readable, just not showable here.
export function offersEditorFallback(reason: FileDiffFailReason): boolean {
  return reason === "too-large" || reason === "binary";
}
