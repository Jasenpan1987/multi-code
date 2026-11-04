// A screen that throws shows the error and a Reload button, not an empty page. The
// tests run without a DOM, so the boundary's element tree is read here and its
// button's handler fired, as the browser would fire it.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorScreen } from "./App";

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function find(node: ReactNode, match: (el: Element) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => find(child, match));
  if (!isValidElement(node)) return [];
  const el = node as Element;
  return [...(match(el) ? [el] : []), ...find(el.props.children, match)];
}

function crashed(thrown: unknown) {
  const boundary = new ErrorScreen({ children: <p>app</p> });
  boundary.state = ErrorScreen.getDerivedStateFromError(thrown);
  return boundary.render();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ErrorScreen", () => {
  it("shows the app while nothing has thrown", () => {
    const app = <p>app</p>;
    expect(new ErrorScreen({ children: app }).render()).toBe(app);
  });

  it("shows the error's message and stack", () => {
    const error = new Error("Cannot read properties of undefined");
    error.stack = "turnOf@bundle.js:2:345";
    const [pre] = find(crashed(error), (el) => el.type === "pre");
    expect(pre.props.children).toBe("Cannot read properties of undefined\n\nturnOf@bundle.js:2:345");
  });

  it("shows something thrown that is no Error", () => {
    const [pre] = find(crashed("boom"), (el) => el.type === "pre");
    expect(String(pre.props.children)).toMatch(/^boom/);
  });

  it("reloads the page on Reload", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const [button] = find(crashed(new Error("x")), (el) => el.type === "button");
    expect(button.props.children).toBe("Reload");
    (button.props.onClick as () => void)();
    expect(reload).toHaveBeenCalledOnce();
  });
});
