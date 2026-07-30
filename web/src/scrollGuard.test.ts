import { describe, expect, it, vi } from "vitest";

import { installListboxScrollGuard } from "./scrollGuard";

function makeEl(): { el: HTMLElement; calls: unknown[][] } {
  const el = document.createElement("main");
  const calls: unknown[][] = [];
  // jsdom has no Element#scrollTo; give the element one to shadow.
  (el as unknown as { scrollTo: (...a: unknown[]) => void }).scrollTo = (
    ...a: unknown[]
  ) => {
    calls.push(a);
  };
  document.body.appendChild(el);
  return { el, calls };
}

describe("installListboxScrollGuard", () => {
  it("passes scrollTo through when no listbox is open", () => {
    const { el, calls } = makeEl();
    installListboxScrollGuard(el);
    el.scrollTo(0, 123);
    expect(calls).toEqual([[0, 123]]);
    el.remove();
  });

  it("swallows scrollTo while a listbox popup is mounted", () => {
    const { el, calls } = makeEl();
    installListboxScrollGuard(el);
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    document.body.appendChild(listbox);

    el.scrollTo(0, 2); // Fluent's buggy option-reveal call.
    expect(calls).toEqual([]);

    listbox.remove();
    el.scrollTo(0, 7); // Popup closed: normal behavior restored.
    expect(calls).toEqual([[0, 7]]);
    el.remove();
  });

  it("uninstall restores the original scrollTo", () => {
    const { el } = makeEl();
    const before = el.scrollTo;
    const uninstall = installListboxScrollGuard(el);
    expect(el.scrollTo).not.toBe(before);
    uninstall();
    expect(el.scrollTo).toBe(before);
    el.remove();
  });

  it("never throws when the element lacks a native scrollTo", () => {
    const el = document.createElement("main");
    document.body.appendChild(el);
    // jsdom: Element#scrollTo may exist as a not-implemented stub; the guard
    // must bind whatever is there without exploding on install or call.
    const spy = vi.fn();
    (el as unknown as { scrollTo: unknown }).scrollTo = spy;
    installListboxScrollGuard(el);
    el.scrollTo(0, 1);
    expect(spy).toHaveBeenCalledWith(0, 1);
    el.remove();
  });
});
