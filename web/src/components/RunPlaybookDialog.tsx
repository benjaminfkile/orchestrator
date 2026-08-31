// The manual "run a playbook" dialog, shared by two entry points:
//
//   - Queue page (search mode): pick a TARGET TYPE (work item or pull request),
//     find the target (work items: search-as-you-type; PRs: filter the list of
//     ACTIVE PRs), pick a playbook, then Run = materialize the target into an
//     event and queue a dispatch against it.
//   - Events page (event mode): the caller passes an existing `event`, so the
//     search step is skipped; pick a playbook and dispatch against that event.
//
// Both modes share one playbook picker and one Run action; the only difference
// is whether an event id already exists or must be materialized first. All API
// calls go through the typed helpers in `../discovery` and `../dispatches`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  Text,
  tokens,
} from "@fluentui/react-components";
import { ApiError } from "../api";
import { createDispatch, type Dispatch } from "../dispatches";
import {
  listAdoPullRequests,
  materializePullRequest,
  materializeWorkItem,
  searchWorkItems,
  type PullRequestDiscoveryRow,
  type WorkItemSearchRow,
} from "../discovery";
import { listPlaybooks, type PlaybookRecord } from "../playbooks";

/** How long to wait after the last keystroke before firing a search. */
const SEARCH_DEBOUNCE_MS = 300;

/** The existing event to dispatch against in event mode. */
export interface RunPlaybookDialogEvent {
  id: number;
  /** Human-readable label shown in the dialog (e.g. "ado.workitem 42"). */
  label?: string;
}

interface RunPlaybookDialogProps {
  open: boolean;
  /** Called with `false` when the dialog should close. */
  onOpenChange: (open: boolean) => void;
  /**
   * When set, dispatch against this existing event (Events page) and skip the
   * work-item search. When omitted, the dialog searches for and materializes a
   * work item first (Queue page).
   */
  event?: RunPlaybookDialogEvent;
  /** Invoked with the created dispatch after a successful run. */
  onDispatched?: (dispatch: Dispatch) => void;
}

