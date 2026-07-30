import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
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
  mergeClasses,
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
  Textarea,
  Title1,
  tokens,
} from "@fluentui/react-components";
import {
  createRule,
  deleteRule,
  listPlaybooks,
  listRules,
  setRuleEnabled,
  updateRule,
  type NewRule,
  type PlaybookSummary,
  type RuleMatch,
  type RuleRecord,
} from "../rules";
import { listNotifiers, type NotifierRecord } from "../notifiers";
import { AsyncCombobox } from "../components/AsyncCombobox";
import { useLiveRefetch } from "../components/useLiveRefetch";
import { getEventSources, getEventTypes } from "../discovery";
import { useMediaQuery } from "../useMediaQuery";
import { TableSearch } from "../components/TableSearch";
import { filterRows } from "../tableFilter";
import {
  LOADED_ORDER_SORT,
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
} from "../useTableSort";
import { useTruncateStyle } from "../useTruncateStyle";

// Below this width the centered editor Dialog goes near-full-screen. Mirrors the
// responsive-nav breakpoint (see App.tsx's NARROW_QUERY) so the layout switch is
// consistent app-wide.
const NARROW_QUERY = "(max-width: 768px)";

/** Sort columns for the rules table; the Actions column doesn't sort. The table
 * renders no time/id column, so it starts in the backend's newest-first load
 * order (see {@link LOADED_ORDER_SORT}) until a header is clicked. */
const RULE_SORT_COLUMNS: SortColumn<RuleRecord>[] = [
  { columnId: "enabled", value: (r) => r.enabled },
  { columnId: "name", value: (r) => r.name },
  { columnId: "source", value: (r) => r.match.source ?? "any" },
  { columnId: "type", value: (r) => r.match.type ?? "any" },
  { columnId: "targets", value: (r) => r.dispatch.length },
  { columnId: "notify", value: (r) => r.notify.length },
];

/**
 * The values a client-side search matches a rule against: every rendered column
 * plus the whole `match` object (stringified to JSON) so a rule is findable by a
 * criteria fragment, not just the source/type shown in the table.
 */
const ruleSearchValues = (r: RuleRecord): readonly unknown[] => [
  r.enabled,
  r.name,
  r.match.source ?? "any",
  r.match.type ?? "any",
  r.dispatch.length,
  r.notify.length,
  r.match,
];

/** Map a bare facet string list into AsyncCombobox options. */
const toOptions = (values: string[]) => values.map((value) => ({ value }));

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
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
  },
  // Centered editor Dialog. The Rules form is short, so the surface fits its
  // content and is only capped (maxHeight), never forced to a tall fixed height.
  surface: {
    maxWidth: "min(560px, 92vw)",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
  },
  // Below the breakpoint the surface fills the viewport (phone-friendly). Width
  // is exactly 100vw so the page never overflows horizontally.
  surfaceMobile: {
    width: "100vw",
    maxWidth: "100vw",
    height: "calc(100vh - 24px)",
    maxHeight: "calc(100vh - 24px)",
  },
  // Let the grid body fill the (capped) surface so its content region scrolls
  // while the title and action bar stay pinned.
  body: {
    minHeight: 0,
    flexGrow: 1,
    maxHeight: "100%",
  },
  // The form body is the scroll region.
  content: {
    overflowY: "auto",
  },
  tableWrap: {
    overflowX: "auto",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  criteria: {
    fontFamily: tokens.fontFamilyMonospace,
  },
  targets: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  targetRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  targetSelect: {
    flexGrow: 1,
  },
});

/** Local, editable shape of a dispatch-target row in the drawer. */
interface TargetDraft {
  /** Stable key so rows survive reorder/removal without React remounting. */
  key: string;
  playbook_id: number;
}

/** Local, editable shape of a notify-target row in the drawer. */
interface NotifyDraft {
  /** Stable key so rows survive reorder/removal without React remounting. */
  key: string;
  notifier_id: number;
}

/** Editable form state backing the create/edit drawer. */
interface DraftState {
  name: string;
  source: string;
  type: string;
  criteria: string;
  targets: TargetDraft[];
  notifiers: NotifyDraft[];
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  source: "",
  type: "",
  criteria: "",
  targets: [],
  notifiers: [],
};

/** Monotonic key source for freshly-added target rows (module-local, not state). */
let targetKeySeq = 0;
function nextTargetKey(): string {
  targetKeySeq += 1;
  return `t${targetKeySeq}`;
}

/** Monotonic key source for freshly-added notify rows (module-local, not state). */
let notifyKeySeq = 0;
function nextNotifyKey(): string {
  notifyKeySeq += 1;
  return `n${notifyKeySeq}`;
}

