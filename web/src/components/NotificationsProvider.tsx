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
  Toast,
  Toaster,
  ToastBody,
  ToastTitle,
  useId,
  useToastController,
} from "@fluentui/react-components";
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

/** Cap on concurrently visible toasts so a burst can't bury the UI. */
const MAX_TOASTS = 3;

/**
 * Owns the app's ambient notification concerns in one place:
 *   - seeds the unread count from `GET /unread-count` and keeps it live off the
 *     SSE stream (incrementing per pushed row) and mark-read actions;
 *   - raises a Fluent toast for each streamed notification (title + body),
 *     capped at {@link MAX_TOASTS} concurrent toasts.
 *
 * Must render inside a FluentProvider so its Toaster is themed. The bell reads
 * `unreadCount`; the inbox calls `refreshUnread` after marking rows read.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const toasterId = useId("notification-toaster");
  const { dispatchToast } = useToastController(toasterId);

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
      onNotification: (record) => {
        if (!mounted.current) return;
        // Every streamed row is a freshly written (unread) notification.
        setUnreadCount((count) => count + 1);
        dispatchToast(
          <Toast>
            <ToastTitle>{record.title || "Notification"}</ToastTitle>
            {record.body ? <ToastBody>{record.body}</ToastBody> : null}
          </Toast>,
          { intent: record.status === "failed" ? "error" : "info" },
        );
      },
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refreshUnread, dispatchToast]);

  return (
    <NotificationsContext.Provider value={{ unreadCount, refreshUnread }}>
      {children}
      <Toaster toasterId={toasterId} limit={MAX_TOASTS} />
    </NotificationsContext.Provider>
  );
}
