import { afterEach, describe, expect, it, vi } from "vitest";

import { installListboxScrollGuard } from "./scrollGuard";

/**
 * Save whatever `Element.prototype.scrollTo` looks like at the start of a
 * suite and restore it afterwards, so a failing test never leaks a
 * half-installed guard into the next case.
 */
const originalDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo",
);
afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(Element.prototype, "scrollTo", originalDescriptor);
  } else {
    delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  }
});

function makeEl(): { el: HTMLElement; calls: unknown[][] } {
  const el = document.createElement("main");
  const calls: unknown[][] = [];
  // Give the prototype a working scrollTo the guard can shadow, so both the
  // "swallowed" and "passthrough" branches are observable.
  (Element.prototype as unknown as { scrollTo: (...a: unknown[]) => void }).scrollTo =
    function scrollTo(...a: unknown[]) {
      calls.push(a);
    };
  document.body.appendChild(el);
  return { el, calls };
}

describe("installListboxScrollGuard", () => {
  it("passes scrollTo through when no listbox is open", () => {
    const { el, calls } = makeEl();
    installListboxScrollGuard();
    el.scrollTo(0, 123);
    expect(calls).toEqual([[0, 123]]);
    el.remove();
  });

  it("swallows scrollTo while a listbox popup is mounted", () => {
    const { el, calls } = makeEl();
    installListboxScrollGuard();
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

  it("guards every element in the document, not just one", () => {
    // The bug fires on whichever scrollable ancestor Fluent's walk-up lands
    // on — <main>, a dialog body, a scrolled card. All must be shielded.
    const { calls } = makeEl();
    installListboxScrollGuard();
    const dialogBody = document.createElement("div");
    document.body.appendChild(dialogBody);
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    document.body.appendChild(listbox);

    dialogBody.scrollTo(0, 42);
    expect(calls).toEqual([]);

    listbox.remove();
    dialogBody.scrollTo(0, 5);
    expect(calls).toEqual([[0, 5]]);
    dialogBody.remove();
  });

  it("uninstall restores the original scrollTo", () => {
    const { el } = makeEl();
    const before = el.scrollTo;
    const uninstall = installListboxScrollGuard();
    expect(el.scrollTo).not.toBe(before);
    uninstall();
    expect(el.scrollTo).toBe(before);
    el.remove();
  });

  it("nested installs restore in LIFO order", () => {
    // Two mounts of the guard (e.g. StrictMode double-invoke of an effect
    // before its cleanup) must not corrupt the prototype: each uninstall
    // restores exactly the descriptor that install saw.
    const { el, calls } = makeEl();
    const original = el.scrollTo;
    const outerUninstall = installListboxScrollGuard();
    const outerGuard = el.scrollTo;
    const innerUninstall = installListboxScrollGuard();
    innerUninstall();
    expect(el.scrollTo).toBe(outerGuard);
    outerUninstall();
    expect(el.scrollTo).toBe(original);
    el.scrollTo(0, 9);
    expect(calls).toEqual([[0, 9]]);
    el.remove();
  });

  it("never throws when the prototype lacks a native scrollTo", () => {
    // jsdom may not expose Element#scrollTo at all; installing the guard
    // must be safe and passthrough must be a benign no-op rather than a
    // crash the first time a user opens the app in that environment.
    delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    const el = document.createElement("main");
    document.body.appendChild(el);
    const spy = vi.fn();
    (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = spy;
    installListboxScrollGuard();
    el.scrollTo(0, 1);
    expect(spy).toHaveBeenCalledWith(0, 1);
    el.remove();
  });
});
