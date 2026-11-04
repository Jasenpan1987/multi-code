import type { ReadFileError } from "../../shared/types";

// Map a read-file failure to a plain, one-line message shown inline in the
// View body. Kept out of the component so the mapping is unit-testable and the
// wording lives in one place. `path` is the resolved path the main process
// echoed back in the result.
export function readFileErrorMessage(
  error: ReadFileError,
  path: string
): string {
  switch (error) {
    case "not-found":
      return `⚠ File not found: ${path}`;
    case "unsupported":
      return `⚠ Only .md files can be viewed: ${path}`;
    case "too-large":
      return `⚠ File too large to preview (>2MB): ${path}`;
  }
}
