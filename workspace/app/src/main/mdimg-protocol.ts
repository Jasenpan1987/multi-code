import { protocol, net } from "electron";
import { statSync } from "fs";
import { pathToFileURL } from "url";
import { extname } from "path";
import { MIME_BY_EXT, resolveMdimgRequest } from "./mdimgResolve";

// Custom protocol that serves local image files referenced by a rendered
// markdown document. The renderer cannot read the filesystem, and the app runs
// from a file:// bundle origin with webSecurity on, so a bare relative/absolute
// image src in markdown won't load. This mirrors how VSCode's markdown preview
// (asWebviewUri) and Obsidian (app://) serve local resources: a controlled
// protocol scoped to an allowed root, not data URLs.
//
// URL shape (built by the renderer's <img> renderer, see markdownImages.ts):
//   mdimg://img/?base=<encoded abs dir of the open .md>&src=<encoded raw src>
//
// Security: the resolved image path MUST stay inside `base` (the directory of
// the currently open .md file). Anything resolving outside that subtree is
// refused, so a malicious `src` like ../../../../etc/passwd can't exfiltrate
// files. Only image extensions are served, with a size cap. All of that lives
// in mdimgResolve.ts (electron-free, unit-tested); this file just serves bytes.

export const MDIMG_SCHEME = "mdimg";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB — generous for diagrams/screenshots

// Register the scheme as privileged BEFORE app 'ready'. `standard` makes the
// URL parse with normal host/path semantics; `secure`/`supportFetchAPI` let the
// renderer load it like any other resource under its (secure) origin.
export function registerMdimgSchemePrivileged() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MDIMG_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
      },
    },
  ]);
}

// Install the actual handler. Call AFTER app 'ready'.
export function registerMdimgProtocol() {
  protocol.handle(MDIMG_SCHEME, async (request) => {
    const filePath = resolveMdimgRequest(request.url);
    if (!filePath) {
      return new Response("Forbidden", { status: 403 });
    }

    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (!stats.isFile()) {
      return new Response("Not found", { status: 404 });
    }
    if (stats.size > MAX_IMAGE_BYTES) {
      return new Response("Too large", { status: 413 });
    }

    // Delegate byte-serving to Electron's net module against a file:// URL — it
    // streams the file and sets sensible headers. We override Content-Type from
    // our extension allow-list.
    const mime = MIME_BY_EXT[extname(filePath).toLowerCase()];
    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    if (mime) headers.set("Content-Type", mime);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });
}
