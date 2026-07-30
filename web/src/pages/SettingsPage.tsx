import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Divider,
  Field,
  Input,
  makeStyles,
  Radio,
  RadioGroup,
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
  Title3,
  tokens,
} from "@fluentui/react-components";
import {
  deleteSecret,
  getConfigExport,
  getSettings,
  getSystemInfo,
  importConfig,
  listSecrets,
  putSecret,
  putSetting,
  type ImportMode,
  type ImportPlan,
  type ImportPlanItem,
  type SettingsMap,
  type SystemInfo,
} from "../settings";
import { getAdoMe } from "../discovery";
import { useLiveRefetch } from "../components/useLiveRefetch";
import {
  SortableHeaderCell,
  useTableSort,
  type SortColumn,
  type SortState,
} from "../useTableSort";

/** Default sort: secret names ascending, matching the backend's sorted listing. */
const SECRETS_DEFAULT_SORT: SortState = {
  columnId: "name",
  direction: "ascending",
};

/** The lone sort column for the secrets table (a list of names). */
const SECRET_SORT_COLUMNS: SortColumn<string>[] = [
  { columnId: "name", value: (name) => name },
];

/**
 * The whitelisted, editable settings this page exposes. `key` MUST match a key
 * in the backend's KNOWN_SETTING_KEYS whitelist or the PUT is rejected. Values
 * are stored as strings; `numeric` only tags the input mode.
 */
const EDITABLE_SETTINGS: {
  key: string;
  label: string;
  hint?: string;
  numeric?: boolean;
}[] = [
  {
    key: "event_dedupe_cooldown_seconds",
    label: "Dedupe cooldown (seconds)",
    hint: "Suppresses re-emitting the same event within this window.",
    numeric: true,
  },
  {
    key: "dispatch_concurrency",
    label: "Dispatch concurrency",
    hint: "Max dispatches running at once.",
    numeric: true,
  },
  {
    key: "dispatcher_interval_seconds",
    label: "Dispatcher interval (seconds)",
    numeric: true,
  },
  {
    key: "dispatch_max_attempts",
    label: "Max dispatch attempts",
    numeric: true,
  },
  {
    key: "dispatch_max_per_event",
    label: "Max dispatches per event",
    numeric: true,
  },
  {
    key: "dispatch_max_per_hour",
    label: "Max dispatches per hour",
    hint: "Intake overflow valve: drops new dispatches once this many are created within the trailing hour.",
    numeric: true,
  },
  {
    key: "run_budget_per_hour",
    label: "Run budget per window",
    hint: "Optional. Max agent runs STARTED per rolling window; over-budget dispatches wait, queued, and drain as the window slides. Empty or 0 disables the gate.",
    numeric: true,
  },
  {
    key: "run_budget_window_minutes",
    label: "Run budget window (minutes)",
    hint: "The rolling window the run budget counts over (default 60). A capped Claude plan is roughly a 5h window, so e.g. 300 models reality better.",
    numeric: true,
  },
  {
    key: "token_budget_per_window",
    label: "Token budget per window",
    hint: "Optional secondary circuit breaker. Pauses claiming while summed run tokens in the window exceed this. Reactive (a run's cost is only known when it ends) — a backstop, not the primary control. Empty or 0 disables it.",
    numeric: true,
  },
  {
    key: "dispatch_timeout_seconds",
    label: "Dispatch timeout (seconds)",
    numeric: true,
  },
  {
    key: "run_retention_max",
    label: "Run history retention (max)",
    hint: "Caps kept terminal runs (done/failed): the oldest beyond this are pruned along with their findings and log files. Default 2000. Empty or garbage falls back to 2000; 0 or negative disables pruning entirely.",
    numeric: true,
  },
  {
    key: "default_lease_image",
    label: "Default lease image",
    hint: "Image playbooks referencing setting:default_lease_image resolve to.",
  },
  {
    key: "identity_me",
    label: "Identity (me)",
    hint: 'Resolves the "@Me" assignee in watched queries.',
  },
];

