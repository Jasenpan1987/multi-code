import { resolve, extname, sep } from "path";

// Pure resolution + sandboxing logic for the mdimg:// protocol, kept free of
// any electron import so it can be unit-tested directly. The protocol handler
// (mdimg-protocol.ts) wraps this with the actual file serving.

// Extension -> MIME. SVG is intentionally excluded: it can carry inline script,
// and we'd rather not serve it until we decide how to sandbox it (see kanban
// P2-003 notes). Everything here renders inertly in an <img>.
export const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

// Parse an mdimg:// URL and return the absolute on-disk path IF it is a served
// image type AND stays within the declared base directory. Returns null
// (caller -> 403) for any violation.
export function resolveMdimgRequest(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const base = url.searchParams.get("base");
  const src = url.searchParams.get("src");
  if (!base || !src) return null;

  // Reject srcs carrying a URI scheme defensively — remote images never route
  // here (the renderer only rewrites local srcs), but if one did, don't touch
  // fs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

  // Resolve the src against the open file's directory, then confirm the result
  // is contained within that directory subtree.
  const baseDir = resolve(base);
  const resolved = resolve(baseDir, src);
  if (!isInside(baseDir, resolved)) return null;

  // Only serve known image extensions.
  if (!(extname(resolved).toLowerCase() in MIME_BY_EXT)) return null;

  return resolved;
}

// True when `child` is `parent` itself or nested beneath it. Compares with a
// trailing separator so `/a/foobar` is not treated as inside `/a/foo`.
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}
