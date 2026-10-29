// Only the Send button sends (PRD Story 4): Return, with or without an IME
// composing, is a new line. Compose has no hooks, so its element tree is built here
// and the textarea's own handlers are fired, as the browser would fire them.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Compose, type ComposeProps } from "./Compose";

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function find(node: ReactNode, match: (el: Element) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => find(child, match));
  if (!isValidElement(node)) return [];
  const el = node as Element;
  return [...(match(el) ? [el] : []), ...find(el.props.children, match)];
}

function render(props: Partial<ComposeProps> = {}) {
  const onSend = vi.fn();
  const onText = vi.fn();
  const tree = Compose({ text: "first line", onText, onSend, placeholder: "Reply…", ...props });
  const [textarea] = find(tree, (el) => el.type === "textarea");
  const [button] = find(tree, (el) => el.type === "button");
  return { tree, textarea, button, onSend, onText };
}

const returnKey = (extra: Record<string, unknown> = {}) => ({
  key: "Enter",
  code: "Enter",
  keyCode: 13,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  preventDefault: vi.fn(),
  nativeEvent: { isComposing: false, ...extra },
  ...extra,
});

describe("Compose", () => {
  it("never sends on Return, plain, modified or from a composing IME", () => {
    const { textarea, onSend } = render();
    const keyHandlers = Object.keys(textarea.props).filter((p) => /^on(Key|BeforeInput|Composition)/.test(p));
    for (const name of keyHandlers) {
      const handler = textarea.props[name] as (e: unknown) => void;
      handler(returnKey());
      handler(returnKey({ metaKey: true }));
      handler(returnKey({ ctrlKey: true }));
      handler(returnKey({ isComposing: true, keyCode: 229 }));
    }
    expect(onSend).not.toHaveBeenCalled();
  });

  it("takes the Return the textarea types as a new line of the text", () => {
    const { textarea, onSend, onText } = render();
    const change = textarea.props.onChange as (e: unknown) => void;
    change({ target: { value: "first line\n" } });
    change({ target: { value: "first line\n好" } });
    expect(onText.mock.calls).toEqual([["first line\n"], ["first line\n好"]]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("is not in a form, and the keyboard's key says return, not send", () => {
    const { tree, textarea } = render();
    expect(find(tree, (el) => el.type === "form")).toEqual([]);
    expect(textarea.props.enterKeyHint).toBe("enter");
  });

  it("sends from the button, which keeps the keyboard up", () => {
    const { button, onSend } = render();
    expect(button.props.disabled).toBe(false);
    const mouseDown = { preventDefault: vi.fn() };
    (button.props.onMouseDown as (e: unknown) => void)(mouseDown);
    expect(mouseDown.preventDefault).toHaveBeenCalled();
    (button.props.onClick as () => void)();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("can't send blank text", () => {
    expect(render({ text: "  \n " }).button.props.disabled).toBe(true);
  });
});
