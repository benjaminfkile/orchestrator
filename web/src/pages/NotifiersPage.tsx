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
  mergeClasses,
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
  createNotifier,
  deleteNotifier,
  listNotifiers,
  updateNotifier,
  type NewNotifier,
  type NotifierRecord,
} from "../notifiers";
import { useMediaQuery } from "../useMediaQuery";
import { TableSearch } from "../components/TableSearch";
import { useLiveRefetch } from "../components/useLiveRefetch";
import { filterRows } from "../tableFilter";
import {
  LOADED_ORDER_SORT,
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
} from "../useTableSort";
import { useTruncateStyle } from "../useTruncateStyle";

// Mirror the responsive-nav breakpoint (see App.tsx's NARROW_QUERY) so the
// editor Dialog goes near-full-screen on phones consistently app-wide.
const NARROW_QUERY = "(max-width: 768px)";

/** Sort columns for the notifiers table; the Actions column doesn't sort. The
 * table renders no time/id column, so it starts in the backend's newest-first
 * load order (see {@link LOADED_ORDER_SORT}) until a header is clicked. */
const NOTIFIER_SORT_COLUMNS: SortColumn<NotifierRecord>[] = [
  { columnId: "enabled", value: (n) => n.enabled },
  { columnId: "name", value: (n) => n.name },
];

/**
 * The values a client-side search matches a notifier against: the rendered
 * columns plus the title/body templates and opaque `config` (stringified to
 * JSON), so a notifier is findable by a template or config fragment too.
 */
const notifierSearchValues = (n: NotifierRecord): readonly unknown[] => [
  n.enabled,
  n.name,
  n.title_template,
  n.body_template,
  n.config,
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
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
  },
  tableWrap: {
    overflowX: "auto",
  },
  surface: {
    maxWidth: "min(560px, 92vw)",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
  },
  surfaceMobile: {
    width: "100vw",
    maxWidth: "100vw",
    height: "calc(100vh - 24px)",
    maxHeight: "calc(100vh - 24px)",
  },
  body: {
    minHeight: 0,
    flexGrow: 1,
    maxHeight: "100%",
  },
  content: {
    overflowY: "auto",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  template: {
    fontFamily: tokens.fontFamilyMonospace,
  },
});

/** Editable form state backing the create/edit dialog. */
interface DraftState {
  name: string;
  title_template: string;
  body_template: string;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  title_template: "",
  body_template: "",
  enabled: true,
};

/** Build the dialog's initial draft from an existing notifier (edit mode). */
function draftFromNotifier(notifier: NotifierRecord): DraftState {
  return {
    name: notifier.name,
    title_template: notifier.title_template,
    body_template: notifier.body_template,
    enabled: notifier.enabled,
  };
}

/**
 * Notifiers page: a table of user-built notifiers (outbound sinks) with a
 * per-row enabled toggle, a create/edit dialog (name, title/body templates,
 * enabled), and a delete-with-confirm dialog. A notification is JUST a
 * notification — every fired notifier always lands in the in-app log AND
 * best-effort raises a desktop toast, so there is no delivery-kind selector.
 */
