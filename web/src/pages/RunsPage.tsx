import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
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
  DISPATCH_STATUSES,
  getDispatch,
  listPlaybooks,
  listRuns,
  rerunDispatch,
  retryDispatch,
  type DispatchStatus,
  type RunHistoryEntry,
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

/** How often the history reloads while auto-refresh is enabled. */
const REFRESH_INTERVAL_MS = 5000;

/** Default sort: newest run first, matching the backend's list ordering. */
const RUNS_DEFAULT_SORT: SortState = {
  columnId: "started",
  direction: "descending",
};

/** Badge color per lifecycle state; matches the Queue page for consistency. */
const STATUS_COLOR: Record<DispatchStatus, BadgeProps["color"]> = {
  queued: "informative",
  leasing: "informative",
  running: "brand",
  collecting: "brand",
  done: "success",
  failed: "danger",
};

/** Longest error text shown inline in the Outcome column before it is elided. */
const ERROR_MAX = 80;

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
  outcomeError: {
    color: tokens.colorPaletteRedForeground1,
  },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
});

/** Loaded history rows plus the lookup map used to label each run's playbook. */
interface RunsData {
  runs: RunHistoryEntry[];
  playbookNames: Map<number, string>;
}

const EMPTY_DATA: RunsData = { runs: [], playbookNames: new Map() };

/** Fetch the run history (optionally status- and text-filtered) and playbook
 * names. `q` is a server-side free-text filter; blank means no filter. */
async function loadRuns(
  status: DispatchStatus | "all",
  q: string,
): Promise<RunsData> {
  const [runs, playbooks] = await Promise.all([
    listRuns({ status: status === "all" ? undefined : status, q }),
    listPlaybooks(),
  ]);
  return {
    runs,
    playbookNames: new Map(playbooks.map((p) => [p.id, p.name])),
  };
}

