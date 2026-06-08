// Sends a composed message to a running claude instance over the existing
// pty-input path, reusing the exact channel TerminalView.onData uses.
//
// Mechanism validated against claude 2.1.165 (see docs/specs/compose-box):
//   - `\n` (0x0A) inserts a newline and NEVER submits; only `\r` (0x0D) submits.
//   - Wrap the payload in bracketed-paste markers (\x1b[200~ … \x1b[201~) so
//     long content folds into the native `[Pasted text #N]` placeholder.
//   - Send the submitting `\r` as a SEPARATE write, NOT inside the markers.
//   - Image refs are spliced into the payload as ` @<path>` tokens; claude
//     reads `@<path>` as a real vision attachment, not text.

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Minimal surface of window.electronAPI we need; passing it in keeps the
// helper a pure function of its inputs and trivially unit-testable.
type WriteFn = (id: string, data: string) => void;

/**
 * Build the bracketed-paste payload for a composed message. Image refs are
 * appended as ` @<path>` tokens after the text. Returns the inner payload
 * WITHOUT the trailing submit `\r` (that is sent as a separate write).
 */
export function buildComposePayload(
  text: string,
  imagePaths: string[] = []
): string {
  const refs = imagePaths.map((p) => `@${p}`).join(" ");
  if (!refs) return text;
  if (!text) return refs;
  // Separate the text from the first ref with a space so the token is parsed.
  return `${text} ${refs}`;
}

/**
 * Send a composed message to an instance. Emits exactly two writes:
 *   1. PASTE_START + payload + PASTE_END
 *   2. "\r" (separate call) to submit
 *
 * `write` defaults to the real IPC bridge; tests pass a mock.
 */
export function sendComposed(
  instanceId: string,
  text: string,
  imagePaths: string[] = [],
  write: WriteFn = (id, data) => window.electronAPI.writeToInstance(id, data)
): void {
  const payload = buildComposePayload(text, imagePaths);
  write(instanceId, `${PASTE_START}${payload}${PASTE_END}`);
  write(instanceId, "\r");
}