const useStyles = makeStyles({
  header: {
    marginBottom: tokens.spacingVerticalL,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
  section: {
    maxWidth: "640px",
    marginBottom: tokens.spacingVerticalXXL,
  },
  sectionTitle: {
    marginBottom: tokens.spacingVerticalM,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  system: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalXL,
    fontSize: tokens.fontSizeBase300,
  },
  systemLabel: {
    color: tokens.colorNeutralForeground3,
  },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
  },
  tableWrap: {
    overflowX: "auto",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalS,
  },
  identityRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: tokens.spacingHorizontalM,
  },
  identityInput: {
    flexGrow: 1,
  },
  inlineError: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  saved: {
    color: tokens.colorPaletteGreenForeground1,
  },
  secretForm: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalL,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
  },
  ioForm: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  ioRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
  plan: {
    marginTop: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  planGroupTitle: {
    fontWeight: tokens.fontWeightSemibold,
  },
  planList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
  },
});

/**
 * Settings page: a whitelisted `app_settings` editor, a read-only host-info block
 * (wisper base URL + hostId), and a WRITE-ONLY secrets manager (list names,
 * add/update via password inputs, delete-with-confirm). Secret values never leave
 * the server, so this page can only set or clear them, never read them back.
 */
export function SettingsPage() {
  const styles = useStyles();

  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [original, setOriginal] = useState<SettingsMap>({});
  const [draft, setDraft] = useState<SettingsMap>({});
  const [secrets, setSecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const {
    sorted: sortedSecrets,
    sortState: secretsSort,
    toggleSort: toggleSecretsSort,
  } = useTableSort(secrets, SECRET_SORT_COLUMNS, SECRETS_DEFAULT_SORT);

  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // "Resolve from ADO" affordance for the identity_me field.
  const [resolvingIdentity, setResolvingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  // Secret add/update form.
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);

  // Delete-confirm target, or null when closed.
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Config export / import.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importApplied, setImportApplied] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextSystem, nextSettings, nextSecrets] = await Promise.all([
        getSystemInfo(),
        getSettings(),
        listSecrets(),
      ]);
      if (!mounted.current) return;
      setSystem(nextSystem);
      setOriginal(nextSettings);
      setDraft(nextSettings);
      setSecrets(nextSecrets);
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

  // Live: silently reconcile with the server when settings or secrets change
  // elsewhere. Unlike the initial load this keeps the draft intact for any key
  // the user has edited but not yet saved, so a background refresh never
  // clobbers in-progress typing; unedited keys adopt the new server value.
  const liveRefetch = useCallback(async () => {
    try {
      const [nextSystem, nextSettings, nextSecrets] = await Promise.all([
        getSystemInfo(),
        getSettings(),
        listSecrets(),
      ]);
      if (!mounted.current) return;
      setSystem(nextSystem);
      setSecrets(nextSecrets);
      setDraft((prev) => {
        const merged: SettingsMap = { ...nextSettings };
        for (const key of Object.keys(prev)) {
          if ((prev[key] ?? "") !== (original[key] ?? "")) {
            merged[key] = prev[key] ?? "";
          }
        }
        return merged;
      });
      setOriginal(nextSettings);
      setError(null);
    } catch {
      // Background refresh: keep the current values; a later change reconciles.
    }
  }, [original]);
  useLiveRefetch("settings", liveRefetch);
  useLiveRefetch("secrets", liveRefetch);

  const setDraftValue = useCallback((key: string, value: string) => {
    setSettingsSaved(false);
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Resolve identity_me from the configured ADO connection. Fills the field but
  // leaves it editable; a missing PAT/org surfaces inline without clobbering the
  // current value.
  const onResolveIdentity = useCallback(async () => {
    setResolvingIdentity(true);
    setIdentityError(null);
    try {
      const me = await getAdoMe();
      if (!mounted.current) return;
      const resolved = me.uniqueName || me.displayName || "";
      if (resolved === "") {
        setIdentityError("ADO returned no identity for the configured PAT.");
        return;
      }
      setDraftValue("identity_me", resolved);
    } catch (err) {
      if (!mounted.current) return;
      setIdentityError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setResolvingIdentity(false);
    }
  }, [setDraftValue]);

  // The keys whose draft value differs from what the server returned.
  const changedKeys = useMemo(
    () =>
      EDITABLE_SETTINGS.map((s) => s.key).filter(
        (key) => (draft[key] ?? "") !== (original[key] ?? ""),
      ),
    [draft, original],
  );

  const onSaveSettings = useCallback(async () => {
    if (changedKeys.length === 0) return;
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      // Persist only the settings the user actually changed, one PUT each.
      for (const key of changedKeys) {
        await putSetting(key, draft[key] ?? "");
      }
      if (!mounted.current) return;
      setSettingsSaved(true);
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSavingSettings(false);
    }
  }, [changedKeys, draft, refresh]);

  const onSaveSecret = useCallback(async () => {
    const name = secretName.trim();
    if (name === "" || secretValue === "") return;
    setSavingSecret(true);
    setSecretError(null);
    try {
      await putSecret(name, secretValue);
      if (!mounted.current) return;
      setSecretName("");
      setSecretValue("");
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setSecretError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSavingSecret(false);
    }
  }, [secretName, secretValue, refresh]);

  const onConfirmDelete = useCallback(async () => {
    if (deleting === null) return;
    setDeleteBusy(true);
    try {
      await deleteSecret(deleting);
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

  // Download the export document as a JSON file.
  const onExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const doc = await getConfigExport();
      const blob = new Blob([JSON.stringify(doc, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "orchestrator-config.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (!mounted.current) return;
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setExporting(false);
    }
  }, []);

  // Any change to the document or mode invalidates a previously previewed plan,
  // so Apply can only ever commit exactly what was last previewed.
  const resetImportPlan = useCallback(() => {
    setImportPlan(null);
    setImportApplied(false);
  }, []);

  const onImportTextChange = useCallback(
    (value: string) => {
      setImportText(value);
      setImportError(null);
      resetImportPlan();
    },
    [resetImportPlan],
  );

  const onImportModeChange = useCallback(
    (value: string) => {
      setImportMode(value === "overwrite" ? "overwrite" : "merge");
      resetImportPlan();
    },
    [resetImportPlan],
  );

  // Load a chosen file's text into the paste box (parsing happens on preview).
  const onImportFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        onImportTextChange(String(reader.result ?? ""));
      };
      reader.onerror = () => {
        setImportError("Could not read the selected file.");
      };
      reader.readAsText(file);
    },
    [onImportTextChange],
  );

  // Parse the pasted/loaded JSON, throwing a friendly error on malformed input.
  const parseImportDocument = useCallback((): unknown => {
    try {
      return JSON.parse(importText);
    } catch {
      throw new Error("Document is not valid JSON.");
    }
  }, [importText]);

  // Always dry-run first: fetch and display the plan, never write.
  const onPreviewImport = useCallback(async () => {
    setPreviewing(true);
    setImportError(null);
    setImportApplied(false);
    try {
      const document = parseImportDocument();
      const plan = await importConfig(document, importMode, true);
      if (!mounted.current) return;
      setImportPlan(plan);
    } catch (err) {
      if (!mounted.current) return;
      setImportPlan(null);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setPreviewing(false);
    }
  }, [importMode, parseImportDocument]);

  // Apply only after an explicit second click; commits exactly what was previewed.
  const onApplyImport = useCallback(async () => {
    if (!importPlan) return;
    setApplying(true);
    setImportError(null);
    try {
      const document = parseImportDocument();
      const plan = await importConfig(document, importMode, false);
      if (!mounted.current) return;
      setImportPlan(plan);
      setImportApplied(true);
      // The import may have changed settings/secrets-adjacent state; refresh.
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setApplying(false);
    }
  }, [importPlan, importMode, parseImportDocument, refresh]);

  const secretSaveDisabled =
    savingSecret || secretName.trim() === "" || secretValue === "";

  if (loading) {
    return (
      <section>
        <div className={styles.header}>
          <Title1 as="h1">Settings</Title1>
        </div>
        <Spinner label="Loading settings…" />
      </section>
    );
  }

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Settings</Title1>
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      <div className={styles.section}>
        <Title3 as="h2" className={styles.sectionTitle}>
          Host
        </Title3>
        <div className={styles.system}>
          <span className={styles.systemLabel}>Wisper base URL</span>
          <span className={styles.mono}>{system?.wisperBaseUrl ?? "—"}</span>
          <span className={styles.systemLabel}>Wisper host ID</span>
          <span className={styles.mono}>{system?.wisperHostId ?? "(unset)"}</span>
          <span className={styles.systemLabel}>Wisper mode</span>
          <span className={styles.mono}>{system?.wisperMode ?? "—"}</span>
          <span className={styles.systemLabel}>Wisper API key</span>
          <span className={styles.mono}>
            {system
              ? system.wisperApiKeyPresent
                ? "set"
                : "not set"
              : "—"}
          </span>
        </div>
      </div>

      <Divider />

      <div className={styles.section}>
        <Title3 as="h2" className={styles.sectionTitle}>
          Application settings
        </Title3>
        <div className={styles.form}>
          {settingsError && (
            <Text as="p" className={styles.error} role="alert">
              {settingsError}
            </Text>
          )}
          {EDITABLE_SETTINGS.map((s) =>
            s.key === "identity_me" ? (
              <Field key={s.key} label={s.label} hint={s.hint}>
                <div className={styles.identityRow}>
                  <Input
                    className={styles.identityInput}
                    type="text"
                    value={draft[s.key] ?? ""}
                    onChange={(_, d) => setDraftValue(s.key, d.value)}
                  />
                  <Button
                    disabled={resolvingIdentity}
                    onClick={() => void onResolveIdentity()}
                  >
                    {resolvingIdentity ? "Resolving…" : "Resolve from ADO"}
                  </Button>
                </div>
                {identityError && (
                  <Text as="p" className={styles.inlineError} role="alert">
                    {identityError}
                  </Text>
                )}
              </Field>
            ) : (
              <Field key={s.key} label={s.label} hint={s.hint}>
                <Input
                  type={s.numeric ? "number" : "text"}
                  value={draft[s.key] ?? ""}
                  onChange={(_, d) => setDraftValue(s.key, d.value)}
                />
              </Field>
            ),
          )}
          <div className={styles.actions}>
            <Button
              appearance="primary"
              disabled={savingSettings || changedKeys.length === 0}
              onClick={() => void onSaveSettings()}
            >
              {savingSettings ? "Saving…" : "Save settings"}
            </Button>
            {settingsSaved && (
              <Text className={styles.saved} role="status">
                Saved
              </Text>
            )}
          </div>
        </div>
      </div>

      <Divider />

      <div className={styles.section}>
        <Title3 as="h2" className={styles.sectionTitle}>
          Secrets
        </Title3>

        <div className={styles.secretForm}>
          {secretError && (
            <Text as="p" className={styles.error} role="alert">
              {secretError}
            </Text>
          )}
          <Field label="Name">
            <Input
              value={secretName}
              placeholder="e.g. ado_pat"
              onChange={(_, d) => setSecretName(d.value)}
            />
          </Field>
          <Field
            label="Value"
            hint="Write-only: stored encrypted and never displayed again."
          >
            <Input
              type="password"
              value={secretValue}
              onChange={(_, d) => setSecretValue(d.value)}
            />
          </Field>
          <div>
            <Button
              appearance="primary"
              disabled={secretSaveDisabled}
              onClick={() => void onSaveSecret()}
            >
              {savingSecret ? "Saving…" : "Add / update secret"}
            </Button>
          </div>
        </div>

        {secrets.length === 0 ? (
          <Text className={styles.empty}>No secrets stored.</Text>
        ) : (
          <div className={styles.tableWrap}>
          <Table aria-label="Secrets">
            <TableHeader>
              <TableRow>
                <SortableHeaderCell
                  columnId="name"
                  sortState={secretsSort}
                  onSort={toggleSecretsSort}
                >
                  Name
                </SortableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedSecrets.map((name) => (
                <TableRow key={name}>
                  <TableCell className={styles.mono}>{name}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      aria-label={`Delete ${name}`}
                      onClick={() => setDeleting(name)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        )}
      </div>

      <Divider />

      <div className={styles.section}>
        <Title3 as="h2" className={styles.sectionTitle}>
          Import / export configuration
        </Title3>

        <div className={styles.ioForm}>
          {exportError && (
            <Text as="p" className={styles.error} role="alert">
              {exportError}
            </Text>
          )}
          <div className={styles.ioRow}>
            <Button
              disabled={exporting}
              onClick={() => void onExport()}
            >
              {exporting ? "Exporting…" : "Export configuration"}
            </Button>
            <Text className={styles.systemLabel}>
              Downloads playbooks, rules, module config and settings as JSON.
              Secrets are referenced by name only, never included.
            </Text>
          </div>

          <Divider />

          {importError && (
            <Text as="p" className={styles.error} role="alert">
              {importError}
            </Text>
          )}

          <Field
            label="Import mode"
            hint="Merge keeps your existing objects on a name collision; overwrite replaces them."
          >
            <RadioGroup
              layout="horizontal"
              value={importMode}
              onChange={(_, d) => onImportModeChange(d.value)}
            >
              <Radio value="merge" label="Merge (skip collisions)" />
              <Radio value="overwrite" label="Overwrite collisions" />
            </RadioGroup>
          </Field>

          <Field label="Document">
            <Textarea
              aria-label="Import document"
              resize="vertical"
              rows={6}
              placeholder="Paste an exported configuration document here…"
              value={importText}
              onChange={(_, d) => onImportTextChange(d.value)}
            />
          </Field>

          <div className={styles.ioRow}>
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Import file"
              onChange={(e) => onImportFile(e.target.files?.[0])}
            />
          </div>

          <div className={styles.ioRow}>
            <Button
              appearance="primary"
              disabled={previewing || importText.trim() === ""}
              onClick={() => void onPreviewImport()}
            >
              {previewing ? "Previewing…" : "Preview import"}
            </Button>
            <Button
              disabled={applying || importPlan === null || importPlan.applied}
              onClick={() => void onApplyImport()}
            >
              {applying ? "Applying…" : "Apply import"}
            </Button>
            {importApplied && (
              <Text className={styles.saved} role="status">
                Imported
              </Text>
            )}
          </div>

          {importPlan && (
            <ImportPlanView plan={importPlan} styles={styles} />
          )}
        </div>
      </div>

      <Dialog
        open={deleting !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setDeleting(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete secret</DialogTitle>
            <DialogContent>
              {deleting &&
                `Delete secret “${deleting}”? Playbooks referencing it will no longer resolve.`}
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

/** One labelled group of planned object actions (create/skip/overwrite). */
function PlanGroup({
  title,
  items,
  className,
  listClassName,
}: {
  title: string;
  items: ImportPlanItem[];
  className: string;
  listClassName: string;
}) {
  return (
    <div>
      <Text className={className}>
        {title} ({items.length})
      </Text>
      {items.length > 0 && (
        <ul className={listClassName}>
          {items.map((item) => (
            <li key={item.key}>
              <span>{item.key}</span> — <span>{item.action}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The dry-run (or applied) import plan: per-object actions, a missing-secrets
 * checklist, and the manual post-import follow-ups the importer cannot perform.
 */
function ImportPlanView({
  plan,
  styles,
}: {
  plan: ImportPlan;
  styles: ReturnType<typeof useStyles>;
}) {
  const checklist = plan.post_import_checklist;
  return (
    <div className={styles.plan} role="region" aria-label="Import plan">
      <Text className={styles.planGroupTitle}>
        {plan.applied
          ? `Applied (${plan.mode} mode)`
          : `Dry-run plan (${plan.mode} mode) — nothing has been written yet`}
      </Text>
      <PlanGroup
        title="Playbooks"
        items={plan.playbooks}
        className={styles.planGroupTitle}
        listClassName={styles.planList}
      />
      <PlanGroup
        title="Rules"
        items={plan.rules}
        className={styles.planGroupTitle}
        listClassName={styles.planList}
      />
      <PlanGroup
        title="Modules"
        items={plan.modules}
        className={styles.planGroupTitle}
        listClassName={styles.planList}
      />
      <PlanGroup
        title="Settings"
        items={plan.settings}
        className={styles.planGroupTitle}
        listClassName={styles.planList}
      />

      <div>
        <Text className={styles.planGroupTitle}>
          Secrets to create ({checklist.secrets_to_create.length})
        </Text>
        {checklist.secrets_to_create.length > 0 && (
          <ul className={styles.planList}>
            {checklist.secrets_to_create.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <Text className={styles.planGroupTitle}>Post-import checklist</Text>
        <ul className={styles.planList}>
          <li>
            Create the missing secrets listed above (
            {checklist.secrets_to_create.length}).
          </li>
          <li>
            Set / confirm identity (me):{" "}
            {checklist.identity_me || "(unset)"}.
          </li>
          <li>
            Review and enable imported modules (they always arrive disabled):{" "}
            {checklist.modules_to_review.length > 0
              ? checklist.modules_to_review.join(", ")
              : "none"}
            .
          </li>
          <li>
            Confirm the default lease image against your wisp allow-list:{" "}
            {checklist.default_lease_image ?? "(unset)"}.
          </li>
        </ul>
      </div>
    </div>
  );
}
