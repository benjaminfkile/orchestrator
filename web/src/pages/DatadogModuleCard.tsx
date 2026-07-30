import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  makeStyles,
  Switch,
  Text,
  Title3,
  tokens,
} from "@fluentui/react-components";
import { AsyncCombobox } from "../components/AsyncCombobox";
import { getSecretNames } from "../discovery";
import {
  getModuleConfig,
  putModuleConfig,
  type DatadogModuleConfig,
  type DatadogMonitorsConfig,
  type DatadogWatchConfig,
  type ProducerStatus,
  type Trigger,
} from "../modules";

/** This card's module id and its `module_config` key. */
const DATADOG_MODULE_ID = "datadog";

/** Placeholder shown in the site field — the server default when it is blank. */
const DEFAULT_SITE = "datadoghq.com";

const useStyles = makeStyles({
  card: {
    maxWidth: "640px",
  },
  status: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalM,
    fontSize: tokens.fontSizeBase200,
  },
  statusLabel: {
    color: tokens.colorNeutralForeground3,
  },
  statusError: {
    color: tokens.colorPaletteRedForeground1,
  },
  producerName: {
    gridColumn: "1 / -1",
    fontWeight: tokens.fontWeightSemibold,
    marginTop: tokens.spacingVerticalXS,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  section: {
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
  watchGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: tokens.spacingHorizontalM,
  },
  watchWide: {
    gridColumn: "1 / -1",
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
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
  secretField: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  warn: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorStatusWarningForeground1,
  },
  watchHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
});

/**
 * Editable form state for one watch row. Every numeric field is held as a raw
 * string so a half-typed value never coerces to NaN — the values parse back into
 * the config (and the server validates ranges) only on save.
 */
interface WatchDraft {
  name: string;
  query: string;
  group_by: string;
  window_seconds: string;
  min_count: string;
  spike_multiplier: string;
  baseline_windows: string;
  novel_groups: boolean;
  sample_limit: string;
}

/** Local, editable form state backing the Datadog config card. */
interface DatadogDraft {
  enabled: boolean;
  site: string;
  api_key_secret_ref: string;
  app_key_secret_ref: string;
  interval_seconds: string;
  monitors_enabled: boolean;
  monitor_tags: string[];
  watches: WatchDraft[];
}

const EMPTY_WATCH: WatchDraft = {
  name: "",
  query: "",
  group_by: "",
  window_seconds: "",
  min_count: "",
  spike_multiplier: "",
  baseline_windows: "",
  novel_groups: false,
  sample_limit: "",
};

const EMPTY_DRAFT: DatadogDraft = {
  enabled: false,
  site: "",
  api_key_secret_ref: "",
  app_key_secret_ref: "",
  interval_seconds: "",
  monitors_enabled: false,
  monitor_tags: [],
  watches: [],
};

