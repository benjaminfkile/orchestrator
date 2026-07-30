// A matchMedia-driven hook so layout can react to a CSS breakpoint without any
// CSS-in-JS media-query gymnastics. Returns whether `query` currently matches
// and re-renders when it changes. Safe when matchMedia is unavailable (jsdom
// without a stub, older environments) — it simply reports `false`.

import { useEffect, useState } from "react";

/** Evaluate a media query once, defaulting to `false` when unsupported. */
function evaluate(query: string): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

/**
 * Subscribe to a media query and return its live match state. The subscription
 * is set up in an effect (so SSR/first paint use the initial read) and torn
 * down on unmount or when the query string changes.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => evaluate(query));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Re-sync in case the query matched differently between the initial read
    // and this subscription (e.g. a resize during mount).
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
