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
  Select,
  Spinner,
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
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
  type NewSnippet,
  type SnippetKind,
  type SnippetRecord,
} from "../snippets";
import { useMediaQuery } from "../useMediaQuery";
import { TableSearch } from "../components/TableSearch";
import { useLiveRefetch } from "../components/useLiveRefetch";
import { filterRows } from "../tableFilter";
import {
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
  type SortState,
} from "../useTableSort";
import { useTruncateStyle } from "../useTruncateStyle";

// Mirror the responsive-nav breakpoint (see App.tsx's NARROW_QUERY) so the
// editor Dialog goes near-full-screen on phones consistently app-wide.
const NARROW_QUERY = "(max-width: 768px)";

/** Kind filter tabs, in display order. Each shows only its kind's snippets and
 * seeds the create dialog's kind (a snippet's kind is fixed by the active tab —
 * references are by name WITHIN a kind, so re-kinding is not an editor gesture). */
const KIND_FILTERS: { kind: SnippetKind; label: string }[] = [
  { kind: "prompt", label: "Prompts" },
  { kind: "userdata", label: "Userdata" },
  { kind: "step", label: "Steps" },
];

/** How each kind is composed into a playbook, shown as a dialog hint so authors
 * know how the snippet they're writing will be referenced. */
const KIND_HINT: Record<SnippetKind, string> = {
  prompt:
    "Stackable inside a prompt template as {{snippet.<name>}} tokens (may nest other prompt snippets).",
  userdata:
    "Referenced whole as the entire userdata value (snippet:<name>) — no mixing, no stacking.",
  step: "Referenced whole as a step's command (snippet:<name>).",
};

/** Sort columns for the snippets table; the Actions column doesn't sort. */
const SNIPPET_SORT_COLUMNS: SortColumn<SnippetRecord>[] = [
  { columnId: "name", value: (s) => s.name },
  { columnId: "description", value: (s) => s.description },
  { columnId: "updated", value: (s) => s.updated_at },
];

/** Default the table to newest-first by the visible Updated column so the sort
 * indicator agrees with the initial order. */
const NEWEST_FIRST_SORT: SortState = {
  columnId: "updated",
  direction: "descending",
};

/** The values a client-side search matches a snippet against: the rendered
 * columns plus its content, so a snippet is findable by a content fragment too. */
const snippetSearchValues = (s: SnippetRecord): readonly unknown[] => [
  s.name,
  s.description,
  s.content,
];

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  intro: {
    display: "block",
    maxWidth: "80ch",
    marginBottom: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground2,
  },
  filter: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  filterSelect: {
    minWidth: "200px",
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
  warn: {
    color: tokens.colorPaletteDarkOrangeForeground1,
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
  // Just the muted color; the shared truncate style (composed via mergeClasses)
  // supplies the single-line ellipsis clipping.
  descCell: {
    color: tokens.colorNeutralForeground2,
  },
  surface: {
    maxWidth: "min(640px, 92vw)",
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
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
  },
});

/** Editable form state backing the create/edit dialog. */
interface DraftState {
  name: string;
  description: string;
  content: string;
}

const EMPTY_DRAFT: DraftState = { name: "", description: "", content: "" };

/** Human-readable timestamp for the Updated column (matches the app convention). */
function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * Snippets page: manage reusable, user-authored template fragments (prompt
 * fragments, userdata scripts, step commands) that playbooks reference by name
 * and that resolve at DISPATCH TIME, so editing one propagates to every playbook
 * that uses it. A kind filter scopes the table to one composition model; a
 * create/edit dialog offers name, description, and a monospace content editor.
 * Deleting warns that any playbook still referencing the name fails loudly at
 * its next dispatch — exactly like a missing secret.
 */
