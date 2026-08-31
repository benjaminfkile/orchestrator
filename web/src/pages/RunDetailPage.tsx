import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  makeStyles,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Text,
  Title1,
  Title3,
  tokens,
  type BadgeProps,
} from "@fluentui/react-components";
import { Link as RouterLink, useParams } from "react-router-dom";
import { ApiError } from "../api";
import { SubjectCell } from "../components/SubjectCell";
import { WriteupView } from "../components/WriteupView";
import {
  cancelDispatch,
  getDispatch,
  getEvent,
  getPlaybook,
  streamDispatchLog,
  type DispatchDetail,
  type DispatchStatus,
  type EventDetail,
  type PlaybookDetail,
  type Run,
  type TokenUsage,
} from "../dispatches";
import {
  LOADED_ORDER_SORT,
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
} from "../useTableSort";

/** How often the dispatch record is re-read while the run is still in flight. */
const DISPATCH_POLL_MS = 3000;

/** Delay before retrying the log stream when the log file does not exist yet. */
const LOG_RETRY_MS = 1500;

/** How close to the bottom (px) still counts as "pinned" for auto-scroll. */
const SCROLL_THRESHOLD_PX = 24;

/** Statuses at which a dispatch is finished and its runs stop changing. */
const TERMINAL_STATUSES: ReadonlySet<DispatchStatus> = new Set([
  "done",
  "failed",
  "cancelled",
]);

/** The non-terminal pipeline stages, in the order a dispatch advances through. */
const PIPELINE_STAGES = [
  "queued",
  "leasing",
  "running",
  "collecting",
] as const;

/** Position of each status along the pipeline; terminal states sit past the end. */
const STAGE_INDEX: Record<DispatchStatus, number> = {
  queued: 0,
  leasing: 1,
  running: 2,
  collecting: 3,
  done: 4,
  failed: 4,
  cancelled: 4,
};

/** The four token counters shown in the usage table, with display labels. */
const USAGE_FIELDS: ReadonlyArray<[keyof TokenUsage, string]> = [
  ["input_tokens", "Input"],
  ["output_tokens", "Output"],
  ["cache_creation_input_tokens", "Cache creation"],
  ["cache_read_input_tokens", "Cache read"],
];

/** One row of the token-usage table: a counter label and its token count. */
interface UsageRow {
  key: string;
  label: string;
  tokens: number;
}

/** Sort columns for the token-usage table. It starts in its canonical order
 * (see {@link LOADED_ORDER_SORT}) — inputs before outputs before caches — until
 * a header is clicked, then sorts by counter name or token count. */
const USAGE_SORT_COLUMNS: SortColumn<UsageRow>[] = [
  { columnId: "counter", value: (r) => r.label },
  { columnId: "tokens", value: (r) => r.tokens },
];

