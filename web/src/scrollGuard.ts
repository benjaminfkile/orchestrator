// Guard against a Fluent UI v9 bug that scrolls the nearest scrollable
// ancestor to the top whenever a Combobox/Dropdown opens.
//
// Mechanism (verified against the bundled Fluent source): on open, Fluent's
// active-descendant helper (`@fluentui/react-aria` scrollIntoView) walks up
// from the active option looking for the nearest ancestor with
// `scrollHeight > offsetHeight`. When the listbox itself is short (few
// options) it is not scrollable, so the walk ESCAPES the listbox and lands on
// whatever scrollable ancestor sits above it — the routed <main>, but also a
// long Dialog's scrollable content region, or any card with its own scroll.
// It then calls `ancestor.scrollTo(0, optionOffset - 2)`. Because the
// offsetTop calculation ignores floating-ui's transform-based positioning,
// `optionOffset` is near zero, which yanks that ancestor to the top —
// visually the whole page (or the dialog body) jumps and the popup ends up
// off-screen so the options are never clickable. Present in the latest
// release (@fluentui/react-aria 9.17.13), so this is an app-side workaround.
//
// The guard shadows `Element.prototype.scrollTo` with a wrapper that
// swallows calls made while ANY `[role="listbox"]` popup is mounted in the
// document. Fluent's scrollIntoView is the only code path in the app that
// calls `scrollTo` (the runtime scan under src/ has no other callers), so the
// wrapper is a no-op in every other situation. If Fluent fixes the walk
// upstream the wrapper simply never returns early. Wheel/keyboard/scrollbar
// scrolling and direct `scrollTop`/`scrollLeft` assignments never go through
// `scrollTo`, so the guard cannot suppress legitimate user scrolling.
//
// Prototype-level patching (rather than shadowing a single element) is what
// makes this a root-cause fix instead of a per-container band-aid: it covers
// every scrollable region — the shell's <main>, dialog bodies, drawers, any
// future card with its own scroll — without each one having to opt in.

type ScrollToImpl = (
  this: Element,
  ...args: unknown[]
) => void;

/**
 * Install the guard on `doc`. Returns an uninstall function (used on unmount).
 * `doc` is injectable for tests; defaults to the global document.
 *
 * Multiple installs on the same document nest safely: an inner install stacks
 * over the outer, and uninstall restores whatever descriptor was in place
 * before this call. Only the outermost uninstall reverts to the platform
 * scrollTo.
 */
export function installListboxScrollGuard(
  doc: Document = typeof document !== "undefined"
    ? document
    : (undefined as unknown as Document),
): () => void {
  // Some environments (e.g. server rendering) have no Document; make the
  // install a harmless no-op so callers do not need to gate on it.
  if (!doc) return () => undefined;
  // Element.prototype is shared across every Element in the current JS
  // realm, and jsdom/browsers both expose it here; there is no per-document
  // prototype, so patching once covers every scroll region.
  const proto = Element.prototype as unknown as {
    scrollTo?: ScrollToImpl;
  };
  const prevDescriptor = Object.getOwnPropertyDescriptor(proto, "scrollTo");
  const native = prevDescriptor?.value as ScrollToImpl | undefined;
  function guarded(this: Element, ...args: unknown[]): void {
    // A mounted listbox means a dropdown popup is open (Combobox, Dropdown,
    // and pickers all render role="listbox"); Fluent's buggy option-reveal
    // is the only scrollTo caller in that window and its target is always
    // the nearest scrollable ancestor. Suppressing here neutralizes the
    // bug regardless of which scroll region the walk-up landed on.
    if (doc.querySelector('[role="listbox"]')) return;
    native?.apply(this, args);
  }
  Object.defineProperty(proto, "scrollTo", {
    value: guarded,
    configurable: true,
    writable: true,
  });
  return () => {
    if (prevDescriptor) Object.defineProperty(proto, "scrollTo", prevDescriptor);
    else delete (proto as { scrollTo?: unknown }).scrollTo;
  };
}