export function NotifiersPage() {
  const styles = useStyles();
  const truncate = useTruncateStyle();
  const isNarrow = useMediaQuery(NARROW_QUERY);

  const [notifiers, setNotifiers] = useState<NotifierRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Committed (debounced) client-side search query; "" means no filter.
  const [query, setQuery] = useState("");

  // Filter across all rendered columns (plus templates/config) before sorting,
  // so search and column sorting compose.
  const filteredNotifiers = useMemo(
    () => filterRows(notifiers, query, notifierSearchValues),
    [notifiers, query],
  );

  const {
    sorted: sortedNotifiers,
    sortState,
    toggleSort,
  } = useTableSort(filteredNotifiers, NOTIFIER_SORT_COLUMNS, LOADED_ORDER_SORT);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<NotifierRecord | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<NotifierRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await listNotifiers();
      if (!mounted.current) return;
      setNotifiers(next);
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

  // Live: silently reload the list when a notifier changes anywhere.
  useLiveRefetch("notifiers", refresh);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback((notifier: NotifierRecord) => {
    setEditing(notifier);
    setDraft(draftFromNotifier(notifier));
    setSaveError(null);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditing(null);
  }, []);

  const nameValid = draft.name.trim() !== "";
  const canSave = nameValid && !saving;

  const onToggle = useCallback(
    async (notifier: NotifierRecord, enabled: boolean) => {
      setNotifiers((prev) =>
        prev.map((n) => (n.id === notifier.id ? { ...n, enabled } : n)),
      );
      try {
        const updated = await updateNotifier(notifier.id, { enabled });
        if (!mounted.current) return;
        setNotifiers((prev) =>
          prev.map((n) => (n.id === notifier.id ? updated : n)),
        );
        setError(null);
      } catch (err) {
        if (!mounted.current) return;
        setNotifiers((prev) =>
          prev.map((n) =>
            n.id === notifier.id ? { ...n, enabled: !enabled } : n,
          ),
        );
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const onSave = useCallback(async () => {
    if (!nameValid) return;
    const payload: NewNotifier = {
      name: draft.name.trim(),
      title_template: draft.title_template,
      body_template: draft.body_template,
      enabled: draft.enabled,
    };

    setSaving(true);
    setSaveError(null);
    try {
      if (editing) await updateNotifier(editing.id, payload);
      else await createNotifier(payload);
      if (!mounted.current) return;
      setDialogOpen(false);
      setEditing(null);
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [nameValid, draft, editing, refresh]);

  const onConfirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteNotifier(deleting.id);
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

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Notifiers</Title1>
        <Button appearance="primary" onClick={openCreate}>
          New notifier
        </Button>
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      {loading ? (
        <Spinner label="Loading notifiers…" />
      ) : notifiers.length === 0 ? (
        <div className={styles.empty}>
          <Text>No notifiers configured.</Text>
        </div>
      ) : (
        <>
        <TableSearch
          onSearch={setQuery}
          placeholder="Search notifiers…"
          label="Search notifiers"
          resultCount={sortedNotifiers.length}
        />
        {sortedNotifiers.length === 0 ? (
          <div className={styles.empty}>
            <Text>No notifiers match your search.</Text>
          </div>
        ) : (
        <div className={styles.tableWrap}>
          <Table aria-label="Notifiers">
            <TableHeader>
              <TableRow>
                <SortableHeaderCell columnId="enabled" sortState={sortState} onSort={toggleSort}>
                  Enabled
                </SortableHeaderCell>
                <SortableHeaderCell columnId="name" sortState={sortState} onSort={toggleSort}>
                  Name
                </SortableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedNotifiers.map((notifier) => (
                <TableRow key={notifier.id}>
                  <TableCell>
                    <Switch
                      checked={notifier.enabled}
                      aria-label={`Enable ${notifier.name}`}
                      onChange={(_, d) => void onToggle(notifier, d.checked)}
                    />
                  </TableCell>
                  <TableCell className={truncate} title={notifier.name}>
                    {notifier.name}
                  </TableCell>
                  <TableCell>
                    <div className={styles.actions}>
                      <Button size="small" onClick={() => openEdit(notifier)}>
                        Edit
                      </Button>
                      <Button size="small" onClick={() => setDeleting(notifier)}>
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
        open={dialogOpen}
        onOpenChange={(_, d) => {
          if (!d.open) closeDialog();
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
            <DialogTitle>
              {editing ? "Edit notifier" : "New notifier"}
            </DialogTitle>
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

                <Field
                  label="Title template"
                  hint="Rendered against the triggering event, e.g. {{event.type}}."
                >
                  <Input
                    className={styles.template}
                    value={draft.title_template}
                    onChange={(_, d) =>
                      setDraft((prev) => ({
                        ...prev,
                        title_template: d.value,
                      }))
                    }
                  />
                </Field>

                <Field label="Body template">
                  <Textarea
                    className={styles.template}
                    resize="vertical"
                    rows={4}
                    value={draft.body_template}
                    onChange={(_, d) =>
                      setDraft((prev) => ({
                        ...prev,
                        body_template: d.value,
                      }))
                    }
                  />
                </Field>

                <Switch
                  checked={draft.enabled}
                  label="Enabled"
                  onChange={(_, d) =>
                    setDraft((prev) => ({ ...prev, enabled: d.checked }))
                  }
                />
              </div>
            </DialogContent>
            <DialogActions>
              <Button onClick={closeDialog}>Cancel</Button>
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
            <DialogTitle>Delete notifier</DialogTitle>
            <DialogContent>
              {deleting &&
                `Delete notifier “${deleting.name}”? This cannot be undone.`}
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