/** Build the drawer's initial draft from an existing rule (edit mode). */
function draftFromRule(rule: RuleRecord): DraftState {
  return {
    name: rule.name,
    source: rule.match.source ?? "",
    type: rule.match.type ?? "",
    criteria:
      rule.match.criteria === undefined
        ? ""
        : JSON.stringify(rule.match.criteria, null, 2),
    targets: rule.dispatch.map((t) => ({
      key: nextTargetKey(),
      playbook_id: t.playbook_id,
    })),
    notifiers: rule.notify.map((t) => ({
      key: nextNotifyKey(),
      notifier_id: t.notifier_id,
    })),
  };
}

/**
 * Parse the criteria textarea. An empty box is valid (no criteria). Otherwise
 * the text must parse to a JSON object (not an array or primitive). Returns
 * either the parsed value or a human-readable error message.
 */
function parseCriteria(
  text: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Criteria must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Rules page: a table of user-configured rules with a per-row enable/disable
 * toggle, a create/edit drawer (name, source, type, a validated criteria JSON
 * editor, and an add/remove dispatch-targets editor fed by the playbooks list),
 * and a delete-with-confirm dialog.
 */
export function RulesPage() {
  const styles = useStyles();
  const truncate = useTruncateStyle();
  const isNarrow = useMediaQuery(NARROW_QUERY);

  const [rules, setRules] = useState<RuleRecord[]>([]);
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [notifiers, setNotifiers] = useState<NotifierRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Committed (debounced) client-side search query; "" means no filter.
  const [query, setQuery] = useState("");

  // Filter across all rendered columns (plus the match/criteria JSON) before
  // sorting, so search and column sorting compose.
  const filteredRules = useMemo(
    () => filterRows(rules, query, ruleSearchValues),
    [rules, query],
  );

  const {
    sorted: sortedRules,
    sortState,
    toggleSort,
  } = useTableSort(filteredRules, RULE_SORT_COLUMNS, LOADED_ORDER_SORT);

  // Drawer state: `editing` is the rule under edit, or null for a create draft.
  // `drawerOpen` gates rendering so create and edit both reset the draft.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<RuleRecord | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Delete-confirm dialog target, or null when closed.
  const [deleting, setDeleting] = useState<RuleRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Guard against a slow load landing after the component unmounts.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextRules, nextPlaybooks, nextNotifiers] = await Promise.all([
        listRules(),
        listPlaybooks(),
        listNotifiers(),
      ]);
      if (!mounted.current) return;
      setRules(nextRules);
      setPlaybooks(nextPlaybooks);
      setNotifiers(nextNotifiers);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live: silently reload the list when a rule changes anywhere.
  useLiveRefetch("rules", refresh);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDrawerOpen(true);
  }, []);

  const openEdit = useCallback((rule: RuleRecord) => {
    setEditing(rule);
    setDraft(draftFromRule(rule));
    setSaveError(null);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setEditing(null);
  }, []);

  // Live validation of the criteria editor drives both the inline error and the
  // save button's disabled state.
  const criteriaResult = useMemo(
    () => parseCriteria(draft.criteria),
    [draft.criteria],
  );
  const nameValid = draft.name.trim() !== "";
  const canSave = nameValid && criteriaResult.ok && !saving;

  const onToggle = useCallback(
    async (rule: RuleRecord, enabled: boolean) => {
      // Optimistically flip the row, then reconcile against the server.
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
      );
      try {
        const updated = await setRuleEnabled(rule.id, enabled);
        if (!mounted.current) return;
        setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
        setError(null);
      } catch (err) {
        if (!mounted.current) return;
        // Roll the optimistic flip back and surface the failure.
        setRules((prev) =>
          prev.map((r) =>
            r.id === rule.id ? { ...r, enabled: !enabled } : r,
          ),
        );
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const onSave = useCallback(async () => {
    if (!criteriaResult.ok || !nameValid) return;
    const match: RuleMatch = {};
    if (draft.source.trim() !== "") match.source = draft.source.trim();
    if (draft.type.trim() !== "") match.type = draft.type.trim();
    if (criteriaResult.value !== undefined) match.criteria = criteriaResult.value;
    const payload: NewRule = {
      name: draft.name.trim(),
      match,
      dispatch: draft.targets
        .filter((t) => t.playbook_id > 0)
        .map((t) => ({ playbook_id: t.playbook_id })),
      notify: draft.notifiers
        .filter((t) => t.notifier_id > 0)
        .map((t) => ({ notifier_id: t.notifier_id })),
    };

    setSaving(true);
    setSaveError(null);
    try {
      if (editing) await updateRule(editing.id, payload);
      else await createRule(payload);
      if (!mounted.current) return;
      setDrawerOpen(false);
      setEditing(null);
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [criteriaResult, nameValid, draft, editing, refresh]);

  const onConfirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteRule(deleting.id);
      if (!mounted.current) return;
      setDeleting(null);
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(null);
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  }, [deleting, refresh]);

  const addTarget = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      targets: [...prev.targets, { key: nextTargetKey(), playbook_id: 0 }],
    }));
  }, []);

  const setTargetPlaybook = useCallback((key: string, playbookId: number) => {
    setDraft((prev) => ({
      ...prev,
      targets: prev.targets.map((t) =>
        t.key === key ? { ...t, playbook_id: playbookId } : t,
      ),
    }));
  }, []);

  const removeTarget = useCallback((key: string) => {
    setDraft((prev) => ({
      ...prev,
      targets: prev.targets.filter((t) => t.key !== key),
    }));
  }, []);

  const addNotify = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      notifiers: [...prev.notifiers, { key: nextNotifyKey(), notifier_id: 0 }],
    }));
  }, []);

  const setNotifyNotifier = useCallback((key: string, notifierId: number) => {
    setDraft((prev) => ({
      ...prev,
      notifiers: prev.notifiers.map((t) =>
        t.key === key ? { ...t, notifier_id: notifierId } : t,
      ),
    }));
  }, []);

  const removeNotify = useCallback((key: string) => {
    setDraft((prev) => ({
      ...prev,
      notifiers: prev.notifiers.filter((t) => t.key !== key),
    }));
  }, []);

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Rules</Title1>
        <Button appearance="primary" onClick={openCreate}>
          New rule
        </Button>
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      {loading ? (
        <Spinner label="Loading rules…" />
      ) : rules.length === 0 ? (
        <div className={styles.empty}>
          <Text>No rules configured.</Text>
        </div>
      ) : (
        <>
        <TableSearch
          onSearch={setQuery}
          placeholder="Search rules…"
          label="Search rules"
          resultCount={sortedRules.length}
        />
        {sortedRules.length === 0 ? (
          <div className={styles.empty}>
            <Text>No rules match your search.</Text>
          </div>
        ) : (
        <div className={styles.tableWrap}>
        <Table aria-label="Rules">
          <TableHeader>
            <TableRow>
              <SortableHeaderCell columnId="enabled" sortState={sortState} onSort={toggleSort}>
                Enabled
              </SortableHeaderCell>
              <SortableHeaderCell columnId="name" sortState={sortState} onSort={toggleSort}>
                Name
              </SortableHeaderCell>
              <SortableHeaderCell columnId="source" sortState={sortState} onSort={toggleSort}>
                Source
              </SortableHeaderCell>
              <SortableHeaderCell columnId="type" sortState={sortState} onSort={toggleSort}>
                Type
              </SortableHeaderCell>
              <SortableHeaderCell columnId="targets" sortState={sortState} onSort={toggleSort}>
                Targets
              </SortableHeaderCell>
              <SortableHeaderCell columnId="notify" sortState={sortState} onSort={toggleSort}>
                Notify
              </SortableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell>
                  <Switch
                    checked={rule.enabled}
                    aria-label={`Enable ${rule.name}`}
                    onChange={(_, d) => void onToggle(rule, d.checked)}
                  />
                </TableCell>
                <TableCell className={truncate} title={rule.name}>
                  {rule.name}
                </TableCell>
                <TableCell
                  className={truncate}
                  title={rule.match.source ?? "any"}
                >
                  {rule.match.source ?? "any"}
                </TableCell>
                <TableCell
                  className={truncate}
                  title={rule.match.type ?? "any"}
                >
                  {rule.match.type ?? "any"}
                </TableCell>
                <TableCell>
                  <Badge appearance="tint">{rule.dispatch.length}</Badge>
                </TableCell>
                <TableCell>
                  <Badge appearance="tint">{rule.notify.length}</Badge>
                </TableCell>
                <TableCell>
                  <div className={styles.actions}>
                    <Button size="small" onClick={() => openEdit(rule)}>
                      Edit
                    </Button>
                    <Button
                      size="small"
                      onClick={() => setDeleting(rule)}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        )}
        </>
      )}

      <Dialog
        modalType="modal"
        open={drawerOpen}
        onOpenChange={(_, d) => {
          if (!d.open) closeDrawer();
        }}
      >
        <DialogSurface
          className={
            isNarrow
              ? mergeClasses(styles.surface, styles.surfaceMobile)
              : styles.surface
          }
        >
          <DialogBody className={styles.body}>
            <DialogTitle>{editing ? "Edit rule" : "New rule"}</DialogTitle>
            <DialogContent className={styles.content}>
              <div className={styles.form}>
                {saveError && (
                  <Text as="p" className={styles.error} role="alert">
                    {saveError}
                  </Text>
                )}

                <Field
                  label="Name"
                  required
                  validationState={nameValid ? "none" : "error"}
                  validationMessage={nameValid ? undefined : "Name is required"}
                >
                  <Input
                    value={draft.name}
                    onChange={(_, d) =>
                      setDraft((prev) => ({ ...prev, name: d.value }))
                    }
                  />
                </Field>

                <AsyncCombobox
                  label="Source"
                  aria-label="Source"
                  hint="Event source; leave blank to match any."
                  placeholder="e.g. ado"
                  value={draft.source}
                  onChange={(v) => setDraft((prev) => ({ ...prev, source: v }))}
                  load={async () => toOptions(await getEventSources())}
                />

                <AsyncCombobox
                  label="Type"
                  aria-label="Type"
                  hint="Event type; a trailing .* matches by prefix. Blank matches any."
                  placeholder="e.g. work_item.* "
                  value={draft.type}
                  onChange={(v) => setDraft((prev) => ({ ...prev, type: v }))}
                  load={async () => toOptions(await getEventTypes())}
                />

                <Field
                  label="Criteria (JSON)"
                  validationState={criteriaResult.ok ? "none" : "error"}
                  validationMessage={
                    criteriaResult.ok ? undefined : criteriaResult.error
                  }
                >
                  <Textarea
                    className={styles.criteria}
                    resize="vertical"
                    rows={6}
                    value={draft.criteria}
                    placeholder="{}"
                    onChange={(_, d) =>
                      setDraft((prev) => ({ ...prev, criteria: d.value }))
                    }
                  />
                </Field>

                <Field label="Dispatch targets">
                  <div className={styles.targets}>
                    {draft.targets.length === 0 && (
                      <Text>No targets. Add a playbook to dispatch to.</Text>
                    )}
                    {draft.targets.map((t, i) => (
                      <div key={t.key} className={styles.targetRow}>
                        <Select
                          className={styles.targetSelect}
                          aria-label={`Target ${i + 1} playbook`}
                          value={String(t.playbook_id)}
                          onChange={(_, d) =>
                            setTargetPlaybook(t.key, Number(d.value))
                          }
                        >
                          <option value="0">Select a playbook…</option>
                          {playbooks.map((p) => (
                            <option key={p.id} value={String(p.id)}>
                              {p.name}
                            </option>
                          ))}
                        </Select>
                        <Button
                          size="small"
                          aria-label={`Remove target ${i + 1}`}
                          onClick={() => removeTarget(t.key)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <div>
                      <Button size="small" onClick={addTarget}>
                        Add target
                      </Button>
                    </div>
                  </div>
                </Field>

                <Field label="Notify targets">
                  <div className={styles.targets}>
                    {draft.notifiers.length === 0 && (
                      <Text>No notify targets. Add a notifier to alert.</Text>
                    )}
                    {draft.notifiers.map((t, i) => (
                      <div key={t.key} className={styles.targetRow}>
                        <Select
                          className={styles.targetSelect}
                          aria-label={`Notify target ${i + 1} notifier`}
                          value={String(t.notifier_id)}
                          onChange={(_, d) =>
                            setNotifyNotifier(t.key, Number(d.value))
                          }
                        >
                          <option value="0">Select a notifier…</option>
                          {notifiers.map((n) => (
                            <option key={n.id} value={String(n.id)}>
                              {n.name}
                            </option>
                          ))}
                        </Select>
                        <Button
                          size="small"
                          aria-label={`Remove notify target ${i + 1}`}
                          onClick={() => removeNotify(t.key)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <div>
                      <Button size="small" onClick={addNotify}>
                        Add notify target
                      </Button>
                    </div>
                  </div>
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button onClick={closeDrawer}>Cancel</Button>
              <Button
                appearance="primary"
                disabled={!canSave}
                onClick={() => void onSave()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setDeleting(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete rule</DialogTitle>
            <DialogContent>
              {deleting &&
                `Delete rule “${deleting.name}”? This cannot be undone.`}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={deleteBusy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={deleteBusy}
                onClick={() => void onConfirmDelete()}
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