/** Render an optional number into its editable string form (blank when unset). */
function numStr(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

/** Build one watch draft from a stored watch config. */
function watchDraftFromConfig(w: DatadogWatchConfig): WatchDraft {
  const d = w.detect ?? {};
  return {
    name: w.name ?? "",
    query: w.query ?? "",
    group_by: w.group_by ?? "",
    window_seconds: numStr(w.window_seconds),
    min_count: numStr(d.min_count),
    spike_multiplier: numStr(d.spike_multiplier),
    baseline_windows: numStr(d.baseline_windows),
    novel_groups: d.novel_groups ?? false,
    sample_limit: numStr(w.sample_limit),
  };
}

/** Build the editable draft from a stored Datadog config (or defaults when null). */
function draftFromConfig(config: DatadogModuleConfig | null): DatadogDraft {
  const c = config ?? {};
  return {
    enabled: c.enabled ?? false,
    site: c.site ?? "",
    api_key_secret_ref: c.api_key_secret_ref ?? "",
    app_key_secret_ref: c.app_key_secret_ref ?? "",
    interval_seconds:
      typeof c.interval_seconds === "number" ? String(c.interval_seconds) : "",
    monitors_enabled: c.monitors?.enabled ?? false,
    monitor_tags: c.monitors?.monitor_tags ?? [],
    watches: (c.watches ?? []).map(watchDraftFromConfig),
  };
}

/** Parse an editable numeric string to a finite number, or undefined when blank/invalid. */
function toNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Assemble one watch's config from its draft. Required strings are trimmed and
 * always sent (blank ones let the server return its own validation message);
 * numeric + detect fields are omitted when blank so a half-filled row degrades to
 * a bare count rather than a NaN.
 */
function watchConfigFromDraft(w: WatchDraft): DatadogWatchConfig {
  const watch: DatadogWatchConfig = {
    name: w.name.trim(),
    query: w.query.trim(),
    group_by: w.group_by.trim(),
  };
  const window = toNumber(w.window_seconds);
  if (window !== undefined) watch.window_seconds = window;
  const sample = toNumber(w.sample_limit);
  if (sample !== undefined) watch.sample_limit = sample;

  const detect: NonNullable<DatadogWatchConfig["detect"]> = {};
  const minCount = toNumber(w.min_count);
  if (minCount !== undefined) detect.min_count = minCount;
  const spike = toNumber(w.spike_multiplier);
  if (spike !== undefined) detect.spike_multiplier = spike;
  const baseline = toNumber(w.baseline_windows);
  if (baseline !== undefined) detect.baseline_windows = baseline;
  if (w.novel_groups) detect.novel_groups = true;
  if (Object.keys(detect).length > 0) watch.detect = detect;

  return watch;
}

/** Assemble the config payload sent to the API from the current draft. */
function configFromDraft(draft: DatadogDraft): DatadogModuleConfig {
  const config: DatadogModuleConfig = { enabled: draft.enabled };

  const site = draft.site.trim();
  if (site !== "") config.site = site;
  const apiRef = draft.api_key_secret_ref.trim();
  if (apiRef !== "") config.api_key_secret_ref = apiRef;
  const appRef = draft.app_key_secret_ref.trim();
  if (appRef !== "") config.app_key_secret_ref = appRef;

  const interval = toNumber(draft.interval_seconds);
  if (interval !== undefined && interval > 0) config.interval_seconds = interval;

  const monitors: DatadogMonitorsConfig = {};
  if (draft.monitors_enabled) monitors.enabled = true;
  if (draft.monitor_tags.length > 0) monitors.monitor_tags = draft.monitor_tags;
  if (Object.keys(monitors).length > 0) config.monitors = monitors;

  if (draft.watches.length > 0) {
    config.watches = draft.watches.map(watchConfigFromDraft);
  }
  return config;
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

/** The status block for the Datadog producers (one row group per producer). */
function ProducersStatusView({ producers }: { producers: ProducerStatus[] }) {
  const styles = useStyles();
  if (producers.length === 0) {
    return <Text className={styles.statusLabel}>Producers not registered.</Text>;
  }
  return (
    <div className={styles.status} data-testid="datadog-status">
      {producers.map((p) => (
        <div key={p.producerId} style={{ display: "contents" }}>
          <span className={styles.producerName}>{p.producerId}</span>
          <span className={styles.statusLabel}>Trigger</span>
          <span>{formatTrigger(p.trigger)}</span>
          <span className={styles.statusLabel}>Last tick</span>
          <span>{formatTime(p.lastTickAt)}</span>
          <span className={styles.statusLabel}>Next fire</span>
          <span>{formatTime(p.nextFireAt)}</span>
          <span className={styles.statusLabel}>Last error</span>
          <span className={p.lastError ? styles.statusError : undefined}>
            {p.lastError ?? "none"}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Props: the module's live producer statuses and a refresh hook after save. */
interface DatadogModuleCardProps {
  producers: ProducerStatus[];
  /** Called after a successful save so the page can refresh producer status. */
  onSaved?: () => void;
}

/**
 * The Datadog module config card. Renders the two producers' live status and a
 * full config form — connection (site + API/App key secret refs), enable +
 * interval, the monitor-transition sub-section (enable + tag filter), and a humble
 * watches editor (rows of inputs; the query string is pasted from Datadog). Saved
 * via PUT /api/modules/datadog/config, whose 400 validation message is surfaced
 * inline. Nothing here knows what a watched log or monitor MEANS — intent lives
 * entirely in the user's names, queries, and tags (see CLAUDE.md).
 */
export function DatadogModuleCard({
  producers,
  onSaved,
}: DatadogModuleCardProps) {
  const styles = useStyles();

  const [draft, setDraft] = useState<DatadogDraft>(EMPTY_DRAFT);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Known secret NAMES, populated when a picker loads. `null` means "not loaded
  // yet" so we never flash a does-not-exist warning before the fetch resolves.
  const [secretNames, setSecretNames] = useState<string[] | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getModuleConfig<DatadogModuleConfig>(DATADOG_MODULE_ID);
      if (!mounted.current) return;
      setDraft(draftFromConfig(cfg.config));
      setLoadError(null);
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // Feeds BOTH secret pickers AND keeps the card's copy of the known names in
  // sync so the does-not-exist warnings track the same fetch.
  const loadSecretOptions = useCallback(async () => {
    const names = await getSecretNames();
    if (mounted.current) setSecretNames(names);
    return names.map((value) => ({ value }));
  }, []);

  const patch = useCallback((next: Partial<DatadogDraft>) => {
    setSaved(false);
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  // A referenced secret name that isn't (yet) in the store. Only flagged once a
  // picker has loaded; never blocks saving.
  const unknownSecret = useCallback(
    (ref: string) => {
      const r = ref.trim();
      return r !== "" && secretNames !== null && !secretNames.includes(r);
    },
    [secretNames],
  );
  const apiKeyUnknown = useMemo(
    () => unknownSecret(draft.api_key_secret_ref),
    [unknownSecret, draft.api_key_secret_ref],
  );
  const appKeyUnknown = useMemo(
    () => unknownSecret(draft.app_key_secret_ref),
    [unknownSecret, draft.app_key_secret_ref],
  );

  // --- Watch row helpers. Each rewrites the watches array immutably. ---

  const patchWatch = useCallback(
    (index: number, next: Partial<WatchDraft>) => {
      setSaved(false);
      setDraft((prev) => ({
        ...prev,
        watches: prev.watches.map((w, i) =>
          i === index ? { ...w, ...next } : w,
        ),
      }));
    },
    [],
  );

  const addWatch = useCallback(() => {
    setSaved(false);
    setDraft((prev) => ({ ...prev, watches: [...prev.watches, { ...EMPTY_WATCH }] }));
  }, []);

  const removeWatch = useCallback((index: number) => {
    setSaved(false);
    setDraft((prev) => ({
      ...prev,
      watches: prev.watches.filter((_, i) => i !== index),
    }));
  }, []);

  const onSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await putModuleConfig(DATADOG_MODULE_ID, configFromDraft(draft));
      if (!mounted.current) return;
      setSaved(true);
      await loadConfig();
      onSaved?.();
    } catch (err) {
      if (!mounted.current) return;
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [draft, loadConfig, onSaved]);

  return (
    <Card className={styles.card}>
      <CardHeader
        header={<Title3>Datadog</Title3>}
        description={
          <Badge
            appearance="tint"
            color={draft.enabled ? "success" : "informative"}
          >
            {draft.enabled ? "enabled" : "disabled"}
          </Badge>
        }
      />

      <ProducersStatusView producers={producers} />

      <div className={styles.form}>
        {loadError && (
          <Text as="p" className={styles.error} role="alert">
            {loadError}
          </Text>
        )}
        {saveError && (
          <Text as="p" className={styles.error} role="alert">
            {saveError}
          </Text>
        )}

        <div className={styles.secretField}>
          <AsyncCombobox
            label="Datadog API key secret"
            aria-label="Datadog API key secret"
            placeholder="e.g. DD_API_KEY"
            value={draft.api_key_secret_ref}
            onChange={(v) => patch({ api_key_secret_ref: v })}
            load={loadSecretOptions}
          />
          <Text as="p" className={styles.hint}>
            Name of a secret in the store; the key value is injected into leases,
            never shown here.
          </Text>
          {apiKeyUnknown && (
            <Text as="p" className={styles.warn} role="note">
              “{draft.api_key_secret_ref.trim()}” isn't in the secret store yet —
              add it on the Settings page before enabling this module.
            </Text>
          )}
        </div>

        <div className={styles.secretField}>
          <AsyncCombobox
            label="Datadog Application key secret"
            aria-label="Datadog Application key secret"
            placeholder="e.g. DD_APP_KEY"
            value={draft.app_key_secret_ref}
            onChange={(v) => patch({ app_key_secret_ref: v })}
            load={loadSecretOptions}
          />
          {appKeyUnknown && (
            <Text as="p" className={styles.warn} role="note">
              “{draft.app_key_secret_ref.trim()}” isn't in the secret store yet —
              add it on the Settings page before enabling this module.
            </Text>
          )}
        </div>

        <Field label="Site" hint={`Bare Datadog domain; blank uses ${DEFAULT_SITE}.`}>
          <Input
            value={draft.site}
            placeholder={DEFAULT_SITE}
            aria-label="Site"
            onChange={(_, d) => patch({ site: d.value })}
          />
        </Field>

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
            aria-label="Datadog poll interval (seconds)"
            onChange={(_, d) => patch({ interval_seconds: d.value })}
          />
        </Field>

        <div className={styles.section}>
          <Title3 as="h3" className={styles.sectionTitle}>
            Monitors
          </Title3>
          <Switch
            label="Watch monitor transitions"
            checked={draft.monitors_enabled}
            onChange={(_, d) => patch({ monitors_enabled: d.checked })}
          />
          <AsyncCombobox
            multiselect
            label="Monitor tags"
            aria-label="Monitor tags"
            hint="Restrict to monitors carrying ALL of these tags; blank watches all."
            placeholder="team:platform"
            value={draft.monitor_tags}
            onChange={(v) => patch({ monitor_tags: v })}
            // Monitor tags are freeform; there is no discovery list to fetch.
            load={async () => []}
            autoLoad={false}
          />
        </div>

        <div className={styles.section}>
          <div className={styles.watchHeader}>
            <Title3 as="h3" className={styles.sectionTitle}>
              Watches
            </Title3>
            <Button appearance="secondary" onClick={addWatch}>
              Add watch
            </Button>
          </div>
          <Text as="p" className={styles.hint}>
            Each watch counts a log query grouped by a facet and fires only on a
            statistical change. Paste the query string from Datadog.
          </Text>

          {draft.watches.length === 0 && (
            <Text as="p" className={styles.hint}>
              No watches configured.
            </Text>
          )}

          {draft.watches.map((w, i) => {
            const n = i + 1;
            return (
              <div
                key={i}
                className={styles.section}
                data-testid={`datadog-watch-${i}`}
              >
                <div className={styles.watchHeader}>
                  <Text weight="semibold">Watch {n}</Text>
                  <Button
                    appearance="subtle"
                    aria-label={`Remove watch ${n}`}
                    onClick={() => removeWatch(i)}
                  >
                    Remove
                  </Button>
                </div>

                <Field label="Name">
                  <Input
                    value={w.name}
                    aria-label={`Watch ${n} name`}
                    onChange={(_, d) => patchWatch(i, { name: d.value })}
                  />
                </Field>

                <Field label="Query" hint="Pasted from Datadog log search.">
                  <Input
                    value={w.query}
                    aria-label={`Watch ${n} query`}
                    onChange={(_, d) => patchWatch(i, { query: d.value })}
                  />
                </Field>

                <div className={styles.watchGrid}>
                  <Field label="Group by">
                    <Input
                      value={w.group_by}
                      aria-label={`Watch ${n} group by`}
                      onChange={(_, d) => patchWatch(i, { group_by: d.value })}
                    />
                  </Field>
                  <Field label="Window (seconds)">
                    <Input
                      type="number"
                      value={w.window_seconds}
                      aria-label={`Watch ${n} window seconds`}
                      onChange={(_, d) =>
                        patchWatch(i, { window_seconds: d.value })
                      }
                    />
                  </Field>
                  <Field label="Min count">
                    <Input
                      type="number"
                      value={w.min_count}
                      aria-label={`Watch ${n} min count`}
                      onChange={(_, d) => patchWatch(i, { min_count: d.value })}
                    />
                  </Field>
                  <Field label="Spike multiplier">
                    <Input
                      type="number"
                      value={w.spike_multiplier}
                      aria-label={`Watch ${n} spike multiplier`}
                      onChange={(_, d) =>
                        patchWatch(i, { spike_multiplier: d.value })
                      }
                    />
                  </Field>
                  <Field label="Baseline windows">
                    <Input
                      type="number"
                      value={w.baseline_windows}
                      aria-label={`Watch ${n} baseline windows`}
                      onChange={(_, d) =>
                        patchWatch(i, { baseline_windows: d.value })
                      }
                    />
                  </Field>
                  <Field label="Sample limit">
                    <Input
                      type="number"
                      value={w.sample_limit}
                      aria-label={`Watch ${n} sample limit`}
                      onChange={(_, d) =>
                        patchWatch(i, { sample_limit: d.value })
                      }
                    />
                  </Field>
                </div>

                <Switch
                  label="Detect novel groups"
                  aria-label={`Watch ${n} novel groups`}
                  checked={w.novel_groups}
                  onChange={(_, d) => patchWatch(i, { novel_groups: d.checked })}
                />
              </div>
            );
          })}
        </div>

        <div className={styles.formActions}>
          <Button
            appearance="primary"
            disabled={saving}
            aria-label="Save Datadog config"
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
  );
}
