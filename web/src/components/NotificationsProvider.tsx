import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getUnreadCount,
  subscribeNotificationStream,
} from "../notifications";

/** Ambient notification state shared by the nav bell and the inbox page. */
export interface NotificationsContextValue {
  /** Current unread count, seeded from the API and kept live by the stream. */
  unreadCount: number;
  /** Re-read the unread count from the API (after a mark-read action). */
  refreshUnread: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(
  null,
);

/** Read the shared notification state. Throws outside a provider. */
export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within NotificationsProvider");
  }
  return ctx;
}

/**
 * Owns the app's ambient notification state: seeds the unread count from
 * `GET /unread-count` and keeps it live off the SSE stream (incrementing per
 * pushed row) and mark-read actions. The bell reads `unreadCount`; the inbox
 * calls `refreshUnread` after marking rows read. Desktop notifications are
 * raised by the backend; the web app shows nothing transient.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0);

  // Guard against a late async count landing after unmount.
  const mounted = useRef(true);

  const refreshUnread = useCallback(async () => {
    try {
      const count = await getUnreadCount();
      if (mounted.current) setUnreadCount(count);
    } catch {
      // A failed count read leaves the last known value in place; the stream
      // and the next refresh still converge it.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshUnread();
    const unsubscribe = subscribeNotificationStream({
      onNotification: () => {
        if (!mounted.current) return;
        // Every streamed row is a freshly written (unread) notification.
        setUnreadCount((count) => count + 1);
      },
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refreshUnread]);

  return (
    <NotificationsContext.Provider value={{ unreadCount, refreshUnread }}>
      {children}
    </NotificationsContext.Provider>
  );
}
