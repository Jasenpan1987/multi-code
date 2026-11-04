// Decide whether a rendered-markdown link should be opened in the OS browser.
// Only web/mail schemes are opened externally; relative links, anchors, and
// exotic schemes are left inert so a document can never navigate the renderer
// away or trigger an arbitrary protocol handler. The main-process
// `open-external` handler re-checks the scheme as the real guard.
export function shouldOpenExternally(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const scheme = new URL(href).protocol;
    return scheme === "http:" || scheme === "https:" || scheme === "mailto:";
  } catch {
    // Not an absolute URL (relative path, bare anchor, etc.) — leave inert.
    return false;
  }
}
