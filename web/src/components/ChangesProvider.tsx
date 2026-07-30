import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { subscribeChangeStream } from "../changes";

/** A page's per-resource refetch, invoked when its resource changes. */
export type RefetchCallback = () => void;

/** Shared live-refresh plumbing exposed to pages via {@link useChanges}. */
export interface ChangesContextValue {
  /**
   * Register `callback` to run whenever `resource` changes on the stream.
   * Returns an unsubscribe function; call it on unmount. Prefer the
   * {@link useLiveRefetch} hook, which manages the lifecycle for you.
   */
  subscribe: (resource: string, callback: RefetchCallback) => () => void;
}

const ChangesContext = createContext<ChangesContextValue | null>(null);

/** Read the shared change-stream plumbing. Throws outside a provider. */
export function useChanges(): ChangesContextValue {
  const ctx = useContext(ChangesContext);
  if (!ctx) {
    throw new Error("useChanges must be used within ChangesProvider");
  }
  return ctx;
}

/**
 * Minimum spacing between refetches for a single resource. The backend already
 * coalesces bursts (see the change bus), but a client-side throttle guarantees a
 * page never refetches more than once per this window no matter the message rate.
 */
export const THROTTLE_MS = 1000;

/** Per-resource throttle bookkeeping (leading-edge fire, trailing catch-up). */
interface ThrottleState {
  timer: ReturnType<typeof setTimeout>;
  /** A change arrived during the cooldown; fire once more on the trailing edge. */
  pending: boolean;
}

/**
 * Owns the SPA's single live-refresh EventSource. One connection to
 * `/api/changes/stream` is shared app-wide; pages register a per-resource
 * refetch via {@link useLiveRefetch}. Two behaviors keep the UI calm and
 * correct:
 *
 *   - **Per-resource throttle.** A resource's callbacks fire at most once per
 *     {@link THROTTLE_MS}: the first change fires immediately, further changes
 *     within the window collapse into a single trailing refetch so the page
 *     ends on the latest data without a request storm.
 *   - **Reconnect catch-up.** The browser silently reconnects a dropped
 *     EventSource; frames sent while it was down are lost. On every reconnect we
 *     invoke every registered callback once so each page reconciles with the
 *     server.
 *
 * Mirrors {@link NotificationsProvider}'s placement and lifecycle in the shell.
 */
export function ChangesProvider({ children }: { children?: ReactNode }) {
  // resource -> the callbacks watching it.
  const listenersRef = useRef<Map<string, Set<RefetchCallback>>>(new Map());
  // resource -> its live throttle window, if one is open.
  const throttleRef = useRef<Map<string, ThrottleState>>(new Map());

  // Run every callback watching `resource`, isolating throws so one page's
  // failing refetch cannot break another's.
  const invokeResource = useCallback((resource: string) => {
    const set = listenersRef.current.get(resource);
    if (!set) return;
    for (const cb of set) {
      try {
        cb();
      } catch {
        // A background refetch failure is never allowed to break a peer.
      }
    }
  }, []);

  // Apply the leading-edge-plus-trailing throttle for a single resource change.
  const onResourceChange = useCallback(
    (resource: string) => {
      const throttle = throttleRef.current;
      const open = throttle.get(resource);
      if (open) {
        // Inside the cooldown: remember to fire once more when it elapses.
        open.pending = true;
        return;
      }
      // Leading edge: refetch now, then hold the window open for THROTTLE_MS.
      invokeResource(resource);
      const startWindow = () => {
        const timer = setTimeout(() => {
          const state = throttle.get(resource);
          if (state?.pending) {
            state.pending = false;
            invokeResource(resource);
            startWindow(); // keep enforcing >=THROTTLE_MS spacing
          } else {
            throttle.delete(resource);
          }
        }, THROTTLE_MS);
        throttle.set(resource, { timer, pending: false });
      };
      startWindow();
    },
    [invokeResource],
  );

  // Reconnect catch-up: refetch every watched resource exactly once, bypassing
  // the throttle since we may have missed changes while offline.
  const catchUpAll = useCallback(() => {
    for (const resource of listenersRef.current.keys()) {
      invokeResource(resource);
    }
  }, [invokeResource]);

  const subscribe = useCallback(
    (resource: string, callback: RefetchCallback) => {
      let set = listenersRef.current.get(resource);
      if (!set) {
        set = new Set();
        listenersRef.current.set(resource, set);
      }
      set.add(callback);
      return () => {
        const current = listenersRef.current.get(resource);
        if (!current) return;
        current.delete(callback);
        if (current.size === 0) listenersRef.current.delete(resource);
      };
    },
    [],
  );

  useEffect(() => {
    // The initial open is the page's first load, which already fetched; only
    // treat SUBSEQUENT opens as reconnects that need a catch-up.
    let firstOpen = true;
    const throttle = throttleRef.current;
    const unsubscribe = subscribeChangeStream({
      onChange: (change) => onResourceChange(change.resource),
      onOpen: () => {
        if (firstOpen) {
          firstOpen = false;
          return;
        }
        catchUpAll();
      },
    });
    return () => {
      unsubscribe();
      for (const state of throttle.values()) clearTimeout(state.timer);
      throttle.clear();
    };
  }, [onResourceChange, catchUpAll]);

  const value = useMemo<ChangesContextValue>(() => ({ subscribe }), [subscribe]);

  return (
    <ChangesContext.Provider value={value}>{children}</ChangesContext.Provider>
  );
}