const useStyles = makeStyles({
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  results: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    maxHeight: "260px",
    overflowY: "auto",
  },
  resultLabel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  resultTitle: {
    fontWeight: tokens.fontWeightSemibold,
  },
  resultMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

/** Target kinds the search step can pick from (work item, pull request). */
type TargetType = "work_item" | "pull_request";

/**
 * Manual playbook run/dispatch dialog. See the module comment for the two modes.
 */
export function RunPlaybookDialog({
  open,
  onOpenChange,
  event,
  onDispatched,
}: RunPlaybookDialogProps): JSX.Element {
  const styles = useStyles();
  const searchMode = event === undefined;

  const [playbooks, setPlaybooks] = useState<PlaybookRecord[]>([]);
  const [playbooksError, setPlaybooksError] = useState<string | null>(null);
  const [playbookId, setPlaybookId] = useState("");

  const [targetType, setTargetType] = useState<TargetType>("work_item");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkItemSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");

  // Pull-request mode uses one server-side list + client-side filter, so it
  // keeps its own state independent of the work-item search fields.
  const [prQuery, setPrQuery] = useState("");
  const [prRows, setPrRows] = useState<PullRequestDiscoveryRow[]>([]);
  const [prLoading, setPrLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [prSelectedId, setPrSelectedId] = useState("");

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Guard against an async result landing after the dialog unmounts.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset everything whenever the dialog (re)opens, so a prior run leaves no
  // stale selection or error behind.
  useEffect(() => {
    if (!open) return;
    setPlaybookId("");
    setTargetType("work_item");
    setQuery("");
    setResults([]);
    setSearching(false);
    setSearchError(null);
    setSelectedId("");
    setPrQuery("");
    setPrRows([]);
    setPrLoading(false);
    setPrError(null);
    setPrSelectedId("");
    setRunning(false);
    setRunError(null);
  }, [open]);

  // Load the playbook list when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setPlaybooksError(null);
    (async () => {
      try {
        const pbs = await listPlaybooks();
        if (active) setPlaybooks(pbs);
      } catch (err) {
        if (active) {
          setPlaybooksError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [open]);

  // Debounced work-item search (search mode only, work-item target). A
  // request-id guard drops any response superseded by a newer query.
  const searchReqId = useRef(0);
  useEffect(() => {
    if (!open || !searchMode || targetType !== "work_item") return;
    const q = query.trim();
    if (q === "") {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const reqId = ++searchReqId.current;
    const handle = setTimeout(async () => {
      try {
        const rows = await searchWorkItems(q);
        if (!mounted.current || reqId !== searchReqId.current) return;
        setResults(rows);
        setSearchError(null);
      } catch (err) {
        if (!mounted.current || reqId !== searchReqId.current) return;
        setResults([]);
        setSearchError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current && reqId === searchReqId.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [open, searchMode, targetType, query]);

  // Load the ACTIVE-PR list when the user switches to PR mode (search mode
  // only). Filtering is client-side, so this is one request per switch; no
  // debounced re-fetch on typing.
  useEffect(() => {
    if (!open || !searchMode || targetType !== "pull_request") return;
    let active = true;
    setPrLoading(true);
    setPrError(null);
    (async () => {
      try {
        const rows = await listAdoPullRequests();
        if (!active) return;
        setPrRows(rows);
      } catch (err) {
        if (!active) return;
        setPrRows([]);
        setPrError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setPrLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, searchMode, targetType]);

  const selected = useMemo(
    () => results.find((r) => String(r.id) === selectedId) ?? null,
    [results, selectedId],
  );

  const filteredPrs = useMemo(() => {
    const needle = prQuery.trim().toLowerCase();
    if (needle === "") return prRows;
    return prRows.filter((r) => {
      return (
        String(r.id).includes(needle) ||
        r.title.toLowerCase().includes(needle) ||
        r.source_branch.toLowerCase().includes(needle) ||
        r.target_branch.toLowerCase().includes(needle)
      );
    });
  }, [prRows, prQuery]);

  const selectedPr = useMemo(
    () => prRows.find((r) => String(r.id) === prSelectedId) ?? null,
    [prRows, prSelectedId],
  );

  const canRun =
    playbookId !== "" &&
    (!searchMode ||
      (targetType === "work_item" ? selected !== null : selectedPr !== null)) &&
    !running;

  const onRun = useCallback(async () => {
    const pbId = Number(playbookId);
    if (!pbId) return;
    setRunning(true);
    setRunError(null);
    try {
      let eventId: number;
      if (searchMode) {
        if (targetType === "work_item") {
          if (!selected) return;
          const created = await materializeWorkItem(selected.id);
          eventId = created.id;
        } else {
          if (!selectedPr) return;
          const created = await materializePullRequest(selectedPr.id);
          eventId = created.id;
        }
      } else {
        eventId = event!.id;
      }
      const dispatch = await createDispatch(eventId, pbId);
      if (!mounted.current) return;
      onDispatched?.(dispatch);
      onOpenChange(false);
    } catch (err) {
      if (!mounted.current) return;
      // ApiError already carries the backend's `{error}` message.
      setRunError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : String(err),
      );
    } finally {
      if (mounted.current) setRunning(false);
    }
  }, [
    playbookId,
    searchMode,
    targetType,
    selected,
    selectedPr,
    event,
    onDispatched,
    onOpenChange,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        if (!d.open) onOpenChange(false);
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {searchMode ? "Run playbook" : "Dispatch playbook"}
          </DialogTitle>
          <DialogContent className={styles.content}>
            {searchMode ? (
              <>
                <Field label="Target">
                  <RadioGroup
                    layout="horizontal"
                    value={targetType}
                    onChange={(_, d) => setTargetType(d.value as TargetType)}
                    aria-label="Target"
                  >
                    <Radio value="work_item" label="Work item" />
                    <Radio value="pull_request" label="Pull request" />
                  </RadioGroup>
                </Field>
                {targetType === "work_item" ? (
                  <>
                    <Field label="Search work items">
                      <Input
                        value={query}
                        onChange={(_, d) => setQuery(d.value)}
                        placeholder="Search by title or id…"
                        aria-label="Search work items"
                        contentAfter={
                          searching ? (
                            <Spinner size="tiny" aria-label="Searching" />
                          ) : undefined
                        }
                      />
                    </Field>
                    {searchError && (
                      <Text as="p" role="alert" className={styles.error}>
                        {searchError}
                      </Text>
                    )}
                    <div
                      className={styles.results}
                      role="group"
                      aria-label="Search results"
                    >
                      {query.trim() === "" ? (
                        <Text className={styles.hint}>
                          Type to search for a work item.
                        </Text>
                      ) : searching && results.length === 0 ? (
                        <Spinner size="tiny" label="Searching…" />
                      ) : results.length === 0 && !searchError ? (
                        <Text className={styles.hint}>
                          No matching work items.
                        </Text>
                      ) : (
                        <RadioGroup
                          value={selectedId}
                          onChange={(_, d) => setSelectedId(d.value)}
                        >
                          {results.map((r) => (
                            <Radio
                              key={r.id}
                              value={String(r.id)}
                              label={
                                <span className={styles.resultLabel}>
                                  <span className={styles.resultTitle}>
                                    {r.title || `Work item ${r.id}`}
                                  </span>
                                  <span className={styles.resultMeta}>
                                    #{r.id} · {r.work_item_type} · {r.state}
                                    {r.area_path ? ` · ${r.area_path}` : ""}
                                  </span>
                                </span>
                              }
                            />
                          ))}
                        </RadioGroup>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <Field label="Filter pull requests">
                      <Input
                        value={prQuery}
                        onChange={(_, d) => setPrQuery(d.value)}
                        placeholder="Filter by id, title, or branch…"
                        aria-label="Filter pull requests"
                        contentAfter={
                          prLoading ? (
                            <Spinner size="tiny" aria-label="Loading" />
                          ) : undefined
                        }
                      />
                    </Field>
                    {prError && (
                      <Text as="p" role="alert" className={styles.error}>
                        {prError}
                      </Text>
                    )}
                    <div
                      className={styles.results}
                      role="group"
                      aria-label="Pull requests"
                    >
                      {prLoading && prRows.length === 0 ? (
                        <Spinner size="tiny" label="Loading pull requests…" />
                      ) : prRows.length === 0 && !prError ? (
                        <Text className={styles.hint}>
                          No active pull requests.
                        </Text>
                      ) : filteredPrs.length === 0 ? (
                        <Text className={styles.hint}>
                          No matching pull requests.
                        </Text>
                      ) : (
                        <RadioGroup
                          value={prSelectedId}
                          onChange={(_, d) => setPrSelectedId(d.value)}
                        >
                          {filteredPrs.map((r) => (
                            <Radio
                              key={r.id}
                              value={String(r.id)}
                              label={
                                <span className={styles.resultLabel}>
                                  <span className={styles.resultTitle}>
                                    {r.title || `Pull request ${r.id}`}
                                  </span>
                                  <span className={styles.resultMeta}>
                                    #{r.id}
                                    {r.repository ? ` · ${r.repository}` : ""}
                                    {" · "}
                                    {r.source_branch}
                                    {" -> "}
                                    {r.target_branch}
                                    {r.is_draft ? " · draft" : ""}
                                  </span>
                                </span>
                              }
                            />
                          ))}
                        </RadioGroup>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : (
              event?.label && (
                <Text className={styles.hint}>
                  Dispatch a playbook on {event.label}.
                </Text>
              )
            )}

            <Field
              label="Playbook"
              validationState={playbooksError ? "error" : "none"}
              validationMessage={
                playbooksError
                  ? `Couldn't load playbooks: ${playbooksError}`
                  : undefined
              }
            >
              <Select
                aria-label="Playbook"
                value={playbookId}
                onChange={(_, d) => setPlaybookId(d.value)}
              >
                <option value="">Select a playbook…</option>
                {playbooks.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>

            {runError && (
              <Text as="p" role="alert" className={styles.error}>
                {runError}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!canRun}
              onClick={() => void onRun()}
            >
              {running ? "Running…" : "Run"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
