import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TERMINAL_URL_REGEX, forwardToSession, keepImeCaretAtEnd } from "./TerminalView";
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

// What a click on a URL in a terminal opens: the match the web-links addon makes.
describe("TERMINAL_URL_REGEX", () => {
  const link = (line: string) => line.match(TERMINAL_URL_REGEX)?.[0] ?? null;

  it("ends a URL at CJK text and full-width punctuation", () => {
    expect(link("- A：http://127.0.0.1:8765/a.html。一张'当前数据\"卡片")).toBe("http://127.0.0.1:8765/a.html");
    expect(link("访问 http://localhost:3000，然后刷新")).toBe("http://localhost:3000");
    expect(link("见（https://example.com/a?b=1&c=2）")).toBe("https://example.com/a?b=1&c=2");
    expect(link("地址是http://x.com/a里面")).toBe("http://x.com/a");
    expect(link("看 https://example.com/docs：第二节")).toBe("https://example.com/docs");
  });

  it("matches as the addon's own pattern did otherwise", () => {
    expect(link("see https://example.com/docs.")).toBe("https://example.com/docs");
    expect(link("(https://example.com/x)")).toBe("https://example.com/x");
    expect(link("https://github.com/acme/repo/pull/3#discussion_r1")).toBe(
      "https://github.com/acme/repo/pull/3#discussion_r1"
    );
    expect(link("https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC ok")).toBe(
      "https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC"
    );
    expect(link("http://[::1]:8080/a b")).toBe("http://[::1]:8080/a");
    expect(link("no link here")).toBeNull();
  });
});

// xterm's hidden textarea, as far as the IME guard uses it: its text, its
// selection, and the events. No DOM here.
class FakeTextarea extends EventTarget {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  // What the browser does: move the caret, then tell the page.
  moveCaret(start: number, end = start) {
    this.setSelectionRange(start, end);
    this.dispatchEvent(new Event("selectionchange"));
  }
}

describe("keepImeCaretAtEnd", () => {
  it("puts the caret back at the end after Cmd+Left or Cmd+A moves it", () => {
    const ta = new FakeTextarea();
    ta.value = "测试";
    ta.setSelectionRange(2, 2);
    keepImeCaretAtEnd(ta as unknown as HTMLTextAreaElement);

    ta.moveCaret(0); // Cmd+Left
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 2]);
    ta.moveCaret(0, 2); // Cmd+A
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 2]);
  });

  it("leaves the caret alone while a word is being composed, and after the guard is removed", () => {
    const ta = new FakeTextarea();
    ta.value = "测试kan";
    const release = keepImeCaretAtEnd(ta as unknown as HTMLTextAreaElement);

    ta.dispatchEvent(new Event("compositionstart"));
    ta.moveCaret(3); // the IME's own caret inside the word
    expect(ta.selectionStart).toBe(3);
    ta.dispatchEvent(new Event("compositionend"));
    ta.value = "测试看";
    ta.moveCaret(1);
    expect(ta.selectionStart).toBe(3);

    release();
    ta.moveCaret(0);
    expect(ta.selectionStart).toBe(0);
  });
});