export function SnippetsPage() {
  const styles = useStyles();
  const truncate = useTruncateStyle();
  const isNarrow = useMediaQuery(NARROW_QUERY);

  const [snippets, setSnippets] = useState<SnippetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<SnippetKind>("prompt");
  // Committed (debounced) client-side search query; "" means no filter.
  const [query, setQuery] = useState("");

  // Scope to the active kind first, then filter across the rendered columns
  // (plus content) so the tab, search and column sorting all compose.
  const filteredSnippets = useMemo(
    () =>
      filterRows(
        snippets.filter((s) => s.kind === activeKind),
        query,
        snippetSearchValues,
      ),
    [snippets, activeKind, query],
  );

  const {
    sorted: sortedSnippets,
    sortState,
    toggleSort,
  } = useTableSort(filteredSnippets, SNIPPET_SORT_COLUMNS, NEWEST_FIRST_SORT);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SnippetRecord | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<SnippetRecord | null>(null);
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
      const next = await listSnippets();
      if (!mounted.current) return;
      setSnippets(next);
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

  // Live: silently reload the list when a snippet changes anywhere.
  useLiveRefetch("snippets", refresh);

  // The kind being created/edited: an edit keeps the record's own kind, a create
  // takes the active tab's kind.
  const dialogKind: SnippetKind = editing ? editing.kind : activeKind;

  const openCreate = useCallback(() => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback((snippet: SnippetRecord) => {
    setEditing(snippet);
    setDraft({
      name: snippet.name,
      description: snippet.description,
      content: snippet.content,
    });
    setSaveError(null);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditing(null);
  }, []);

  const nameValid = draft.name.trim() !== "";
  const contentValid = draft.content !== "";
  const canSave = nameValid && contentValid && !saving;

  const onSave = useCallback(async () => {
    if (!nameValid || !contentValid) return;
    const payload: NewSnippet = {
      kind: dialogKind,
      name: draft.name.trim(),
      description: draft.description,
      content: draft.content,
    };

    setSaving(true);
    setSaveError(null);
    try {
      if (editing) {
        await updateSnippet(editing.id, {
          name: payload.name,
          description: payload.description,
          content: payload.content,
        });
      } else {
        await createSnippet(payload);
      }
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
  }, [nameValid, contentValid, dialogKind, draft, editing, refresh]);

  const onConfirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteSnippet(deleting.id);
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
        <Title1 as="h1">Snippets</Title1>
        <Button appearance="primary" onClick={openCreate}>
          New snippet
        </Button>
      </div>

      <Text as="p" className={styles.intro}>
        Reusable template fragments that playbooks reference by name. They resolve
        at dispatch time, so editing a snippet updates every playbook that uses it.
        A renamed, deleted, or re-kinded snippet breaks its references — the
        dispatch fails loudly, like a missing secret.
      </Text>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      <div className={styles.filter}>
        <Field label="Kind">
          <Select
            className={styles.filterSelect}
            value={activeKind}
            onChange={(_, d) => setActiveKind(d.value as SnippetKind)}
          >
            {KIND_FILTERS.map((f) => (
              <option key={f.kind} value={f.kind}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {loading ? (
        <Spinner label="Loading snippets…" />
      ) : (
        <>
          <TableSearch
            onSearch={setQuery}
            placeholder="Search snippets…"
            label="Search snippets"
            resultCount={sortedSnippets.length}
          />
          {sortedSnippets.length === 0 ? (
            <div className={styles.empty}>
              <Text>
                {query.trim() !== ""
                  ? "No snippets match your search."
                  : "No snippets of this kind yet."}
              </Text>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <Table aria-label="Snippets">
                <TableHeader>
                  <TableRow>
                    <SortableHeaderCell
                      columnId="name"
                      sortState={sortState}
                      onSort={toggleSort}
                    >
                      Name
                    </SortableHeaderCell>
                    <SortableHeaderCell
                      columnId="description"
                      sortState={sortState}
                      onSort={toggleSort}
                    >
                      Description
                    </SortableHeaderCell>
                    <SortableHeaderCell
                      columnId="updated"
                      sortState={sortState}
                      onSort={toggleSort}
                    >
                      Updated
                    </SortableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedSnippets.map((snippet) => (
                    <TableRow key={snippet.id}>
                      <TableCell className={truncate} title={snippet.name}>
                        {snippet.name}
                      </TableCell>
                      <TableCell
                        className={mergeClasses(styles.descCell, truncate)}
                        title={snippet.description}
                      >
                        {snippet.description}
                      </TableCell>
                      <TableCell>{formatTimestamp(snippet.updated_at)}</TableCell>
                      <TableCell>
                        <div className={styles.actions}>
                          <Button size="small" onClick={() => openEdit(snippet)}>
                            Edit
                          </Button>
                          <Button size="small" onClick={() => setDeleting(snippet)}>
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
              {editing ? "Edit snippet" : `New ${dialogKind} snippet`}
            </DialogTitle>
            <DialogContent className={styles.content}>
              <div className={styles.form}>
                {saveError && (
                  <Text as="p" className={styles.error} role="alert">
                    {saveError}
                  </Text>
                )}

                <Text as="p" className={styles.intro}>
                  {KIND_HINT[dialogKind]}
                </Text>

                <Field
                  label="Name"
                  required
                  hint="Unique within this kind. Playbooks reference the snippet by this name."
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

                <Field label="Description">
                  <Input
                    value={draft.description}
                    onChange={(_, d) =>
                      setDraft((prev) => ({ ...prev, description: d.value }))
                    }
                  />
                </Field>

                <Field
                  label="Content"
                  required
                  validationState={contentValid ? "none" : "error"}
                  validationMessage={
                    contentValid ? undefined : "Content is required"
                  }
                >
                  <Textarea
                    className={styles.mono}
                    resize="vertical"
                    rows={10}
                    value={draft.content}
                    onChange={(_, d) =>
                      setDraft((prev) => ({ ...prev, content: d.value }))
                    }
                  />
                </Field>
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
            <DialogTitle>Delete snippet</DialogTitle>
            <DialogContent>
              {deleting && (
                <>
                  <Text as="p">
                    Delete {deleting.kind} snippet “{deleting.name}”? This cannot be
                    undone.
                  </Text>
                  <Text as="p" className={styles.warn}>
                    Any playbook still referencing “{deleting.name}” will fail loudly
                    at its next dispatch, like a missing secret.
                  </Text>
                </>
              )}
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
