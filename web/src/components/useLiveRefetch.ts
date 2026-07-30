import { useEffect, useRef } from "react";

import { useChanges } from "./ChangesProvider";

/**
 * Silently refetch a page's list whenever `resource` changes on the live stream.
 * Registers `refetch` with the shared {@link ChangesProvider} on mount and
 * unregisters on unmount.
 *
 * `refetch` should re-run the fetch the page would run anyway for its CURRENT
 * query (search/sort/pagination) — a background reload, not a state reset — so
 * live updates preserve what the user is doing. Its identity may change every
 * render (it typically closes over query state); the latest is always called via
 * a ref, so the subscription itself is stable and never churns.
 *
 * Pages watching more than one resource call this hook once per resource.
 */
export function useLiveRefetch(
  resource: string,
  refetch: () => void | Promise<void>,
): void {
  const { subscribe } = useChanges();
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    return subscribe(resource, () => {
      void refetchRef.current();
    });
  }, [subscribe, resource]);
}
