import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
  Spinner,
  Switch,
  Text,
  Title1,
  Title3,
  tokens,
} from "@fluentui/react-components";
import {
  AsyncCombobox,
  type AsyncComboboxOption,
} from "../components/AsyncCombobox";
import { useLiveRefetch } from "../components/useLiveRefetch";
import { DatadogModuleCard } from "./DatadogModuleCard";
import {
  getAdoAreaPaths,
  getAdoIdentities,
  getAdoIterations,
  getAdoOrgs,
  getAdoProjects,
  getAdoStates,
  getAdoWorkItemTypes,
  getSecretNames,
} from "../discovery";
import {
  backfillModule,
  getModuleConfig,
  listModules,
  putModuleConfig,
  type AdoModuleConfig,
  type BackfillResult,
  type ModuleStatus,
  type ProducerStatus,
  type Trigger,
  type WatchedQueryConfig,
} from "../modules";

/** The one integration module this page ships an editor for. */
const ADO_MODULE_ID = "ado";

const useStyles = makeStyles({
  header: {
    marginBottom: tokens.spacingVerticalL,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
  cards: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  card: {
    maxWidth: "640px",
  },
  status: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalL,
    fontSize: tokens.fontSizeBase200,
  },
  statusLabel: {
    color: tokens.colorNeutralForeground3,
  },
  statusError: {
    color: tokens.colorPaletteRedForeground1,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  watched: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sectionTitle: {
    marginBottom: tokens.spacingVerticalXS,
  },
  formActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalS,
  },
  saved: {
    color: tokens.colorPaletteGreenForeground1,
  },
  patField: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  patHint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  warn: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorStatusWarningForeground1,
  },
  backfill: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  backfillRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: tokens.spacingHorizontalM,
  },
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
});

/**
 * Local, editable form state backing the ADO config card. `people`/`states`/
 * `area_paths` are now multi-select lists (they map 1:1 to the persisted config
 * arrays). Work-item types are NOT part of this draft — they are ephemeral UI
 * state used only to decide which states to fetch, and never persisted.
 */
interface AdoDraft {
  org: string;
  project: string;
  pat_secret_ref: string;
  enabled: boolean;
  interval_seconds: string;
  assignee_mode: "me" | "people" | "any";
  people: string[];
  states: string[];
  area_paths: string[];
  current_iteration: boolean;
}

const EMPTY_DRAFT: AdoDraft = {
  org: "",
  project: "",
  pat_secret_ref: "",
  enabled: false,
  interval_seconds: "",
  assignee_mode: "any",
  people: [],
  states: [],
  area_paths: [],
  current_iteration: false,
};

/** Build the editable draft from a stored ADO config (or defaults when null). */
function draftFromConfig(config: AdoModuleConfig | null): AdoDraft {
  const c = config ?? {};
  const w = c.watched ?? { assignee_mode: "any" };
  return {
    org: c.org ?? "",
    project: c.project ?? "",
    pat_secret_ref: c.pat_secret_ref ?? "",
    enabled: c.enabled ?? false,
    interval_seconds:
      typeof c.interval_seconds === "number" ? String(c.interval_seconds) : "",
    assignee_mode: w.assignee_mode ?? "any",
    people: w.people ?? [],
    states: w.states ?? [],
    area_paths: w.area_paths ?? [],
    current_iteration: w.iteration === "current",
  };
}

/** Assemble the config payload sent to the API from the current draft. */
function configFromDraft(draft: AdoDraft): AdoModuleConfig {
  const watched: WatchedQueryConfig = { assignee_mode: draft.assignee_mode };
  if (draft.assignee_mode === "people" && draft.people.length > 0) {
    watched.people = draft.people;
  }
  if (draft.states.length > 0) watched.states = draft.states;
  if (draft.area_paths.length > 0) watched.area_paths = draft.area_paths;
  if (draft.current_iteration) watched.iteration = "current";

  const config: AdoModuleConfig = {
    org: draft.org.trim(),
    project: draft.project.trim(),
    pat_secret_ref: draft.pat_secret_ref.trim(),
    enabled: draft.enabled,
    watched,
  };
  const interval = Number(draft.interval_seconds.trim());
  if (draft.interval_seconds.trim() !== "" && Number.isFinite(interval) && interval > 0) {
    config.interval_seconds = interval;
  }
  return config;
}

