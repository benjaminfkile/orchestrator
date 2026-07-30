import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  makeStyles,
  Select,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title1,
  tokens,
  type BadgeProps,
} from "@fluentui/react-components";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api";
import {
  ACTIVE_DISPATCH_STATUSES,
  createDispatch,
  listDispatches,
  listEvents,
  listPlaybooks,
  type ActiveDispatchStatus,
  type Dispatch,
  type DispatchStatus,
} from "../dispatches";
import { SubjectCell } from "../components/SubjectCell";
import { useLiveRefetch } from "../components/useLiveRefetch";
import { TableSearch } from "../components/TableSearch";
import {
  RunPlaybookDialog,
  type RunPlaybookDialogEvent,
} from "../components/RunPlaybookDialog";
import {
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
  type SortState,
} from "../useTableSort";
import { useTruncateStyle } from "../useTruncateStyle";

/**
 * The manual-run dialog is driven in two modes from this page: the header opens
 * it in `search` mode (find a work item), and a row's "Run playbook" action
 * opens it in `event` mode against that dispatch's existing event.
 */
type RunDialogState = { mode: "search" } | { mode: "event"; event: RunPlaybookDialogEvent };

/** Build the dialog's human label for a dispatch's triggering event. */
function eventLabel(eventType: string | undefined, subjectRef: string | null | undefined): string {
  return [eventType, subjectRef].filter((p) => p && p.length > 0).join(" ");
}

/** How often the queue reloads while auto-refresh is enabled. */
const REFRESH_INTERVAL_MS = 5000;

/** Default sort: newest created first, matching the backend's list ordering. */
const QUEUE_DEFAULT_SORT: SortState = {
  columnId: "created",
  direction: "descending",
};

/** Badge color per lifecycle state; terminal states read at a glance. */
const STATUS_COLOR: Record<DispatchStatus, BadgeProps["color"]> = {
  queued: "informative",
  leasing: "informative",
  running: "brand",
  collecting: "brand",
  done: "success",
  failed: "danger",
};

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalL,
  },
  filter: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalSNudge,
  },
  tiles: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  tile: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: "110px",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  tileCount: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightHero700,
  },
  row: {
    cursor: "pointer",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
  },
  tableWrap: {
    overflowX: "auto",
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
  holdBadge: {
    marginLeft: tokens.spacingHorizontalXS,
  },
});

/**
 * A human-readable tooltip explaining why a queued dispatch is held by the
 * budget gate: which limit tripped and when the window next frees a slot.
 */
function budgetHoldTitle(d: Dispatch): string {
  const when =
    d.next_eligible_at != null
      ? new Date(d.next_eligible_at).toLocaleString()
      : "the window slides";
  if (d.token_breaker) {
    return `Held by the token circuit breaker (${d.window_tokens ?? "?"} tokens over the ${d.token_budget ?? "?"} budget in the trailing window). Eligible ${when}.`;
  }
  return `Held by the run budget (${d.window_count} of ${d.budget ?? "?"} runs started in the trailing window). Eligible ${when}.`;
}

/** Loaded queue data plus the lookup maps used to label each dispatch row. */
interface QueueData {
  dispatches: Dispatch[];
  eventTypes: Map<number, string>;
  playbookNames: Map<number, string>;
}

const EMPTY_DATA: QueueData = {
  dispatches: [],
  eventTypes: new Map(),
  playbookNames: new Map(),
};

/**
 * Fetch the queue and the reference data needed to render it, in parallel. The
 * dispatch list is fetched `active` so it only ever holds non-terminal work —
 * the Queue is a queue, not a history (terminal runs live on the Runs page).
 * `q` is an optional server-side free-text filter; blank means no filter.
 */
async function loadQueue(q: string): Promise<QueueData> {
  const [dispatches, events, playbooks] = await Promise.all([
    listDispatches({ active: true, q }),
    listEvents(),
    listPlaybooks(),
  ]);
  return {
    dispatches,
    eventTypes: new Map(events.map((e) => [e.id, e.type])),
    playbookNames: new Map(playbooks.map((p) => [p.id, p.name])),
  };
}