/** Human-readable elapsed time; blank when the run never produced a duration. */
function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${rem}s`;
}

/** Truncate error text to keep the Outcome column from ballooning a row. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Build the manual-run dialog's human label from a run-history row's subject. */
function eventLabel(row: RunHistoryEntry): string {
  return [row.event_type, row.subject_ref]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
}

/**
 * Runs history: one row per dispatch (the unit of a run), newest first, backed
 * by `GET /api/runs`. Shows the joined playbook name, a status badge, start
 * time, duration, token total, findings count, and an outcome (exit code, or the
 * failure's error text). A status filter (server-side) and a 5s auto-refresh
 * that can be paused mirror the Queue page. Clicking a row opens that dispatch's
 * runs detail.
 */
export function RunsPage() {
  const styles = useStyles();
  const truncateCell = useTruncateStyle();
  const navigate = useNavigate();

  const [data, setData] = useState<RunsData>(EMPTY_DATA);
  const [filter, setFilter] = useState<DispatchStatus | "all">("all");
  // Committed (debounced) server-side search query; "" means no filter.
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Dispatch ids with a re-run or event-resolve in flight, so their row actions
  // disable while the request is outstanding.
  const [busy, setBusy] = useState<Set<number>>(new Set());
  // The manual-run dialog's target event, or null when the dialog is closed.
  const [dialogEvent, setDialogEvent] = useState<RunPlaybookDialogEvent | null>(
    null,
  );

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
      const next = await loadRuns(filter, query);
      if (!mounted.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [filter, query]);

  // Initial load, and a reload whenever the status filter or search changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live: reload when a run finishes or its backing dispatch changes state.
  useLiveRefetch("runs", refresh);
  useLiveRefetch("dispatches", refresh);

  // Auto-refresh timer; torn down while paused so no requests fire.
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, refresh]);

  // Mark/unmark a dispatch id as busy while one of its row actions runs.
  const setBusyFor = useCallback((id: number, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Re-run a history row: queue a fresh dispatch of the same playbook on the
  // same event. The row omits the event id, so `rerunDispatch` resolves it from
  // the dispatch record first.
  const onRerun = useCallback(
    async (row: RunHistoryEntry) => {
      setBusyFor(row.dispatch_id, true);
      try {
        const created = await rerunDispatch(row.dispatch_id);
        if (!mounted.current) return;
        setSuccess(`Dispatch #${created.id} created.`);
        setError(null);
        await refresh();
      } catch (err) {
        if (mounted.current) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } finally {
        if (mounted.current) setBusyFor(row.dispatch_id, false);
      }
    },
    [refresh, setBusyFor],
  );

  // Retry a failed dispatch in place: requeue the SAME dispatch (attempts reset)
  // rather than creating a new one. Failed work no longer appears on the Queue,
  // so this is the history side's retry affordance. 409s if it isn't `failed`.
  const onRetry = useCallback(
    async (row: RunHistoryEntry) => {
      setBusyFor(row.dispatch_id, true);
      try {
        await retryDispatch(row.dispatch_id);
        if (!mounted.current) return;
        setSuccess(`Dispatch #${row.dispatch_id} requeued.`);
        setError(null);
        await refresh();
      } catch (err) {
        if (mounted.current) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } finally {
        if (mounted.current) setBusyFor(row.dispatch_id, false);
      }
    },
    [refresh, setBusyFor],
  );

  // Open the manual-run dialog against a history row's event. The row omits the
  // event id, so resolve it from the dispatch record before opening.
  const onRunPlaybook = useCallback(
    async (row: RunHistoryEntry) => {
      setBusyFor(row.dispatch_id, true);
      try {
        const detail = await getDispatch(row.dispatch_id);
        if (!mounted.current) return;
        setError(null);
        setDialogEvent({ id: detail.event_id, label: eventLabel(row) });
      } catch (err) {
        if (mounted.current) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } finally {
        if (mounted.current) setBusyFor(row.dispatch_id, false);
      }
    },
    [setBusyFor],
  );

  const rows = data.runs;

  // Sort columns mirror the rendered cells (the playbook label is joined in) so
  // a header click orders by what the user sees. Default: Started desc, the
  // backend's newest-first ordering, so the table agrees with the API on load.
  const sortColumns = useMemo<SortColumn<RunHistoryEntry>[]>(
    () => [
      {
        columnId: "playbook",
        value: (r) =>
          data.playbookNames.get(r.playbook_id) ?? `playbook #${r.playbook_id}`,
      },
      { columnId: "subject", value: (r) => r.subject_ref ?? null },
      { columnId: "status", value: (r) => r.status },
      { columnId: "started", value: (r) => r.created_at },
      { columnId: "duration", value: (r) => r.duration_ms },
      { columnId: "tokens", value: (r) => r.total_tokens },
      { columnId: "findings", value: (r) => r.findings_count },
      {
        columnId: "outcome",
        value: (r) =>
          r.status === "failed" && r.error ? r.error : r.exit_code,
      },
    ],
    [data.playbookNames],
  );
  const { sorted, sortState, toggleSort } = useTableSort(
    rows,
    sortColumns,
    RUNS_DEFAULT_SORT,
  );

  const empty = useMemo(() => !loading && rows.length === 0, [loading, rows]);

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Runs</Title1>
        <div className={styles.controls}>
          <div className={styles.filter}>
            <Text>Status</Text>
            <Select
              aria-label="Status"
              value={filter}
              onChange={(_, d) => setFilter(d.value as DispatchStatus | "all")}
            >
              <option value="all">All</option>
              {DISPATCH_STATUSES.map((s) => (
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
        placeholder="Search runs…"
        label="Search runs"
        resultCount={rows.length}
      />

      {loading ? (
        <Spinner label="Loading runs…" />
      ) : empty ? (
        <div className={styles.empty}>
          <Text>{query.trim() ? "No runs match your search." : "No runs yet."}</Text>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <Table aria-label="Run history">
            <TableHeader>
              <TableRow>
                <SortableHeaderCell columnId="playbook" sortState={sortState} onSort={toggleSort}>
                  Playbook
                </SortableHeaderCell>
                <SortableHeaderCell columnId="subject" sortState={sortState} onSort={toggleSort}>
                  Subject
                </SortableHeaderCell>
                <SortableHeaderCell columnId="status" sortState={sortState} onSort={toggleSort}>
                  Status
                </SortableHeaderCell>
                <SortableHeaderCell columnId="started" sortState={sortState} onSort={toggleSort}>
                  Started
                </SortableHeaderCell>
                <SortableHeaderCell columnId="duration" sortState={sortState} onSort={toggleSort}>
                  Duration
                </SortableHeaderCell>
                <SortableHeaderCell columnId="tokens" sortState={sortState} onSort={toggleSort}>
                  Tokens
                </SortableHeaderCell>
                <SortableHeaderCell columnId="findings" sortState={sortState} onSort={toggleSort}>
                  Findings
                </SortableHeaderCell>
                <SortableHeaderCell columnId="outcome" sortState={sortState} onSort={toggleSort}>
                  Outcome
                </SortableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow
                  key={r.dispatch_id}
                  className={styles.row}
                  onClick={() => navigate(`/runs/${r.dispatch_id}`)}
                >
                  <TableCell
                    className={truncateCell}
                    title={
                      data.playbookNames.get(r.playbook_id) ??
                      `playbook #${r.playbook_id}`
                    }
                  >
                    {data.playbookNames.get(r.playbook_id) ??
                      `playbook #${r.playbook_id}`}
                  </TableCell>
                  <TableCell>
                    <SubjectCell fields={r} />
                  </TableCell>
                  <TableCell>
                    <Badge appearance="filled" color={STATUS_COLOR[r.status]}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {new Date(r.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{formatDuration(r.duration_ms)}</TableCell>
                  <TableCell>
                    {r.total_tokens === null
                      ? ""
                      : r.total_tokens.toLocaleString()}
                  </TableCell>
                  <TableCell>{r.findings_count}</TableCell>
                  <TableCell>
                    {r.status === "failed" && r.error ? (
                      <span
                        className={styles.outcomeError}
                        title={r.error}
                      >
                        {truncate(r.error, ERROR_MAX)}
                      </span>
                    ) : r.exit_code === null ? (
                      ""
                    ) : (
                      `exit ${r.exit_code}`
                    )}
                  </TableCell>
                  <TableCell>
                    {/* Actions never navigate the row. */}
                    <div
                      className={styles.actions}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.status === "failed" && (
                        <Button
                          size="small"
                          disabled={busy.has(r.dispatch_id)}
                          onClick={() => void onRetry(r)}
                        >
                          Retry
                        </Button>
                      )}
                      <Button
                        size="small"
                        disabled={busy.has(r.dispatch_id)}
                        onClick={() => void onRerun(r)}
                      >
                        Re-run
                      </Button>
                      <Button
                        size="small"
                        disabled={busy.has(r.dispatch_id)}
                        onClick={() => void onRunPlaybook(r)}
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
        open={dialogEvent !== null}
        onOpenChange={(open) => {
          if (!open) setDialogEvent(null);
        }}
        event={dialogEvent ?? undefined}
        onDispatched={(d) => {
          setSuccess(`Dispatch #${d.id} created.`);
          void refresh();
        }}
      />
    </section>
  );
}
