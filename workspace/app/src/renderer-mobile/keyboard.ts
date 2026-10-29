// A screen whose bottom (the compose box, a dialog's field, the terminal's key row)
// sits right above the iPhone's keyboard. iOS has no VirtualKeyboard API and doesn't
// shrink the page for the keyboard: it pans the visual viewport up, by as much as it
// takes to show the focused field, and what was at the top of the page goes out of
// sight. So while a field has focus the screen (position: fixed in its CSS) takes the
// visual viewport's height and follows its pan, which leaves iOS nothing to pan to.

import { useEffect, useState, type RefObject } from "react";

// Only while `active` (a field has focus): in a Home Screen app on iOS 27
// visualViewport.height stays ~68 px short after the first keyboard (WebKit 322900),
// so with the keyboard down the screen goes back to the full height its CSS gives it.
export function useKeyboardFrame(screen: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const el = screen.current;
    if (!active || !viewport || !el) return;
    const place = () => {
      el.style.height = `${viewport.height}px`;
      el.style.transform = `translateY(${viewport.offsetTop}px)`;
    };
    place();
    viewport.addEventListener("resize", place);
    viewport.addEventListener("scroll", place);
    return () => {
      viewport.removeEventListener("resize", place);
      viewport.removeEventListener("scroll", place);
      el.style.height = "";
      el.style.transform = "";
    };
  }, [screen, active]);
}

// Whether a text field in the screen has the focus, so the keyboard is up or coming.
// A focused field that leaves the page (the compose box giving way to a dialog) may
// fire no blur, but the keyboard goes down with it, so a change of the viewport
// looks again.
export function useTyping(screen: RefObject<HTMLElement | null>): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    const check = (focused: EventTarget | null) => setTyping(isTextField(focused) && el.contains(focused));
    const onFocusIn = (e: FocusEvent) => check(e.target);
    // Where the focus goes; null when it goes nowhere.
    const onFocusOut = (e: FocusEvent) => check(e.relatedTarget);
    const onViewport = () => check(document.activeElement);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    window.visualViewport?.addEventListener("resize", onViewport);
    check(document.activeElement);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      window.visualViewport?.removeEventListener("resize", onViewport);
    };
  }, [screen]);
  return typing;
}

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

function isTextField(target: EventTarget | null): target is HTMLElement {
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  if (target instanceof HTMLInputElement) return TEXT_INPUTS.has(target.type) && !target.readOnly;
  return false;
}
