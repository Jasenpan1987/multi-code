import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { forwardToSession } from "./TerminalView";
import { holdInput } from "./dropFlow";

// Their bundles need a browser (`self`); nothing here uses them.
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

// A drop holds the builder's input where it starts, on the window, never what a
// terminal sends by itself. Real xterm, with no DOM: it still answers the CLI's
// queries through onData.
describe("forwardToSession", () => {
  it("forwards xterm's replies to the CLI's queries while a drop holds the input, which stops a paste", async () => {
    const terminal = new Terminal();
    const written: string[] = [];
    forwardToSession(terminal, "a", (id, data) => written.push(`${id}:${data}`));

    // The window, held first as its capture listeners run before the page's; then
    // a stand-in for xterm's own paste handler on its textarea, behind the hold.
    const win = new EventTarget();
    const release = holdInput(win, () => false);
    const pasted: string[] = [];
    win.addEventListener("paste", () => pasted.push("unexpected\r"));
    const paste = new Event("paste", { cancelable: true });
    Object.defineProperty(paste, "target", { value: { blur: () => {} } });
    win.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(pasted).toEqual([]);

    // Cursor position, then device attributes, asked while the hold is on.
    await new Promise<void>((resolve) => terminal.write("\x1b[6n\x1b[c", resolve));
    expect(written).toEqual(["a:\x1b[1;1R", "a:\x1b[?1;2c"]);

    release();
    terminal.dispose();
  });
});