/**
 * Queue dashboard: counts-by-status tiles over the non-terminal states, a
 * status-filterable table of only waiting/in-flight dispatches, and a 5s
 * auto-refresh that can be paused. Terminal (done/failed) history is NOT shown
 * here — it lives on the Runs page, which offers retry. Clicking a row opens
 * that dispatch's runs detail.
 */
export function QueuePage() {
  const styles = useStyles();
  const truncate = useTruncateStyle();
  const navigate = useNavigate();

  const [data, setData] = useState<QueueData>(EMPTY_DATA);
  const [filter, setFilter] = useState<ActiveDispatchStatus | "all">("all");
  // Committed (debounced) server-side search query; "" means no filter.
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Dispatch ids with a re-run in flight, so their row actions disable.
  const [rerunning, setRerunning] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<RunDialogState | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Guard against a slow reload landing after the component unmounts.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await loadQueue(query);
      if (!mounted.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [query]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live: silently reload the queue whenever a dispatch changes anywhere.
  useLiveRefetch("dispatches", refresh);

  // Auto-refresh timer; torn down while paused so no requests fire.
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, refresh]);

  const counts = useMemo(() => {
    const tally = Object.fromEntries(
      ACTIVE_DISPATCH_STATUSES.map((s) => [s, 0]),
    ) as Record<ActiveDispatchStatus, number>;
    // The list is fetched `active`, so every row is one of these states.
    for (const d of data.dispatches) {
      if (d.status in tally) tally[d.status as ActiveDispatchStatus] += 1;
    }
    return tally;
  }, [data.dispatches]);

  const visible = useMemo(
    () =>
      filter === "all"
        ? data.dispatches
        : data.dispatches.filter((d) => d.status === filter),
    [data.dispatches, filter],
  );

  // Sort columns extract the same values the cells render (labels included) so
  // clicking a header orders by what the user sees. Default: Created desc, the
  // backend's newest-first ordering, so the table agrees with the API on load.
  const sortColumns = useMemo<SortColumn<Dispatch>[]>(
    () => [
      { columnId: "id", value: (d) => d.id },
      {
        columnId: "event_type",
        value: (d) => data.eventTypes.get(d.event_id) ?? `event #${d.event_id}`,
      },
      { columnId: "subject", value: (d) => d.subject_ref ?? null },
      {
        columnId: "playbook",
        value: (d) =>
          data.playbookNames.get(d.playbook_id) ?? `playbook #${d.playbook_id}`,
      },
      { columnId: "status", value: (d) => d.status },
      { columnId: "attempts", value: (d) => d.attempts },
      { columnId: "created", value: (d) => d.created_at },
    ],
    [data.eventTypes, data.playbookNames],
  );
  const { sorted, sortState, toggleSort } = useTableSort(
    visible,
    sortColumns,
    QUEUE_DEFAULT_SORT,
  );

  // Re-run a dispatch: queue a fresh dispatch of the same playbook on the same
  // event. The Queue row already carries both ids, so no lookup is needed.
  const onRerun = useCallback(
    async (d: Dispatch) => {
      setRerunning((prev) => new Set(prev).add(d.id));
      try {
        const created = await createDispatch(d.event_id, d.playbook_id);
        if (!mounted.current) return;
        setSuccess(`Dispatch #${created.id} created.`);
        setError(null);
        await refresh();
      } catch (err) {
        if (mounted.current) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } finally {
        if (mounted.current) {
          setRerunning((prev) => {
            const next = new Set(prev);
            next.delete(d.id);
            return next;
          });
        }
      }
    },
    [refresh],
  );

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Queue</Title1>
        <div className={styles.controls}>
          <Button
            appearance="primary"
            onClick={() => setDialog({ mode: "search" })}
          >
            Run playbook
          </Button>
          <div className={styles.filter}>
            <Text>Status</Text>
            <Select
              aria-label="Status"
              value={filter}
              onChange={(_, d) =>
                setFilter(d.value as ActiveDispatchStatus | "all")
              }
            >
              <option value="all">All</option>
              {ACTIVE_DISPATCH_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <Switch
            checked={autoRefresh}
            onChange={(_, d) => setAutoRefresh(d.checked)}
            label={autoRefresh ? "Auto-refresh on" : "Auto-refresh paused"}
          />
        </div>
      </div>

      <div className={styles.tiles} role="group" aria-label="Status counts">
        {ACTIVE_DISPATCH_STATUSES.map((s) => (
          <Card key={s} className={styles.tile} aria-label={`${s} count`}>
            <span className={styles.tileCount}>{counts[s]}</span>
            <Badge appearance="tint" color={STATUS_COLOR[s]}>
              {s}
            </Badge>
          </Card>
        ))}
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
        placeholder="Search queue…"
        label="Search queue"
        resultCount={visible.length}
      />

      {loading ? (
        <Spinner label="Loading dispatches…" />
      ) : visible.length === 0 ? (
        <div className={styles.empty}>
          <Text>
            {query.trim()
              ? "No queued or in-flight dispatches match your search."
              : "The queue is empty — nothing waiting or running. Completed and failed runs live on the Runs page."}
          </Text>
        </div>
      ) : (
        <div className={styles.tableWrap}>
        <Table aria-label="Dispatch queue">
          <TableHeader>
            <TableRow>
              <SortableHeaderCell columnId="id" sortState={sortState} onSort={toggleSort}>
                ID
              </SortableHeaderCell>
              <SortableHeaderCell columnId="event_type" sortState={sortState} onSort={toggleSort}>
                Event type
              </SortableHeaderCell>
              <SortableHeaderCell columnId="subject" sortState={sortState} onSort={toggleSort}>
                Subject
              </SortableHeaderCell>
              <SortableHeaderCell columnId="playbook" sortState={sortState} onSort={toggleSort}>
                Playbook
              </SortableHeaderCell>
              <SortableHeaderCell columnId="status" sortState={sortState} onSort={toggleSort}>
                Status
              </SortableHeaderCell>
              <SortableHeaderCell columnId="attempts" sortState={sortState} onSort={toggleSort}>
                Attempts
              </SortableHeaderCell>
              <SortableHeaderCell columnId="created" sortState={sortState} onSort={toggleSort}>
                Created
              </SortableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((d) => (
              <TableRow
                key={d.id}
                className={styles.row}
                onClick={() => navigate(`/runs/${d.id}`)}
              >
                <TableCell>{d.id}</TableCell>
                <TableCell
                  className={truncate}
                  title={data.eventTypes.get(d.event_id) ?? `event #${d.event_id}`}
                >
                  {data.eventTypes.get(d.event_id) ?? `event #${d.event_id}`}
                </TableCell>
                <TableCell>
                  {/* The queue has a dedicated Event type column, so the cell
                      omits the secondary event-type line to avoid duplication. */}
                  <SubjectCell fields={d} showEventType={false} />
                </TableCell>
                <TableCell
                  className={truncate}
                  title={
                    data.playbookNames.get(d.playbook_id) ??
                    `playbook #${d.playbook_id}`
                  }
                >
                  {data.playbookNames.get(d.playbook_id) ??
                    `playbook #${d.playbook_id}`}
                </TableCell>
                <TableCell>
                  <Badge appearance="filled" color={STATUS_COLOR[d.status]}>
                    {d.status}
                  </Badge>
                  {d.status === "queued" && d.waiting_reason === "budget" && (
                    <Badge
                      className={styles.holdBadge}
                      appearance="tint"
                      color="warning"
                      title={budgetHoldTitle(d)}
                    >
                      budget hold
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{d.attempts}</TableCell>
                <TableCell>{new Date(d.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  {/* Actions never navigate the row. */}
                  <div
                    className={styles.actions}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="small"
                      disabled={rerunning.has(d.id)}
                      onClick={() => void onRerun(d)}
                    >
                      {rerunning.has(d.id) ? "Re-running…" : "Re-run"}
                    </Button>
                    <Button
                      size="small"
                      onClick={() =>
                        setDialog({
                          mode: "event",
                          event: {
                            id: d.event_id,
                            label: eventLabel(
                              data.eventTypes.get(d.event_id),
                              d.subject_ref,
                            ),
                          },
                        })
                      }
                    >
                      Run playbook
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      )}

      <RunPlaybookDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        event={dialog?.mode === "event" ? dialog.event : undefined}
        onDispatched={(d) => {
          setSuccess(`Dispatch #${d.id} created.`);
          void refresh();
        }}
      />
    </section>
  );
}