/** Dedupe a flat string list, preserving first-seen order. */
function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Render a trigger into a short human string. */
function formatTrigger(trigger: Trigger | null): string {
  if (!trigger) return "not scheduled";
  switch (trigger.kind) {
    case "interval":
      return `every ${trigger.seconds}s`;
    case "cron":
      return `cron ${trigger.expr}`;
    default:
      return "manual";
  }
}

/** Render an epoch-ms timestamp, or a dash when absent. */
function formatTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

/** The producer status block for the ADO poller. */
function ProducerStatusView({ status }: { status: ProducerStatus | null }) {
  const styles = useStyles();
  if (!status) {
    return (
      <Text className={styles.statusLabel}>Producer not registered.</Text>
    );
  }
  return (
    <div className={styles.status} data-testid="ado-status">
      <span className={styles.statusLabel}>Trigger</span>
      <span>{formatTrigger(status.trigger)}</span>
      <span className={styles.statusLabel}>Last tick</span>
      <span>{formatTime(status.lastTickAt)}</span>
      <span className={styles.statusLabel}>Next fire</span>
      <span>{formatTime(status.nextFireAt)}</span>
      <span className={styles.statusLabel}>Last error</span>
      <span className={status.lastError ? styles.statusError : undefined}>
        {status.lastError ?? "none"}
      </span>
    </div>
  );
}

/**
 * Modules page: one card per integration module. The ADO card shows its poller's
 * live status and a full config form — connection (org/project/PAT secret),
 * enable + interval, and a watched-query builder (assignee mode, people, states,
 * area paths, current-iteration toggle) — saved via PUT /api/modules/ado/config.
 */
