// Rewrites a markdown image `src` so local images load through the app's
// `mdimg://` custom protocol (see src/main/mdimg-protocol.ts), while leaving
// remote and data images untouched.
//
// Local images can't load directly: the renderer runs from a file:// bundle
// origin with webSecurity on, and a relative src would resolve against the
// bundle, not the markdown file. So for local srcs we build a URL that carries
// both the open file's directory (base) and the original src; the main-process
// handler resolves + sandboxes it to that directory subtree.

// True for srcs the browser can already load on its own — leave these alone.
// Anything with a URI scheme (http:, https:, data:, blob:, mdimg:, …) counts.
function isRemoteOrData(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

// `mdFilePath` is the resolved ABSOLUTE path of the open .md file (from the
// read-file result). Returns the src to actually put on the <img>, or null if
// it shouldn't be rendered (empty src).
export function resolveImageSrc(
  src: string | undefined,
  mdFilePath: string
): string | null {
  if (!src) return null;
  if (isRemoteOrData(src)) return src;

  // Root-relative and protocol-relative (`//host/…`) srcs have no meaningful
  // local base in a markdown file; treat them as unresolvable rather than
  // guessing. (Protocol-relative is caught by isRemoteOrData only if it has a
  // scheme; `//` alone is not, so handle it here.)
  if (src.startsWith("//")) return null;

  const baseDir = dirOf(mdFilePath);
  if (!baseDir) return null;

  const params = new URLSearchParams({ base: baseDir, src });
  return `mdimg://img/?${params.toString()}`;
}

// Directory portion of an absolute path. Works for POSIX and Windows
// separators without importing node:path into the renderer bundle.
function dirOf(absPath: string): string | null {
  const idx = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  if (idx < 0) return null;
  return absPath.slice(0, idx);
}
