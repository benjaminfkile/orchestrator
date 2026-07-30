import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  makeStyles,
  mergeClasses,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title1,
  tokens,
} from "@fluentui/react-components";
import { useNavigate } from "react-router-dom";

import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationRecord,
} from "../notifications";
import { getEvent, type EventDetail } from "../dispatches";
import { TableSearch } from "../components/TableSearch";
import { ApiError } from "../api";
import { resolveNotificationTarget } from "../notificationTarget";
import { useNotifications } from "../components/NotificationsProvider";
import {
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
  type SortState,
} from "../useTableSort";

/** Page size for the inbox; also the "load more" chunk. */
const PAGE_SIZE = 50;

/** Default sort: newest received first, matching the backend's list ordering. */
const NOTIFICATIONS_DEFAULT_SORT: SortState = {
  columnId: "received",
  direction: "descending",
};

/** Sort columns for the inbox; the Actions column doesn't sort. */
const NOTIFICATION_SORT_COLUMNS: SortColumn<NotificationRecord>[] = [
  { columnId: "notification", value: (r) => r.title || "(untitled)" },
  { columnId: "status", value: (r) => r.status },
  { columnId: "received", value: (r) => r.created_at },
];

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  tableWrap: {
    overflowX: "auto",
  },
  // Rows are click-through: navigate to whatever triggered the notification.
  // A pointer cursor + hover tint signals that, per Fluent conventions.
  clickableRow: {
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  // Unread rows read as bolder and tinted so they stand out from read ones.
  unreadRow: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
  },
  unreadTitle: {
    fontWeight: tokens.fontWeightSemibold,
  },
  body: {
    color: tokens.colorNeutralForeground2,
    whiteSpace: "pre-wrap",
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
  },
  loadMore: {
    marginTop: tokens.spacingVerticalL,
    display: "flex",
    justifyContent: "center",
  },
});

/**
 * Notifications inbox: a newest-first, cursor-paginated list of delivered
 * notifications with unread highlighting, per-row and bulk mark-read, and a
 * "load more" pager. Clicking a row navigates to whatever triggered it —
 * resolved client-side from the triggering event's opaque payload (run detail >
 * external url > event focus, see {@link resolveNotificationTarget}) — and also
 * marks the row read. Marking rows read reconciles the shared unread count so
 * the nav bell stays in sync.
 */
export function NotificationsPage() {
  const styles = useStyles();
  const navigate = useNavigate();
  const { refreshUnread } = useNotifications();

  // Per-row cache of the resolved triggering event, keyed by event_id. `null`
  // records a resolved-but-empty event (a 404) so a repeat click doesn't re-hit
  // the API. Kept in a ref: it never needs to trigger a re-render.
  const eventCache = useRef<Map<number, EventDetail | null>>(new Map());

  const [items, setItems] = useState<NotificationRecord[]>([]);
  // Committed (debounced) server-side search query; "" means no filter.
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Load the newest page. Runs on mount and whenever the search query changes —
  // a new query resets pagination and reloads from the top.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await listNotifications({ limit: PAGE_SIZE, q: query });
      if (!mounted.current) return;
      setItems(page);
      setHasMore(page.length === PAGE_SIZE);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    const cursor = items[items.length - 1]?.id;
    if (cursor === undefined) return;
    setLoadingMore(true);
    try {
      const page = await listNotifications({ limit: PAGE_SIZE, cursor, q: query });
      if (!mounted.current) return;
      setItems((prev) => [...prev, ...page]);
      setHasMore(page.length === PAGE_SIZE);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [items, query]);

  const onMarkRead = useCallback(
    async (record: NotificationRecord) => {
      if (record.read_at !== null) return;
      try {
        const updated = await markNotificationRead(record.id);
        if (!mounted.current) return;
        setItems((prev) =>
          prev.map((r) => (r.id === updated.id ? updated : r)),
        );
        refreshUnread();
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshUnread],
  );

  // Clicking a row marks it read and navigates to whatever triggered it. The
  // target is resolved from the triggering event's opaque payload, fetched (and
  // cached) on demand; a null event_id or a 404 navigates nowhere but still
  // marks read.
  const onRowClick = useCallback(
    async (record: NotificationRecord) => {
      void onMarkRead(record);
      if (record.event_id === null) return;
      try {
        let event = eventCache.current.get(record.event_id);
        if (event === undefined) {
          try {
            event = await getEvent(record.event_id);
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) event = null;
            else throw err;
          }
          eventCache.current.set(record.event_id, event ?? null);
        }
        const target = resolveNotificationTarget(event);
        switch (target.kind) {
          case "run":
            navigate(`/runs/${target.dispatchId}`);
            break;
          case "external":
            window.open(target.url, "_blank", "noopener,noreferrer");
            break;
          case "event":
            navigate(`/events?id=${target.eventId}`);
            break;
          case "none":
            break;
        }
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [navigate, onMarkRead],
  );

  const onMarkAllRead = useCallback(async () => {
    try {
      await markAllNotificationsRead();
      if (!mounted.current) return;
      // Re-read from the top: bulk read stamps every unread row.
      await load();
      refreshUnread();
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load, refreshUnread]);

  const { sorted, sortState, toggleSort } = useTableSort(
    items,
    NOTIFICATION_SORT_COLUMNS,
    NOTIFICATIONS_DEFAULT_SORT,
  );

  const hasUnread = items.some((r) => r.read_at === null);

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Notifications</Title1>
        <Button
          appearance="primary"
          disabled={!hasUnread}
          onClick={() => void onMarkAllRead()}
        >
          Mark all read
        </Button>
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      <TableSearch
        onSearch={setQuery}
        placeholder="Search notifications…"
        label="Search notifications"
        resultCount={items.length}
      />

      {loading ? (
        <Spinner label="Loading notifications…" />
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          <Text>
            {query.trim()
              ? "No notifications match your search."
              : "No notifications yet."}
          </Text>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <Table aria-label="Notifications">
            <TableHeader>
              <TableRow>
                <SortableHeaderCell columnId="notification" sortState={sortState} onSort={toggleSort}>
                  Notification
                </SortableHeaderCell>
                <SortableHeaderCell columnId="status" sortState={sortState} onSort={toggleSort}>
                  Status
                </SortableHeaderCell>
                <SortableHeaderCell columnId="received" sortState={sortState} onSort={toggleSort}>
                  Received
                </SortableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((record) => {
                const unread = record.read_at === null;
                return (
                  <TableRow
                    key={record.id}
                    className={mergeClasses(
                      styles.clickableRow,
                      unread && styles.unreadRow,
                    )}
                    onClick={() => void onRowClick(record)}
                  >
                    <TableCell>
                      <div>
                        <Text
                          className={unread ? styles.unreadTitle : undefined}
                        >
                          {record.title || "(untitled)"}
                        </Text>
                      </div>
                      {record.body && (
                        <Text as="p" className={styles.body}>
                          {record.body}
                        </Text>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        appearance="tint"
                        color={record.status === "failed" ? "danger" : "success"}
                      >
                        {record.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {new Date(record.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className={styles.actions}>
                        <Button
                          size="small"
                          disabled={!unread}
                          onClick={(ev) => {
                            // The row click already marks read; don't also
                            // navigate when the explicit button is used.
                            ev.stopPropagation();
                            void onMarkRead(record);
                          }}
                        >
                          {unread ? "Mark read" : "Read"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {hasMore && (
            <div className={styles.loadMore}>
              <Button
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
