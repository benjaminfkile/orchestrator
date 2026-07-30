import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AsyncCombobox } from "../components/AsyncCombobox";
import { useLiveRefetch } from "../components/useLiveRefetch";
import { RunPlaybookDialog } from "../components/RunPlaybookDialog";
import { TableSearch } from "../components/TableSearch";
import { getEventSources, getEventTypes } from "../discovery";
import { getEventById, listEvents, type EventRecord } from "../events";
import {
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
  type SortState,
} from "../useTableSort";
import { useTruncateStyle } from "../useTruncateStyle";

/** Default sort: newest event first, matching the backend's list ordering. */
const EVENTS_DEFAULT_SORT: SortState = {
  columnId: "timestamp",
  direction: "descending",
};

/** Sort columns for the events feed; the toggle and Actions columns don't sort. */
const EVENT_SORT_COLUMNS: SortColumn<EventRecord>[] = [
  { columnId: "source", value: (e) => e.source },
  { columnId: "type", value: (e) => e.type },
  { columnId: "subject", value: (e) => e.subject_ref ?? null },
  { columnId: "timestamp", value: (e) => e.ts },
];

/** Map a bare facet string list into AsyncCombobox options. */
const toOptions = (values: string[]) => values.map((value) => ({ value }));

/** Parse a numeric `?id=` focus target from the current URL, or null. */
function readFocusId(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("id");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** How many events to request per page (matches the backend default). */
const PAGE_SIZE = 50;

/** Columns rendered in the feed; the expansion row spans all of them. */
const COLUMN_COUNT = 6;

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  filters: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalL,
  },
  filter: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalSNudge,
  },
  row: {
    cursor: "pointer",
  },
  // A deep-link-focused row is tinted so it stands out after the auto-scroll.
  focusedRow: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
  },
  tableWrap: {
    overflowX: "auto",
  },
  toggleCell: {
    width: "36px",
  },
  detail: {
    backgroundColor: tokens.colorNeutralBackground2,
  },
  detailBody: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  indicators: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  payload: {
    margin: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowX: "auto",
  },
  loadMore: {
    display: "flex",
    justifyContent: "center",
    marginTop: tokens.spacingVerticalL,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
  success: {
    color: tokens.colorPaletteGreenForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
});

/** Format an epoch-millis timestamp for display, tolerating a null. */
function formatTs(ts: number | null): string {
  return ts === null ? "never" : new Date(ts).toLocaleString();
}

/** Detail body shown when an event row is expanded: lifecycle indicators plus
 * the pretty-printed payload JSON. */
function EventDetail({ event }: { event: EventRecord }) {
  const styles = useStyles();
  return (
    <div className={styles.detailBody}>
      <div className={styles.indicators}>
        <Badge appearance="outline" color={event.dedupe_key ? "brand" : "subtle"}>
          {event.dedupe_key ? `dedupe: ${event.dedupe_key}` : "no dedupe key"}
        </Badge>
        <Badge
          appearance="outline"
          color={event.cleared_at ? "success" : "informative"}
        >
          {event.cleared_at
            ? `cleared ${formatTs(event.cleared_at)}`
            : "not cleared"}
        </Badge>
        <Badge
          appearance="outline"
          color={event.last_dispatched_at ? "brand" : "subtle"}
        >
          {event.last_dispatched_at
            ? `last dispatched ${formatTs(event.last_dispatched_at)}`
            : "never dispatched"}
        </Badge>
      </div>
      <pre className={styles.payload} aria-label="Payload">
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </div>
  );
}

/**
 * Events feed: a reverse-chronological table of recorded events (source, type,
 * subject, timestamp). Rows expand to reveal the pretty-printed payload and
 * dedupe/cleared/last-dispatched indicators. Source and type-prefix filter
 * inputs narrow the loaded rows; a cursor-based "Load more" appends the next
 * page from the backend.
 */
