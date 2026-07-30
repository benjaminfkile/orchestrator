// Guard against a Fluent UI v9 bug that scrolls the app's content region to
// the top whenever a Combobox/Dropdown opens.
//
// Mechanism (verified by tracing the live app): on open, Fluent's
// active-descendant helper (`@fluentui/react-aria` scrollIntoView) walks up
// from the active option looking for the nearest ancestor with
// `scrollHeight > offsetHeight`. When the listbox itself is short (few
// options) it is not scrollable, so the walk ESCAPES the listbox and lands on
// our scrollable <main> — then calls `main.scrollTo(0, optionOffset - 2)`,
// yanking the page to the top. Present in the latest release
// (@fluentui/react-aria 9.17.13), so this is an app-side workaround.
//
// The guard shadows the element's own `scrollTo` (an instance property wins
// over Element.prototype, which is what Fluent calls) and swallows calls made
// while a listbox popup is open. Wheel/keyboard/scrollbar scrolling never goes
// through `scrollTo`, and this app never programmatically scrolls <main>
// while a dropdown is open, so only the buggy reveal is suppressed. If Fluent
// fixes the walk upstream, the guard simply never fires.

/**
 * Install the guard on `el`. Returns an uninstall function (used on unmount).
 * `doc` is injectable for tests.
 */
export function installListboxScrollGuard(
  el: HTMLElement,
  doc: Document = el.ownerDocument
): () => void {
  // jsdom (tests) has no Element#scrollTo — guard must install as a harmless
  // no-op there rather than throw on mount.
  const prevOwn = Object.getOwnPropertyDescriptor(el, "scrollTo");
  const native =
    typeof el.scrollTo === "function"
      ? (el.scrollTo.bind(el) as (...a: unknown[]) => void)
      : undefined;
  const guarded = (...args: unknown[]): void => {
    // A mounted listbox means a dropdown popup is open (Combobox, Dropdown,
    // and pickers all render role="listbox"); the only scrollTo calls on the
    // content region in that window are Fluent's buggy option-reveal.
    if (doc.querySelector('[role="listbox"]')) return;
    native?.(...args);
  };
  Object.defineProperty(el, "scrollTo", {
    value: guarded,
    configurable: true,
    writable: true,
  });
  return () => {
    if (prevOwn) Object.defineProperty(el, "scrollTo", prevOwn);
    else delete (el as { scrollTo?: unknown }).scrollTo;
  };
}