/** Badge color per lifecycle state; terminal states read at a glance. */
const STATUS_COLOR: Record<DispatchStatus, BadgeProps["color"]> = {
  queued: "informative",
  leasing: "informative",
  running: "brand",
  collecting: "brand",
  done: "success",
  failed: "danger",
  cancelled: "subtle",
};

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  titleGroup: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
  },
  section: {
    marginBottom: tokens.spacingVerticalXL,
  },
  tableWrap: {
    overflowX: "auto",
  },
  sectionTitle: {
    marginBottom: tokens.spacingVerticalM,
  },
  cards: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalL,
  },
  card: {
    flex: "1 1 320px",
    minWidth: "280px",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    padding: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM}`,
  },
  kv: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
  },
  kvKey: {
    minWidth: "84px",
    color: tokens.colorNeutralForeground3,
  },
  timeline: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  timelineRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
  },
  timelineLabel: {
    minWidth: "120px",
  },
  timelineTs: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  logToolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalS,
  },
  logPane: {
    height: "360px",
    overflowY: "auto",
    margin: 0,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  logEmpty: {
    color: tokens.colorNeutralForeground3,
  },
  findings: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  finding: {
    padding: tokens.spacingVerticalM,
  },
  findingMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  findingContent: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  eventsLink: {
    color: tokens.colorBrandForegroundLink,
    fontSize: tokens.fontSizeBase300,
    textDecorationLine: "none",
    ":hover": {
      textDecorationLine: "underline",
    },
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
});

/** Format an epoch-millis timestamp, tolerating a null/undefined. */
function formatTs(ts: number | null | undefined): string {
  return ts === null || ts === undefined ? "—" : new Date(ts).toLocaleString();
}

/** The visual state of one timeline stage relative to the current status. */
type StageState = "done" | "active" | "pending" | "failed";

interface TimelineStage {
  label: string;
  state: StageState;
  ts: number | null;
}

/**
 * Derive the ordered timeline stages from the dispatch and its latest run.
 * Stages before the current status read as done, the current one as active, and
 * later ones as pending; a terminal `failed` marks its final row accordingly.
 * Timestamps are attached where the data records them (queue time, run start,
 * run end).
 */
function buildTimeline(
  dispatch: DispatchDetail,
  latestRun: Run | undefined,
): TimelineStage[] {
  const current = STAGE_INDEX[dispatch.status];
  const terminal = TERMINAL_STATUSES.has(dispatch.status);

  const tsFor = (index: number): number | null => {
    if (index === 0) return dispatch.created_at;
    if (index === 2) return latestRun?.started_at ?? null;
    return null;
  };

  const stages: TimelineStage[] = PIPELINE_STAGES.map((label, index) => ({
    label,
    state:
      index < current ? "done" : index === current ? "active" : "pending",
    ts: tsFor(index),
  }));

  // Final row: the terminal outcome once reached, otherwise the pending
  // "completed" step the pipeline is still working toward. A `cancelled`
  // outcome reads as "failed" visually (the run ended without success), but
  // its label is the status itself so an operator sees the abort clearly.
  const terminalTs = latestRun?.ended_at ?? (terminal ? dispatch.updated_at : null);
  stages.push({
    label: terminal ? dispatch.status : "completed",
    state:
      dispatch.status === "failed" || dispatch.status === "cancelled"
        ? "failed"
        : dispatch.status === "done"
          ? "done"
          : "pending",
    ts: terminalTs,
  });

  return stages;
}

/** Badge for one timeline stage's state. */
function StageBadge({ state }: { state: StageState }) {
  const color: BadgeProps["color"] =
    state === "failed"
      ? "danger"
      : state === "done"
        ? "success"
        : state === "active"
          ? "brand"
          : "subtle";
  const appearance: BadgeProps["appearance"] =
    state === "pending" ? "outline" : "filled";
  return (
    <Badge appearance={appearance} color={color}>
      {state}
    </Badge>
  );
}

/**
 * Runs detail: a status timeline, playbook and triggering-event summary cards, a
 * live auto-scrolling log viewer, and — once the run finishes — its result text,
 * findings, and token-usage table.
 */
export function RunDetailPage() {
  const styles = useStyles();
  const { id: idParam } = useParams();
  const id = Number(idParam);

  const [dispatch, setDispatch] = useState<DispatchDetail | null>(null);
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [playbook, setPlaybook] = useState<PlaybookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [log, setLog] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // True while the cancel request is in flight, so the button disables
  // (and reads "Cancelling…") until it settles.
  const [cancelling, setCancelling] = useState(false);
  // Set from the cancel handler so a 409 (already-terminal dispatch, no
  // in-flight controller) surfaces inline rather than hiding in a toast.
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Latest status, read by the log-stream retry loop without re-subscribing.
  const statusRef = useRef<DispatchStatus | null>(null);
  const paneRef = useRef<HTMLPreElement>(null);

  // Poll the dispatch record until it reaches a terminal status, so the
  // timeline advances and the result/findings/usage panels appear on completion.
  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) {
      setError("Invalid dispatch id.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const next = await getDispatch(id);
        if (cancelled) return;
        setDispatch(next);
        statusRef.current = next.status;
        setError(null);
        setNotFound(false);
        if (!TERMINAL_STATUSES.has(next.status)) {
          timer = setTimeout(() => void tick(), DISPATCH_POLL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  // Resolve the trigger event and playbook once their ids are known. They are
  // immutable for a dispatch, so this loads exactly once.
  const eventId = dispatch?.event_id;
  const playbookId = dispatch?.playbook_id;
  useEffect(() => {
    if (eventId === undefined || playbookId === undefined) return;
    let cancelled = false;
    void (async () => {
      const [ev, pb] = await Promise.all([
        getEvent(eventId).catch(() => null),
        getPlaybook(playbookId).catch(() => null),
      ]);
      if (cancelled) return;
      setEvent(ev);
      setPlaybook(pb);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, playbookId]);

  // Stream the log for the life of the page. The backend keeps the response
  // open until the dispatch is terminal; a 404 means the log file does not
  // exist yet, so retry until it appears (or the dispatch finishes without one).
  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      try {
        await streamDispatchLog(id, {
          signal: controller.signal,
          onChunk: (text) => setLog((prev) => prev + text),
        });
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof ApiError && err.status === 404) {
          // No log yet. Keep polling unless the dispatch already finished
          // without producing one.
          if (!statusRef.current || !TERMINAL_STATUSES.has(statusRef.current)) {
            retryTimer = setTimeout(() => void run(), LOG_RETRY_MS);
          }
          return;
        }
        setLogError(err instanceof Error ? err.message : String(err));
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
    };
  }, [id]);

  // Keep the log pinned to the bottom while auto-scroll is engaged.
  useEffect(() => {
    if (!autoScroll) return;
    const el = paneRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, autoScroll]);

  // Pause auto-scroll when the user scrolls up; re-engage at the bottom.
  const onScroll = useCallback(() => {
    const el = paneRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distance <= SCROLL_THRESHOLD_PX);
  }, []);

  // Cancel this run. The dispatch-poll loop above picks up the new terminal
  // state on its next tick, so the status badge and timeline flip live once
  // the executor's abort settles.
  const onCancel = useCallback(async () => {
    const ok = window.confirm(
      `Cancel dispatch #${id}? Its lease will still be released.`,
    );
    if (!ok) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelDispatch(id);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }, [id]);

  const latestRun = useMemo(
    () => (dispatch && dispatch.runs.length ? dispatch.runs[dispatch.runs.length - 1] : undefined),
    [dispatch],
  );
  const timeline = useMemo(
    () => (dispatch ? buildTimeline(dispatch, latestRun) : []),
    [dispatch, latestRun],
  );
  const isTerminal = dispatch ? TERMINAL_STATUSES.has(dispatch.status) : false;

  if (loading) {
    return <Spinner label="Loading run…" />;
  }

  if (notFound) {
    return (
      <section>
        <Title1 as="h1">Run #{idParam}</Title1>
        <Text as="p" className={styles.muted}>
          Dispatch not found.
        </Text>
      </section>
    );
  }

  return (
    <section>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <Title1 as="h1">Run #{id}</Title1>
          {dispatch && (
            <Badge appearance="filled" color={STATUS_COLOR[dispatch.status]}>
              {dispatch.status}
            </Badge>
          )}
        </div>
        {dispatch && !TERMINAL_STATUSES.has(dispatch.status) && (
          <Button
            appearance="secondary"
            disabled={cancelling}
            onClick={() => void onCancel()}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      {cancelError && (
        <Text as="p" className={styles.error} role="alert">
          {cancelError}
        </Text>
      )}

      {dispatch && (
        <>
          <div className={styles.section}>
            <Title3 as="h2" className={styles.sectionTitle}>
              Timeline
            </Title3>
            <ol className={styles.timeline} aria-label="Status timeline">
              {timeline.map((stage) => (
                <li key={stage.label} className={styles.timelineRow}>
                  <Text className={styles.timelineLabel} weight="semibold">
                    {stage.label}
                  </Text>
                  <StageBadge state={stage.state} />
                  <span className={styles.timelineTs}>{formatTs(stage.ts)}</span>
                </li>
              ))}
            </ol>
            {dispatch.error && (
              <Text as="p" className={styles.error} role="alert">
                {dispatch.error}
              </Text>
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.cards}>
              <Card className={styles.card}>
                <CardHeader header={<Title3 as="h3">Playbook</Title3>} />
                <div className={styles.cardBody}>
                  <div className={styles.kv}>
                    <Text className={styles.kvKey}>Name</Text>
                    <Text weight="semibold">
                      {playbook?.name ?? `playbook #${dispatch.playbook_id}`}
                    </Text>
                  </div>
                  {playbook && (
                    <>
                      <div className={styles.kv}>
                        <Text className={styles.kvKey}>Image</Text>
                        <Text>{playbook.image}</Text>
                      </div>
                      <div className={styles.kv}>
                        <Text className={styles.kvKey}>Runner</Text>
                        <Text>{playbook.runner}</Text>
                      </div>
                      <div className={styles.kv}>
                        <Text className={styles.kvKey}>Output</Text>
                        <Text>{playbook.output_kind}</Text>
                      </div>
                    </>
                  )}
                </div>
              </Card>

              <Card className={styles.card}>
                <CardHeader
                  header={<Title3 as="h3">Triggering event</Title3>}
                  action={
                    <RouterLink to="/events" className={styles.eventsLink}>
                      View events
                    </RouterLink>
                  }
                />
                <div className={styles.cardBody}>
                  {/* Subject comes off the dispatch itself, so it renders even
                      if the standalone event fetch fails. */}
                  <div className={styles.kv}>
                    <Text className={styles.kvKey}>Subject</Text>
                    {/* The card lists the event Type on its own row below, so the
                        cell omits its secondary event-type line here. */}
                    <SubjectCell fields={dispatch} showEventType={false} />
                  </div>
                  {event ? (
                    <>
                      <div className={styles.kv}>
                        <Text className={styles.kvKey}>Type</Text>
                        <Text weight="semibold">{event.type}</Text>
                      </div>
                      <div className={styles.kv}>
                        <Text className={styles.kvKey}>Source</Text>
                        <Text>{event.source}</Text>
                      </div>
                      <div className={styles.kv}>
                        <Text className={styles.kvKey}>Ref</Text>
                        <Text>
                          {event.subject_kind}: {event.subject_ref}
                        </Text>
                      </div>
                      <div className={styles.kv}>
                        <Text className={styles.kvKey}>Occurred</Text>
                        <Text>{formatTs(event.ts)}</Text>
                      </div>
                    </>
                  ) : (
                    <Text className={styles.muted}>
                      event #{dispatch.event_id}
                    </Text>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.logToolbar}>
              <Title3 as="h2">Log</Title3>
              <Badge
                appearance="outline"
                color={autoScroll ? "brand" : "subtle"}
              >
                {autoScroll ? "Auto-scrolling" : "Scroll paused"}
              </Badge>
            </div>
            {logError && (
              <Text as="p" className={styles.error} role="alert">
                {logError}
              </Text>
            )}
            <pre
              ref={paneRef}
              className={styles.logPane}
              aria-label="Log output"
              tabIndex={0}
              onScroll={onScroll}
            >
              {log || (
                <span className={styles.logEmpty}>
                  {isTerminal ? "No log output." : "Waiting for log output…"}
                </span>
              )}
            </pre>
          </div>

          {isTerminal && (
            <CompletedPanels run={latestRun} styles={styles} />
          )}
        </>
      )}
    </section>
  );
}

/** The result-text, findings, and token-usage panels shown once a run ends. */
function CompletedPanels({
  run,
  styles,
}: {
  run: Run | undefined;
  styles: ReturnType<typeof useStyles>;
}) {
  const usage = run?.usage ?? null;
  const findings = run?.findings ?? [];

  // Flatten the usage object into rows: the known counters in canonical order,
  // then any extra keys the payload carries. Sorting acts over this whole list.
  const usageRows = useMemo<UsageRow[]>(() => {
    if (!usage) return [];
    const known = USAGE_FIELDS.map(([field, label]) => ({
      key: field as string,
      label,
      tokens: usage[field] ?? 0,
    }));
    const extra = Object.keys(usage)
      .filter((k) => !USAGE_FIELDS.some(([field]) => field === k))
      .map((k) => ({ key: k, label: k, tokens: usage[k] ?? 0 }));
    return [...known, ...extra];
  }, [usage]);
  const {
    sorted: sortedUsage,
    sortState: usageSort,
    toggleSort: toggleUsageSort,
  } = useTableSort(usageRows, USAGE_SORT_COLUMNS, LOADED_ORDER_SORT);

  return (
    <>
      <div className={styles.section}>
        <Title3 as="h2" className={styles.sectionTitle}>
          Result
        </Title3>
        <WriteupView text={run?.result_text ?? null} ariaLabel="Result text" />
      </div>

      <div className={styles.section}>
        <Title3 as="h2" className={styles.sectionTitle}>
          Findings
        </Title3>
        {findings.length === 0 ? (
          <Text className={styles.muted}>No findings recorded.</Text>
        ) : (
          <div className={styles.findings} aria-label="Findings">
            {findings.map((finding) => (
              <Card key={finding.id} className={styles.finding}>
                <Text as="p" className={styles.findingContent}>
                  {finding.content}
                </Text>
                <div className={styles.findingMeta}>
                  <Badge appearance="tint" color="informative">
                    {finding.visibility}
                  </Badge>
                  {finding.tags.map((tag) => (
                    <Badge key={tag} appearance="outline" color="brand">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <Title3 as="h2" className={styles.sectionTitle}>
          Token usage
        </Title3>
        {usage === null ? (
          <Text className={styles.muted}>No usage recorded.</Text>
        ) : (
          <div className={styles.tableWrap}>
          <Table aria-label="Token usage" size="small">
            <TableHeader>
              <TableRow>
                <SortableHeaderCell
                  columnId="counter"
                  sortState={usageSort}
                  onSort={toggleUsageSort}
                >
                  Counter
                </SortableHeaderCell>
                <SortableHeaderCell
                  columnId="tokens"
                  sortState={usageSort}
                  onSort={toggleUsageSort}
                >
                  Tokens
                </SortableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedUsage.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell>{row.tokens.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        )}
      </div>
    </>
  );
}