export function EventsPage() {
  const styles = useStyles();
  const truncate = useTruncateStyle();

  const [events, setEvents] = useState<EventRecord[]>([]);
  const [sourceFilter, setSourceFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  // Committed (debounced) server-side search query; "" means no filter.
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchEvent, setDispatchEvent] = useState<EventRecord | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Optional `?id=<n>` deep-link focus (used by the Notifications inbox to jump
  // to a triggering event). Read from the URL directly so the page stays
  // router-context-free. Null when absent or non-numeric.
  const focusId = useMemo(() => readFocusId(), []);
  // Ensures the focus routine runs at most once per focused id.
  const focusHandled = useRef(false);

  // Guard against a slow load landing after the component unmounts.
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
      const page = await listEvents({ limit: PAGE_SIZE, q: query });
      if (!mounted.current) return;
      setEvents(page);
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

  // Live: silently reload the currently visible window (search + any loaded-more
  // pages) when an event is written, without the spinner the initial load shows.
  const liveRefetch = useCallback(async () => {
    try {
      const limit = Math.max(PAGE_SIZE, events.length);
      const page = await listEvents({ limit, q: query });
      if (!mounted.current) return;
      setEvents(page);
      setHasMore(page.length === limit);
      setError(null);
    } catch {
      // Background refresh: keep the current rows; a later change reconciles.
    }
  }, [events.length, query]);
  useLiveRefetch("events", liveRefetch);

  // Deep-link focus: once the first page has loaded, make sure the focused
  // event is present (fetching it directly if it fell outside the page),
  // expand it, and scroll it into view. Runs once per focused id.
  useEffect(() => {
    if (focusId === null || loading || focusHandled.current) return;
    focusHandled.current = true;
    let cancelled = false;
    (async () => {
      if (!events.some((e) => e.id === focusId)) {
        try {
          const event = await getEventById(focusId);
          if (cancelled || !mounted.current) return;
          setEvents((prev) =>
            prev.some((e) => e.id === event.id) ? prev : [event, ...prev],
          );
        } catch {
          // Absent (404) or a transport error: nothing to focus.
          return;
        }
      }
      if (cancelled || !mounted.current) return;
      setExpanded((prev) => {
        if (prev.has(focusId)) return prev;
        const next = new Set(prev);
        next.add(focusId);
        return next;
      });
      // Let the row render before scrolling to it.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          document
            .getElementById(`event-row-${focusId}`)
            ?.scrollIntoView({ block: "center" });
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusId, loading, events]);

  const onLoadMore = useCallback(async () => {
    const oldest = events[events.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const page = await listEvents({
        limit: PAGE_SIZE,
        before: oldest.id,
        q: query,
      });
      if (!mounted.current) return;
      setEvents((prev) => [...prev, ...page]);
      setHasMore(page.length === PAGE_SIZE);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [events, query]);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Filters are applied client-side to the loaded rows: source is a
  // case-insensitive substring match, type a case-insensitive prefix match.
  const visible = useMemo(() => {
    const source = sourceFilter.trim().toLowerCase();
    const type = typeFilter.trim().toLowerCase();
    return events.filter(
      (e) =>
        (source === "" || e.source.toLowerCase().includes(source)) &&
        (type === "" || e.type.toLowerCase().startsWith(type)),
    );
  }, [events, sourceFilter, typeFilter]);

  const { sorted, sortState, toggleSort } = useTableSort(
    visible,
    EVENT_SORT_COLUMNS,
    EVENTS_DEFAULT_SORT,
  );

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Events</Title1>
        <div className={styles.filters}>
          <div className={styles.filter}>
            <Text>Source</Text>
            <AsyncCombobox
              aria-label="Source"
              placeholder="Filter by source"
              value={sourceFilter}
              onChange={setSourceFilter}
              load={async () => toOptions(await getEventSources())}
            />
          </div>
          <div className={styles.filter}>
            <Text>Type</Text>
            <AsyncCombobox
              aria-label="Type prefix"
              placeholder="Filter by type prefix"
              value={typeFilter}
              onChange={setTypeFilter}
              load={async () => toOptions(await getEventTypes())}
            />
          </div>
        </div>
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      {success && (
        <Text as="p" className={styles.success} role="status">
          {success}
        </Text>
      )}

      <TableSearch
        onSearch={setQuery}
        placeholder="Search events…"
        label="Search events"
        resultCount={visible.length}
      />

      {loading ? (
        <Spinner label="Loading events…" />
      ) : visible.length === 0 ? (
        <div className={styles.empty}>
          <Text>
            {query.trim()
              ? "No events match your search."
              : "No events to show."}
          </Text>
        </div>
      ) : (
        <div className={styles.tableWrap}>
        <Table aria-label="Events">
          <TableHeader>
            <TableRow>
              <TableHeaderCell className={styles.toggleCell} />
              <SortableHeaderCell columnId="source" sortState={sortState} onSort={toggleSort}>
                Source
              </SortableHeaderCell>
              <SortableHeaderCell columnId="type" sortState={sortState} onSort={toggleSort}>
                Type
              </SortableHeaderCell>
              <SortableHeaderCell columnId="subject" sortState={sortState} onSort={toggleSort}>
                Subject
              </SortableHeaderCell>
              <SortableHeaderCell columnId="timestamp" sortState={sortState} onSort={toggleSort}>
                Timestamp
              </SortableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((e) => {
              const isOpen = expanded.has(e.id);
              return [
                <TableRow
                  key={e.id}
                  id={`event-row-${e.id}`}
                  className={mergeClasses(
                    styles.row,
                    e.id === focusId && styles.focusedRow,
                  )}
                  onClick={() => toggle(e.id)}
                >
                  <TableCell className={styles.toggleCell}>
                    <Button
                      appearance="subtle"
                      size="small"
                      aria-label={isOpen ? "Collapse event" : "Expand event"}
                      aria-expanded={isOpen}
                      onClick={(ev) => {
                        // The row already toggles; don't double-fire.
                        ev.stopPropagation();
                        toggle(e.id);
                      }}
                    >
                      {isOpen ? "▾" : "▸"}
                    </Button>
                  </TableCell>
                  <TableCell className={truncate} title={e.source}>
                    {e.source}
                  </TableCell>
                  <TableCell className={truncate} title={e.type}>
                    {e.type}
                  </TableCell>
                  <TableCell className={truncate} title={e.subject_ref}>
                    {e.subject_ref}
                  </TableCell>
                  <TableCell>{formatTs(e.ts)}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      onClick={(ev) => {
                        // The row toggles on click; don't expand when dispatching.
                        ev.stopPropagation();
                        setDispatchEvent(e);
                      }}
                    >
                      Dispatch playbook
                    </Button>
                  </TableCell>
                </TableRow>,
                isOpen ? (
                  <TableRow key={`${e.id}-detail`} className={styles.detail}>
                    <TableCell colSpan={COLUMN_COUNT}>
                      <EventDetail event={e} />
                    </TableCell>
                  </TableRow>
                ) : null,
              ];
            })}
          </TableBody>
        </Table>
        </div>
      )}

      {!loading && hasMore && (
        <div className={styles.loadMore}>
          <Button onClick={() => void onLoadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <RunPlaybookDialog
        open={dispatchEvent !== null}
        onOpenChange={(open) => {
          if (!open) setDispatchEvent(null);
        }}
        event={
          dispatchEvent
            ? {
                id: dispatchEvent.id,
                label: `${dispatchEvent.type} ${dispatchEvent.subject_ref}`,
              }
            : undefined
        }
        onDispatched={(d) => setSuccess(`Dispatch #${d.id} created.`)}
      />
    </section>
  );
}