export function ModulesPage() {
  const styles = useStyles();

  const [modules, setModules] = useState<ModuleStatus[]>([]);
  const [draft, setDraft] = useState<AdoDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Known secret NAMES, populated when the PAT picker loads. `null` means "not
  // loaded yet" so we never flash a does-not-exist warning before the fetch.
  const [secretNames, setSecretNames] = useState<string[] | null>(null);

  // Backfill flow: an optional emit cap, the busy flag, any error, the pending
  // dry-run confirmation (null when the dialog is closed), and the last applied
  // result to surface emitted/candidate counts.
  const [backfillLimit, setBackfillLimit] = useState("");
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    candidates: number;
    willEmit: number;
    limit: number | undefined;
  } | null>(null);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(
    null,
  );

  // Ephemeral, UI-only cascade state (never persisted):
  //  - `selectedTypes` narrows which work-item types' states are offered.
  //  - `allTypes` is every discovered type, used to load states when the user
  //    hasn't narrowed to specific types.
  //  - `iterations` is the fetched iteration list (null = unknown / not loaded)
  //    used only to validate the current-iteration toggle.
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [allTypes, setAllTypes] = useState<string[]>([]);
  const [iterations, setIterations] = useState<string[] | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The draft as last loaded from the server, so a live refresh can tell an
  // untouched form (safe to adopt server changes) from one the user is editing
  // (must be left alone).
  const loadedDraftRef = useRef<AdoDraft>(EMPTY_DRAFT);

  // Feeds the PAT picker AND keeps the page's copy of the known names in sync so
  // the does-not-exist warning tracks the same fetch.
  const loadSecretOptions = useCallback(async () => {
    const names = await getSecretNames();
    if (mounted.current) setSecretNames(names);
    return names.map((value) => ({ value }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextModules, cfg] = await Promise.all([
        listModules(),
        getModuleConfig<AdoModuleConfig>(ADO_MODULE_ID),
      ]);
      if (!mounted.current) return;
      setModules(nextModules);
      const loaded = draftFromConfig(cfg.config);
      loadedDraftRef.current = loaded;
      setDraft(loaded);
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

  // Live: silently reconcile module status/config when a module changes
  // elsewhere. Module status always updates; the editable draft is only adopted
  // when the user hasn't touched it, so a background refresh never clobbers an
  // in-progress edit.
  const liveRefetch = useCallback(async () => {
    try {
      const [nextModules, cfg] = await Promise.all([
        listModules(),
        getModuleConfig<AdoModuleConfig>(ADO_MODULE_ID),
      ]);
      if (!mounted.current) return;
      setModules(nextModules);
      const loaded = draftFromConfig(cfg.config);
      setDraft((prev) => {
        if (JSON.stringify(prev) !== JSON.stringify(loadedDraftRef.current)) {
          return prev; // user is editing; leave their draft untouched
        }
        loadedDraftRef.current = loaded;
        return loaded;
      });
      setError(null);
    } catch {
      // Background refresh: keep the current values; a later change reconciles.
    }
  }, []);
  useLiveRefetch("modules", liveRefetch);

  const adoStatus = useMemo<ProducerStatus | null>(() => {
    const mod = modules.find((m) => m.id === ADO_MODULE_ID);
    return mod?.producers[0] ?? null;
  }, [modules]);

  // The datadog module renders its own config card (see DatadogModuleCard) beside
  // the ADO card when the registry reports it. Only its live producer statuses
  // flow through here; the card owns its config CRUD.
  const datadogModule = useMemo(
    () => modules.find((m) => m.id === "datadog") ?? null,
    [modules],
  );

  // A referenced PAT secret name that isn't (yet) in the store. Only flagged
  // once the picker has loaded; never blocks saving.
  const patUnknown = useMemo(() => {
    const ref = draft.pat_secret_ref.trim();
    return ref !== "" && secretNames !== null && !secretNames.includes(ref);
  }, [draft.pat_secret_ref, secretNames]);

  const patch = useCallback((next: Partial<AdoDraft>) => {
    setSaved(false);
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const org = draft.org.trim();
  const project = draft.project.trim();

  // Work-item types are project-scoped; drop any prior type selection whenever
  // the org/project changes so stale types never drive the states picker.
  useEffect(() => {
    setSelectedTypes([]);
    setAllTypes([]);
  }, [org, project]);

  // Fetch the project's iterations purely to validate the current-iteration
  // toggle (a project with zero iterations can't match "current"). A failed
  // fetch leaves `iterations` null — validation simply goes quiet, never blocks.
  useEffect(() => {
    if (!org || !project) {
      setIterations(null);
      return;
    }
    let cancelled = false;
    getAdoIterations(org, project)
      .then((list) => {
        if (!cancelled) setIterations(list);
      })
      .catch(() => {
        if (!cancelled) setIterations(null);
      });
    return () => {
      cancelled = true;
    };
  }, [org, project]);

  // --- Cascade loaders. Each returns [] when its prerequisites are unset so a
  // dependent picker never fires a request that the backend would 400. Pickers
  // remount (via `key`) when a parent selection changes, re-running these. ---

  const loadOrgs = useCallback(async (): Promise<AsyncComboboxOption[]> => {
    return (await getAdoOrgs()).map((value) => ({ value }));
  }, []);

  const loadProjects = useCallback(async (): Promise<AsyncComboboxOption[]> => {
    if (!org) return [];
    return (await getAdoProjects(org)).map((value) => ({ value }));
  }, [org]);

  const loadTypes = useCallback(async (): Promise<AsyncComboboxOption[]> => {
    if (!org || !project) return [];
    return (await getAdoWorkItemTypes(org, project)).map((value) => ({ value }));
  }, [org, project]);

  const loadStates = useCallback(async (): Promise<AsyncComboboxOption[]> => {
    if (!org || !project) return [];
    // States are per-type: fetch for the narrowed selection, else for every
    // discovered type, unioning the results.
    const types = selectedTypes.length > 0 ? selectedTypes : allTypes;
    if (types.length === 0) return [];
    const perType = await Promise.all(
      types.map((type) => getAdoStates(org, project, type)),
    );
    return uniq(perType.flat()).map((value) => ({ value }));
  }, [org, project, selectedTypes, allTypes]);

  const loadAreaPaths = useCallback(async (): Promise<AsyncComboboxOption[]> => {
    if (!org || !project) return [];
    return (await getAdoAreaPaths(org, project)).map((value) => ({ value }));
  }, [org, project]);

  const loadPeople = useCallback(async (): Promise<AsyncComboboxOption[]> => {
    if (!org || !project) return [];
    return getAdoIdentities(org, project);
  }, [org, project]);

  // Autofill: when discovery returns exactly one candidate and the field is
  // still empty, select it so the cascade advances without a manual click.
  const autofillOrg = useCallback(
    (opts: AsyncComboboxOption[]) => {
      if (opts.length === 1 && draft.org.trim() === "")
        patch({ org: opts[0].value });
    },
    [draft.org, patch],
  );
  const autofillProject = useCallback(
    (opts: AsyncComboboxOption[]) => {
      if (opts.length === 1 && draft.project.trim() === "")
        patch({ project: opts[0].value });
    },
    [draft.project, patch],
  );
  const captureTypes = useCallback((opts: AsyncComboboxOption[]) => {
    setAllTypes(opts.map((o) => o.value));
  }, []);

  // The current-iteration toggle is on, but the project's fetched iteration list
  // came back empty — the filter would match nothing. Only shown when we could
  // actually read the iterations (degrades silently otherwise).
  const iterationWarn =
    draft.current_iteration && iterations !== null && iterations.length === 0;

  const onSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await putModuleConfig(ADO_MODULE_ID, configFromDraft(draft));
      if (!mounted.current) return;
      setSaved(true);
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [draft, refresh]);

  // Parse the optional limit field: a blank or non-positive value means "no
  // limit" (replay every watched item).
  const parseLimit = useCallback((): number | undefined => {
    const raw = backfillLimit.trim();
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }, [backfillLimit]);

  // Step 1: a dry run counts the candidates without emitting, then opens the
  // confirm dialog. `willEmit` is what a real run would actually emit given the
  // limit — the dry run itself always reports emitted: 0.
  const onBackfillPreview = useCallback(async () => {
    setBackfillBusy(true);
    setBackfillError(null);
    setBackfillResult(null);
    try {
      const limit = parseLimit();
      const res = await backfillModule(ADO_MODULE_ID, { dryRun: true, limit });
      if (!mounted.current) return;
      const willEmit =
        limit !== undefined ? Math.min(res.candidates, limit) : res.candidates;
      setConfirm({ candidates: res.candidates, willEmit, limit });
    } catch (err) {
      if (!mounted.current) return;
      setBackfillError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBackfillBusy(false);
    }
  }, [parseLimit]);

  // Step 2: apply the backfill for real using the limit captured at preview,
  // then refresh so the producer's last-tick status reflects any new events.
  const onBackfillApply = useCallback(async () => {
    if (!confirm) return;
    setBackfillBusy(true);
    setBackfillError(null);
    try {
      const res = await backfillModule(ADO_MODULE_ID, {
        dryRun: false,
        limit: confirm.limit,
      });
      if (!mounted.current) return;
      setBackfillResult(res);
      setConfirm(null);
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setBackfillError(err instanceof Error ? err.message : String(err));
      setConfirm(null);
    } finally {
      if (mounted.current) setBackfillBusy(false);
    }
  }, [confirm, refresh]);

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Modules</Title1>
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      {loading ? (
        <Spinner label="Loading modules…" />
      ) : (
        <div className={styles.cards}>
        <Card className={styles.card}>
          <CardHeader
            header={<Title3>Azure DevOps</Title3>}
            description={
              <Badge appearance="tint" color={draft.enabled ? "success" : "informative"}>
                {draft.enabled ? "enabled" : "disabled"}
              </Badge>
            }
          />

          <ProducerStatusView status={adoStatus} />

          <div className={styles.backfill}>
            <Title3 as="h3" className={styles.sectionTitle}>
              Backfill
            </Title3>
            <Text as="p" className={styles.hint}>
              Replay the currently-watched work items through the normal rules
              engine — e.g. to triage an existing backlog. Emitted events obey the
              same dedupe and rate caps as a poll.
            </Text>
            <div className={styles.backfillRow}>
              <Field label="Limit (optional)">
                <Input
                  type="number"
                  value={backfillLimit}
                  placeholder="all"
                  aria-label="Backfill limit"
                  onChange={(_, d) => setBackfillLimit(d.value)}
                />
              </Field>
              <Button
                disabled={backfillBusy}
                onClick={() => void onBackfillPreview()}
              >
                {backfillBusy ? "Working…" : "Backfill"}
              </Button>
            </div>
            {backfillError && (
              <Text as="p" className={styles.error} role="alert">
                {backfillError}
              </Text>
            )}
            {backfillResult && (
              <Text as="p" className={styles.saved} role="status">
                Emitted {backfillResult.emitted} of {backfillResult.candidates}{" "}
                candidate{backfillResult.candidates === 1 ? "" : "s"}.
              </Text>
            )}
          </div>

          <Dialog
            open={confirm !== null}
            onOpenChange={(_, d) => {
              if (!d.open) setConfirm(null);
            }}
          >
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Backfill</DialogTitle>
                <DialogContent>
                  This will emit {confirm?.willEmit} event
                  {confirm?.willEmit === 1 ? "" : "s"} — continue?
                </DialogContent>
                <DialogActions>
                  <Button
                    appearance="secondary"
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    appearance="primary"
                    disabled={backfillBusy}
                    onClick={() => void onBackfillApply()}
                  >
                    Continue
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <div className={styles.form}>
            {saveError && (
              <Text as="p" className={styles.error} role="alert">
                {saveError}
              </Text>
            )}

            <div className={styles.patField}>
              <AsyncCombobox
                label="PAT secret name"
                aria-label="PAT secret name"
                placeholder="e.g. ado_pat"
                value={draft.pat_secret_ref}
                onChange={(v) => patch({ pat_secret_ref: v })}
                load={loadSecretOptions}
              />
              <Text as="p" className={styles.patHint}>
                Name of a secret in the store; the token value is injected into
                leases, never shown here. Pick it first — every dropdown below is
                discovered with this PAT.
              </Text>
              {patUnknown && (
                <Text as="p" className={styles.warn} role="note">
                  “{draft.pat_secret_ref.trim()}” isn't in the secret store yet —
                  add it on the Settings page before enabling this module.
                </Text>
              )}
            </div>

            <AsyncCombobox
              label="Organization"
              aria-label="Organization"
              placeholder="e.g. contoso"
              hint="Discovered from the PAT; type to enter one manually."
              value={draft.org}
              onChange={(v) => patch({ org: v, project: "" })}
              load={loadOrgs}
              onLoaded={autofillOrg}
            />

            <AsyncCombobox
              key={`project-${org}`}
              label="Project"
              aria-label="Project"
              placeholder="e.g. Platform"
              hint="Projects in the selected organization."
              value={draft.project}
              onChange={(v) => patch({ project: v })}
              load={loadProjects}
              onLoaded={autofillProject}
            />

            <Switch
              label="Enabled"
              checked={draft.enabled}
              onChange={(_, d) => patch({ enabled: d.checked })}
            />

            <Field label="Poll interval (seconds)" hint="Blank uses the server default.">
              <Input
                type="number"
                value={draft.interval_seconds}
                placeholder="60"
                onChange={(_, d) => patch({ interval_seconds: d.value })}
              />
            </Field>

            <div className={styles.watched}>
              <Title3 as="h3" className={styles.sectionTitle}>
                Watched query
              </Title3>

              <Field label="Assignee">
                <RadioGroup
                  value={draft.assignee_mode}
                  onChange={(_, d) =>
                    patch({ assignee_mode: d.value as AdoDraft["assignee_mode"] })
                  }
                >
                  <Radio value="me" label="Me" />
                  <Radio value="people" label="Specific people" />
                  <Radio value="any" label="Anyone" />
                </RadioGroup>
              </Field>

              {draft.assignee_mode === "people" && (
                <AsyncCombobox
                  key={`people-${org}-${project}`}
                  multiselect
                  label="People"
                  aria-label="People"
                  hint="Identities in the project; type to add any address."
                  placeholder="alice@contoso.com"
                  value={draft.people}
                  onChange={(v) => patch({ people: v })}
                  load={loadPeople}
                />
              )}

              <AsyncCombobox
                key={`types-${org}-${project}`}
                multiselect
                label="Work item types"
                aria-label="Work item types"
                hint="Narrows which states are offered below; not saved."
                placeholder="Bug"
                value={selectedTypes}
                onChange={(v) => {
                  setSaved(false);
                  setSelectedTypes(v);
                }}
                load={loadTypes}
                onLoaded={captureTypes}
              />

              <AsyncCombobox
                key={`states-${org}-${project}-${selectedTypes.join("|")}-${allTypes.join("|")}`}
                multiselect
                label="States"
                aria-label="States"
                hint="Blank matches any state."
                placeholder="Active"
                value={draft.states}
                onChange={(v) => patch({ states: v })}
                load={loadStates}
              />

              <AsyncCombobox
                key={`areas-${org}-${project}`}
                multiselect
                label="Area paths"
                aria-label="Area paths"
                hint="Matches items UNDER each selected path."
                placeholder="Platform\Backend"
                value={draft.area_paths}
                onChange={(v) => patch({ area_paths: v })}
                load={loadAreaPaths}
              />

              <Switch
                label="Current iteration only"
                checked={draft.current_iteration}
                onChange={(_, d) => patch({ current_iteration: d.checked })}
              />
              {iterationWarn && (
                <Text as="p" className={styles.warn} data-testid="iteration-warn">
                  This project has no iterations configured, so the
                  current-iteration filter won't match anything.
                </Text>
              )}
            </div>

            <div className={styles.formActions}>
              <Button
                appearance="primary"
                disabled={saving}
                onClick={() => void onSave()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved && (
                <Text className={styles.saved} role="status">
                  Saved
                </Text>
              )}
            </div>
          </div>
        </Card>

        {datadogModule && (
          <DatadogModuleCard
            producers={datadogModule.producers}
            onSaved={refresh}
          />
        )}
        </div>
      )}
    </section>
  );
}
