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
  Label,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
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
import { ApiError } from "../api";
import {
  AsyncCombobox,
  type AsyncComboboxOption,
} from "../components/AsyncCombobox";
import { useLiveRefetch } from "../components/useLiveRefetch";
import {
  getAnthropicModelOptions,
  getCapabilityOptions,
  getImageSuggestions,
  getSecretNames,
  getWisperHostOptions,
} from "../discovery";
import { CLAUDE_CODE_TOOLS, NETWORK_MODES } from "../tools";
import {
  createPlaybook,
  DEFAULT_RUNNER,
  deletePlaybook,
  getPlaybookUsage,
  LEASE_ISOLATION_LEVELS,
  listPlaybooks,
  listRunners,
  updatePlaybook,
  type GrantedCapability,
  type LeaseIsolation,
  type NewPlaybook,
  type PlaybookRecord,
  type PlaybookResources,
  type PlaybookStep,
  type PlaybookStepPhase,
  type PlaybookUsage,
} from "../playbooks";
import { listSnippets, type SnippetRecord } from "../snippets";
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

/** Sort columns for the playbooks table; the Actions column doesn't sort. The
 * table renders no time/id column, so it starts in the backend's newest-first
 * load order (see {@link LOADED_ORDER_SORT}) until a header is clicked. */
const PLAYBOOK_SORT_COLUMNS: SortColumn<PlaybookRecord>[] = [
  { columnId: "name", value: (pb) => pb.name },
  { columnId: "image", value: (pb) => pb.image },
  { columnId: "network", value: (pb) => pb.network },
  { columnId: "ttl", value: (pb) => pb.ttl_seconds },
  { columnId: "steps", value: (pb) => pb.steps.length },
];

/**
 * The values a client-side search matches a playbook against: every rendered
 * column plus the opaque `runner_config` (stringified to JSON) so a playbook is
 * findable by, say, its model or command-template fragment — not just its name.
 */
const playbookSearchValues = (pb: PlaybookRecord): readonly unknown[] => [
  pb.name,
  pb.image,
  pb.network,
  pb.ttl_seconds,
  pb.steps.length,
  pb.runner,
  pb.runner_config,
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
  // Centered editor Dialog. The Playbooks form is long, so the surface takes a
  // tall fixed height and its content region scrolls internally.
  surface: {
    width: "min(900px, 92vw)",
    maxWidth: "min(900px, 92vw)",
    height: "90vh",
    maxHeight: "90vh",
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
  // Let the grid body fill the surface so its content region scrolls while the
  // title and action bar stay pinned.
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
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
  rowCell: {
    flexGrow: 1,
    minWidth: "120px",
  },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
  },
  tagInput: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  stepRow: {
    display: "flex",
    alignItems: "flex-end",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  stepPhase: {
    width: "110px",
    minWidth: "90px",
    flexShrink: 1,
  },
  stepLabel: {
    width: "150px",
    minWidth: "110px",
    flexShrink: 1,
  },
  stepSource: {
    width: "150px",
    minWidth: "120px",
    flexShrink: 1,
  },
  stepCommand: {
    flexGrow: 1,
    minWidth: "160px",
  },
  // A field header with a trailing action (the prompt's "Insert snippet" menu).
  fieldWithAction: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
  },
  snippetPreviewHint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: tokens.spacingVerticalXS,
  },
  // The inline snippet menu needs an explicit z-index: Fluent only applies its
  // popup z-index to the PORTAL wrapper, so an `inline` MenuPopover (kept
  // inline to survive the modal Dialog's focus trap — see task #379) would
  // otherwise paint BEHIND the form fields that follow it in the dialog.
  snippetMenuPopover: {
    zIndex: 1000,
  },
  hint: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    whiteSpace: "pre-wrap",
    marginTop: tokens.spacingVerticalXS,
  },
  // Per-capability JSON config editors, stacked under the grants picker.
  capabilities: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  capabilityConfig: {
    // Indent each config editor so it visually nests under its capability.
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralStroke2}`,
  },
  warn: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorStatusWarningForeground1,
    marginTop: tokens.spacingVerticalXS,
  },
  // The delete confirmation stacks a warning, an optional rule list, and an
  // optional in-flight notice.
  deleteBody: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  deleteRules: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalL,
  },
});

/** Pick the singular or plural noun for a count (`1 run` / `2 runs`). */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A single contiguous "N dispatches, M runs, K findings" string for the warning. */
function cascadeSummary(u: PlaybookUsage): string {
  return (
    `${u.dispatches} ${plural(u.dispatches, "dispatch", "dispatches")}, ` +
    `${u.runs} ${plural(u.runs, "run", "runs")}, ` +
    `${u.findings} ${plural(u.findings, "finding", "findings")}`
  );
}

/** Static reference of the `{{...}}` substitutions the templates accept. */
const SUBSTITUTION_HINT = [
  "Available substitutions:",
  "  {{event.type}}         event type string",
  "  {{event.source}}       producing module id",
  "  {{event.subject_ref}}  subject reference",
  "  {{payload.<path>}}     any dotted path into the event payload",
  "  {{env.<NAME>}}         resolved secret (userdata & step commands only)",
].join("\n");

/** The built-in runner ids the editor renders a bespoke config form for. Any
 * other (future) runner id falls back to the raw `runner_config` JSON editor. */
const CLAUDE_CODE_RUNNER = "claude-code";
const SCRIPT_RUNNER = "script";

/** Hint under the script runner's command textarea — the same `{{...}}` engine
 * as prompts/steps renders it against the triggering event and resolved env. */
const SCRIPT_COMMAND_HINT =
  "Rendered with {{event.*}} / {{payload.*}} / {{env.*}} substitution against the triggering event.";

/** A step row with a stable key so React survives reorder/removal. */
interface StepDraft extends PlaybookStep {
  key: string;
}

/**
 * Parse a whole-value snippet reference (`snippet:<name>`) out of a stored
 * userdata value or step command. Returns the referenced name, or `null` when
 * the value is inline custom text. The backend requires an EXACT `snippet:<name>`
 * — no inline mixing — so userdata and steps reference a single snippet whole.
 */
function parseSnippetRef(value: string): string | null {
  const match = /^snippet:(.+)$/.exec(value);
  return match ? match[1] : null;
}

/** The literal token a prompt snippet is inserted as. Prompt snippets are
 * STACKABLE `{{snippet.<name>}}` tokens (dot form) — distinct from the whole
 * `snippet:<name>` reference used by userdata and steps. */
function promptSnippetToken(name: string): string {
  return `{{snippet.${name}}}`;
}

/**
 * A granted-capability row. `config_text` is the raw JSON textarea contents (an
 * empty box means "no config" → the executor falls back to the module's config).
 * The stable `key` survives add/remove.
 */
interface CapabilityDraft {
  key: string;
  capability_id: string;
  config_text: string;
}

/** Editable form state backing the create/edit drawer. Numbers are held as
 * strings so partially-typed input never collapses to NaN mid-edit. */
interface DraftState {
  name: string;
  image: string;
  /** Host selector; blank = the configured default host. */
  host: string;
  /** Lease isolation; blank = the wisper server default ("shared"). */
  isolation: string;
  network: string;
  ttl_seconds: string;
  cpus: string;
  memory_mb: string;
  pids: string;
  // The chosen runner id plus the editable fields backing each built-in runner's
  // config form. They are held independently so switching runners preserves what
  // the user typed for the others; only the selected runner's fields are sent.
  runner: string;
  model: string;
  allowed_tools: string[];
  command_template: string;
  // Raw JSON textarea backing the fallback config editor for an unknown runner.
  runner_config_text: string;
  env_requirements: string[];
  granted_capabilities: CapabilityDraft[];
  steps: StepDraft[];
  prompt_template: string;
  userdata_template: string;
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  image: "",
  host: "",
  isolation: "",
  network: "open",
  ttl_seconds: "3600",
  cpus: "",
  memory_mb: "",
  pids: "",
  runner: DEFAULT_RUNNER,
  model: "",
  allowed_tools: [],
  command_template: "",
  runner_config_text: "",
  env_requirements: [],
  granted_capabilities: [],
  steps: [],
  prompt_template: "",
  userdata_template: "",
};

/** Monotonic key source for freshly-added step rows (module-local, not state). */
let stepKeySeq = 0;
function nextStepKey(): string {
  stepKeySeq += 1;
  return `s${stepKeySeq}`;
}

/** Monotonic key source for granted-capability rows (module-local, not state). */
let capKeySeq = 0;
function nextCapKey(): string {
  capKeySeq += 1;
  return `c${capKeySeq}`;
}

/** Render a resource number back to its string form (0 and undefined → ""). */
function numToStr(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** Build the drawer's initial draft from an existing playbook (edit mode). The
 * built-in runner config fields are read out of the opaque `runner_config`; the
 * raw JSON fallback mirrors the whole blob so an unknown runner round-trips. */
function draftFromPlaybook(pb: PlaybookRecord): DraftState {
  const rc = pb.runner_config ?? {};
  const model = typeof rc.model === "string" ? rc.model : "";
  const allowed_tools =
    Array.isArray(rc.allowed_tools) &&
    rc.allowed_tools.every((t) => typeof t === "string")
      ? (rc.allowed_tools as string[])
      : [];
  const command_template =
    typeof rc.command_template === "string" ? rc.command_template : "";
  return {
    name: pb.name,
    image: pb.image,
    host: pb.host ?? "",
    isolation: pb.isolation ?? "",
    network: pb.network,
    ttl_seconds: String(pb.ttl_seconds),
    cpus: numToStr(pb.resources.cpus),
    memory_mb: numToStr(pb.resources.memory_mb),
    pids: numToStr(pb.resources.pids),
    runner: pb.runner,
    model,
    allowed_tools,
    command_template,
    runner_config_text:
      Object.keys(rc).length === 0 ? "" : JSON.stringify(rc, null, 2),
    env_requirements: pb.env_requirements,
    granted_capabilities: pb.granted_capabilities.map((c) => ({
      key: nextCapKey(),
      capability_id: c.capability_id,
      config_text:
        c.config === undefined ? "" : JSON.stringify(c.config, null, 2),
    })),
    steps: pb.steps.map((s) => ({ ...s, key: nextStepKey() })),
    prompt_template: pb.prompt_template,
    userdata_template: pb.userdata_template,
  };
}

/**
 * Parse one capability's config textarea. An empty box is valid (no config).
 * Otherwise the text must parse to a JSON object (not an array or primitive).
 * Mirrors the Rule criteria editor's validation. Returns the parsed value (or
 * `undefined` for an empty box) or a human-readable error message.
 */
function parseCapabilityConfig(
  text: string,
):
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Config must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Assemble the opaque `runner_config` for the selected runner from the draft's
 * per-runner fields:
 *   - claude-code: `{ model?, allowed_tools? }`, each omitted when blank/empty so
 *     the runner falls back to its own defaults.
 *   - script: `{ command_template }` (always present, may be empty — the runner
 *     rejects an empty template at dispatch time).
 *   - any other runner: the parsed raw JSON textarea (an empty box → `{}`).
 * Returns the config object, or a human-readable error for an invalid raw JSON
 * fallback so it can gate Save. Only the selected runner's fields are read.
 */
function buildRunnerConfig(
  draft: DraftState,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (draft.runner === CLAUDE_CODE_RUNNER) {
    const config: Record<string, unknown> = {};
    const model = draft.model.trim();
    if (model !== "") config.model = model;
    if (draft.allowed_tools.length > 0) {
      config.allowed_tools = draft.allowed_tools;
    }
    return { ok: true, value: config };
  }
  if (draft.runner === SCRIPT_RUNNER) {
    return { ok: true, value: { command_template: draft.command_template } };
  }
  // Unknown/future runner: the raw JSON fallback must parse to a JSON object.
  const parsed = parseCapabilityConfig(draft.runner_config_text);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value ?? {} };
}

/**
 * Parse a non-negative integer resource field. Empty is valid (omitted). A
 * non-integer or negative value fails so it can gate the Save button.
 */
function parseOptionalInt(text: string): { ok: boolean; value?: number } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  return { ok: true, value: Number(trimmed) };
}

/**
 * Playbooks page: a table of playbooks with a create/edit drawer covering the
 * lease shape (image, network, ttl, resources), the runner picker and its
 * per-runner config (claude-code's model/allowed-tools, the script runner's
 * command template, or a raw JSON fallback for any other runner), the
 * env-requirement tag inputs, an ordered steps editor, and the prompt/userdata
 * templates with a static substitution hint. Delete is gated behind a confirm
 * dialog that fetches `/usage` to warn exactly what the cascade removes (dispatch/
 * run/finding counts + logs), lists any referencing rules that will stop
 * dispatching, disables confirm while dispatches are in flight, and surfaces a
 * racing 409 inline.
 */
export function PlaybooksPage() {
  const styles = useStyles();
  const truncate = useTruncateStyle();
  const isNarrow = useMediaQuery(NARROW_QUERY);

  const [playbooks, setPlaybooks] = useState<PlaybookRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Committed (debounced) client-side search query; "" means no filter.
  const [query, setQuery] = useState("");

  // Filter across all rendered columns (plus runner_config) before sorting, so
  // search and column sorting compose.
  const filteredPlaybooks = useMemo(
    () => filterRows(playbooks, query, playbookSearchValues),
    [playbooks, query],
  );

  const {
    sorted: sortedPlaybooks,
    sortState,
    toggleSort,
  } = useTableSort(filteredPlaybooks, PLAYBOOK_SORT_COLUMNS, LOADED_ORDER_SORT);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<PlaybookRecord | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<PlaybookRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The delete-cascade footprint fetched when the dialog opens. `null` while it
  // loads (or if the fetch failed — the delete is still allowed then, just
  // without the count preview).
  const [deleteUsage, setDeleteUsage] = useState<PlaybookUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  // Known secret NAMES, populated when the env-requirements picker loads. `null`
  // means "not loaded yet" so we never flash a does-not-exist warning early.
  const [secretNames, setSecretNames] = useState<string[] | null>(null);

  // Registered runner ids from GET /api/runners, backing the runner picker.
  // Starts with just the default so the picker is never empty before the fetch
  // resolves; a failed fetch leaves the default in place.
  const [runners, setRunners] = useState<string[]>([DEFAULT_RUNNER]);

  // Saved snippets, split by kind, backing the editor's snippet pickers. Loaded
  // once; a failure is non-fatal — the pickers simply offer nothing and the user
  // can still author templates by hand.
  const [snippets, setSnippets] = useState<SnippetRecord[]>([]);
  const promptSnippets = useMemo(
    () => snippets.filter((s) => s.kind === "prompt"),
    [snippets],
  );
  const userdataSnippets = useMemo(
    () => snippets.filter((s) => s.kind === "userdata"),
    [snippets],
  );
  const stepSnippets = useMemo(
    () => snippets.filter((s) => s.kind === "step"),
    [snippets],
  );

  // The prompt textarea element, so "Insert snippet" can splice a token in AT the
  // caret rather than always appending.
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Guard against a slow load landing after the component unmounts.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Feeds the env-requirements picker AND keeps the page's copy of the known
  // names in sync so the does-not-exist warning tracks the same fetch.
  const loadSecretOptions = useCallback(async () => {
    const names = await getSecretNames();
    if (mounted.current) setSecretNames(names);
    return names.map((value) => ({ value }));
  }, []);

  // Model suggestions come from the account's Anthropic catalog; the picker
  // stays freeform so blank (runner default) and custom ids remain committable.
  const loadModelOptions = useCallback(
    (): Promise<AsyncComboboxOption[]> => getAnthropicModelOptions(),
    [],
  );

  // Image suggestions: the current default_lease_image setting plus its sentinel.
  const loadImageOptions = useCallback(
    (): Promise<AsyncComboboxOption[]> => getImageSuggestions(),
    [],
  );

  // Host suggestions from the server-side wisper catalog (GET /api/wisper/hosts).
  // The picker stays freeform so blank (default host) and hand-typed ids commit;
  // each option's label carries the host's os — the detail users pick hosts by.
  const loadHostOptions = useCallback(
    (): Promise<AsyncComboboxOption[]> => getWisperHostOptions(),
    [],
  );

  // Network + allowed-tools are backed by shipped static lists (no endpoint);
  // both stay freeform so future modes and custom tools still commit.
  const loadNetworkOptions = useCallback(
    async (): Promise<AsyncComboboxOption[]> =>
      NETWORK_MODES.map((value) => ({ value })),
    [],
  );
  const loadToolOptions = useCallback(
    async (): Promise<AsyncComboboxOption[]> =>
      CLAUDE_CODE_TOOLS.map((value) => ({ value })),
    [],
  );

  // Grantable capabilities come from GET /api/capabilities (every module's
  // registered capability ids). The picker stays freeform so a capability not
  // yet registered still commits.
  const loadCapabilityOptions = useCallback(
    (): Promise<AsyncComboboxOption[]> => getCapabilityOptions(),
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await listPlaybooks();
      if (!mounted.current) return;
      setPlaybooks(next);
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

  // Live: silently reload the list when a playbook changes anywhere.
  useLiveRefetch("playbooks", refresh);

  // Load the registered runner ids once. A failure is non-fatal — the picker
  // keeps the default runner and the raw JSON fallback still covers any runner.
  useEffect(() => {
    void listRunners()
      .then((ids) => {
        if (mounted.current) setRunners(ids);
      })
      .catch(() => {
        /* keep the default; the editor still works */
      });
  }, []);

  // Load the saved snippets once for the editor's pickers. A failure is
  // non-fatal — the pickers just come up empty and hand-authored templates still
  // work.
  useEffect(() => {
    void listSnippets()
      .then((all) => {
        if (mounted.current) setSnippets(all);
      })
      .catch(() => {
        /* the editor still works without snippet pickers */
      });
  }, []);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDrawerOpen(true);
  }, []);

  const openEdit = useCallback((pb: PlaybookRecord) => {
    setEditing(pb);
    setDraft(draftFromPlaybook(pb));
    setSaveError(null);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setEditing(null);
  }, []);

  const ttlResult = useMemo(
    () => parseOptionalInt(draft.ttl_seconds),
    [draft.ttl_seconds],
  );
  const ttlValid = ttlResult.ok && ttlResult.value !== undefined && ttlResult.value >= 1;
  const cpusResult = useMemo(() => parseOptionalInt(draft.cpus), [draft.cpus]);
  const memResult = useMemo(() => parseOptionalInt(draft.memory_mb), [draft.memory_mb]);
  const pidsResult = useMemo(() => parseOptionalInt(draft.pids), [draft.pids]);

  // Referenced secret names not (yet) in the store. Only computed once the
  // picker has loaded (secretNames !== null); never blocks saving.
  const unknownEnvNames = useMemo(
    () =>
      secretNames === null
        ? []
        : draft.env_requirements.filter((n) => !secretNames.includes(n)),
    [secretNames, draft.env_requirements],
  );

  // Live validation of each granted-capability config editor, keyed by row so
  // the inline error renders under the right textarea and any failure gates Save.
  const capabilityResults = useMemo(
    () =>
      draft.granted_capabilities.map((c) => ({
        key: c.key,
        result: parseCapabilityConfig(c.config_text),
      })),
    [draft.granted_capabilities],
  );
  const capabilitiesValid = capabilityResults.every((r) => r.result.ok);

  // Assemble/validate the selected runner's config. Only the raw JSON fallback
  // (for an unknown runner) can be invalid; the built-in forms always assemble.
  const runnerConfigResult = useMemo(() => buildRunnerConfig(draft), [draft]);

  // Whether the selected runner has a bespoke config form. Anything else falls
  // back to the raw `runner_config` JSON editor so a new runner is never blocked.
  const isClaudeCodeRunner = draft.runner === CLAUDE_CODE_RUNNER;
  const isScriptRunner = draft.runner === SCRIPT_RUNNER;
  const isKnownRunner = isClaudeCodeRunner || isScriptRunner;

  // The runner picker options: the fetched ids plus the draft's current runner
  // (so an already-saved unknown runner stays selectable), de-duplicated.
  const runnerOptions = useMemo(
    () => Array.from(new Set([...runners, draft.runner])),
    [runners, draft.runner],
  );

  // The userdata value is EITHER inline custom text OR a single whole-value
  // snippet reference; derive which, plus the referenced snippet for its preview.
  const userdataRef = parseSnippetRef(draft.userdata_template);
  const userdataSnippet =
    userdataRef !== null
      ? userdataSnippets.find((s) => s.name === userdataRef)
      : undefined;

  const nameValid = draft.name.trim() !== "";
  const imageValid = draft.image.trim() !== "";
  const resourcesValid = cpusResult.ok && memResult.ok && pidsResult.ok;
  const canSave =
    nameValid &&
    imageValid &&
    ttlValid &&
    resourcesValid &&
    capabilitiesValid &&
    runnerConfigResult.ok &&
    !saving;

  const set = useCallback(
    <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  // Splice a prompt snippet's `{{snippet.<name>}}` token into prompt_template at
  // the caret so users can stack and position them freely; when no live caret is
  // readable (e.g. the textarea was never focused) it falls back to appending.
  const insertPromptSnippet = useCallback((name: string) => {
    const token = promptSnippetToken(name);
    const el = promptRef.current;
    setDraft((prev) => {
      const text = prev.prompt_template;
      if (el && typeof el.selectionStart === "number") {
        const start = el.selectionStart;
        const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
        return {
          ...prev,
          prompt_template: text.slice(0, start) + token + text.slice(end),
        };
      }
      return { ...prev, prompt_template: text + token };
    });
  }, []);

  // Userdata is EITHER inline custom text OR a single whole-value snippet
  // reference. `null` selects Custom (restores inline editing); any other value
  // is the literal `snippet:<name>` reference stored verbatim.
  const onUserdataSource = useCallback((value: string) => {
    setDraft((prev) => {
      if (value === "custom") {
        // Only wipe when leaving a reference; keep any inline text otherwise.
        return parseSnippetRef(prev.userdata_template) === null
          ? prev
          : { ...prev, userdata_template: "" };
      }
      return { ...prev, userdata_template: value };
    });
  }, []);

  const onSave = useCallback(async () => {
    if (!canSave) return;

    const resources: PlaybookResources = {};
    if (cpusResult.value !== undefined) resources.cpus = cpusResult.value;
    if (memResult.value !== undefined) resources.memory_mb = memResult.value;
    if (pidsResult.value !== undefined) resources.pids = pidsResult.value;

    const steps: PlaybookStep[] = draft.steps.map((s) => ({
      phase: s.phase,
      label: s.label,
      command_template: s.command_template,
    }));

    // Each grant carries its capability id plus its parsed config; an empty
    // config box is omitted so the executor falls back to the module's config.
    const granted_capabilities: GrantedCapability[] =
      draft.granted_capabilities.map((c) => {
        const parsed = parseCapabilityConfig(c.config_text);
        const config = parsed.ok ? parsed.value : undefined;
        return config === undefined
          ? { capability_id: c.capability_id }
          : { capability_id: c.capability_id, config };
      });

    // The runner's opaque config is assembled from the selected runner's form
    // (or the raw JSON fallback). canSave already gated on its validity.
    const runner_config = runnerConfigResult.ok ? runnerConfigResult.value : {};
    const payload: NewPlaybook = {
      name: draft.name.trim(),
      image: draft.image.trim(),
      // Blank clears the host back to the configured default (`null`); a value is
      // sent verbatim (v1 resolves it against the catalog at dispatch time).
      host: draft.host.trim() === "" ? null : draft.host.trim(),
      // Blank clears isolation to the wisper server default (`null`); otherwise
      // the chosen level is sent (v1 checks it against the host before leasing).
      isolation: draft.isolation === "" ? null : (draft.isolation as LeaseIsolation),
      ttl_seconds: ttlResult.value as number,
      resources,
      network: draft.network.trim(),
      runner: draft.runner,
      runner_config,
      env_requirements: draft.env_requirements,
      granted_capabilities,
      steps,
      prompt_template: draft.prompt_template,
      userdata_template: draft.userdata_template,
    };

    setSaving(true);
    setSaveError(null);
    try {
      if (editing) await updatePlaybook(editing.id, payload);
      else await createPlaybook(payload);
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
  }, [
    canSave,
    cpusResult,
    memResult,
    pidsResult,
    ttlResult,
    runnerConfigResult,
    draft,
    editing,
    refresh,
  ]);

  const openDelete = useCallback((pb: PlaybookRecord) => {
    setDeleting(pb);
    setDeleteError(null);
    setDeleteUsage(null);
    setUsageLoading(true);
    // Fetch what a delete would cascade so the dialog can warn precisely. A
    // failure is non-fatal — the delete proceeds without the count preview.
    void getPlaybookUsage(pb.id)
      .then((usage) => {
        if (mounted.current) setDeleteUsage(usage);
      })
      .catch(() => {
        /* leave usage null; the generic warning still shows */
      })
      .finally(() => {
        if (mounted.current) setUsageLoading(false);
      });
  }, []);

  const onConfirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deletePlaybook(deleting.id);
      if (!mounted.current) return;
      setDeleting(null);
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      // A 409 means a race left the playbook with in-flight dispatches after we
      // fetched usage. Surface the backend's message inline instead of a raw
      // error so the user knows to wait for those runs to finish.
      if (err instanceof ApiError && err.status === 409) {
        setDeleteError(
          `Can't delete “${deleting.name}” — it now has in-flight dispatches. ` +
            "Wait for those runs to finish, then try again.",
        );
      } else {
        setDeleteError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  }, [deleting, refresh]);

  const addStep = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        { key: nextStepKey(), phase: "pre", label: "", command_template: "" },
      ],
    }));
  }, []);

  const updateStep = useCallback(
    (key: string, patch: Partial<PlaybookStep>) => {
      setDraft((prev) => ({
        ...prev,
        steps: prev.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)),
      }));
    },
    [],
  );

  const removeStep = useCallback((key: string) => {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.filter((s) => s.key !== key),
    }));
  }, []);

  // Reconcile the multi-select against the current grants: retained ids keep
  // their config, freshly-picked ids start with an empty config, dropped ids
  // fall away. Order follows the picker's selection order.
  const onCapabilitiesChange = useCallback((next: string[]) => {
    setDraft((prev) => {
      const existing = new Map(
        prev.granted_capabilities.map((c) => [c.capability_id, c]),
      );
      return {
        ...prev,
        granted_capabilities: next.map(
          (id) =>
            existing.get(id) ?? {
              key: nextCapKey(),
              capability_id: id,
              config_text: "",
            },
        ),
      };
    });
  }, []);

  const updateCapabilityConfig = useCallback(
    (key: string, config_text: string) => {
      setDraft((prev) => ({
        ...prev,
        granted_capabilities: prev.granted_capabilities.map((c) =>
          c.key === key ? { ...c, config_text } : c,
        ),
      }));
    },
    [],
  );

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Playbooks</Title1>
        <Button appearance="primary" onClick={openCreate}>
          New playbook
        </Button>
      </div>

      {error && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}

      {loading ? (
        <Spinner label="Loading playbooks…" />
      ) : playbooks.length === 0 ? (
        <div className={styles.empty}>
          <Text>No playbooks configured.</Text>
        </div>
      ) : (
        <>
        <TableSearch
          onSearch={setQuery}
          placeholder="Search playbooks…"
          label="Search playbooks"
          resultCount={sortedPlaybooks.length}
        />
        {sortedPlaybooks.length === 0 ? (
          <div className={styles.empty}>
            <Text>No playbooks match your search.</Text>
          </div>
        ) : (
        <div className={styles.tableWrap}>
        <Table aria-label="Playbooks">
          <TableHeader>
            <TableRow>
              <SortableHeaderCell columnId="name" sortState={sortState} onSort={toggleSort}>
                Name
              </SortableHeaderCell>
              <SortableHeaderCell columnId="image" sortState={sortState} onSort={toggleSort}>
                Image
              </SortableHeaderCell>
              <SortableHeaderCell columnId="network" sortState={sortState} onSort={toggleSort}>
                Network
              </SortableHeaderCell>
              <SortableHeaderCell columnId="ttl" sortState={sortState} onSort={toggleSort}>
                TTL (s)
              </SortableHeaderCell>
              <SortableHeaderCell columnId="steps" sortState={sortState} onSort={toggleSort}>
                Steps
              </SortableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedPlaybooks.map((pb) => (
              <TableRow key={pb.id}>
                <TableCell className={truncate} title={pb.name}>
                  {pb.name}
                </TableCell>
                <TableCell
                  className={mergeClasses(styles.mono, truncate)}
                  title={pb.image}
                >
                  {pb.image}
                </TableCell>
                <TableCell>{pb.network}</TableCell>
                <TableCell>{pb.ttl_seconds}</TableCell>
                <TableCell>
                  <Badge appearance="tint">{pb.steps.length}</Badge>
                </TableCell>
                <TableCell>
                  <div className={styles.actions}>
                    <Button size="small" onClick={() => openEdit(pb)}>
                      Edit
                    </Button>
                    <Button size="small" onClick={() => openDelete(pb)}>
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
            <DialogTitle>
              {editing ? "Edit playbook" : "New playbook"}
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
                    onChange={(_, d) => set("name", d.value)}
                  />
                </Field>

                <div className={styles.tagInput}>
                  <AsyncCombobox
                    label="Image"
                    aria-label="Image"
                    placeholder="e.g. ghcr.io/acme/runner:latest"
                    hint="Suggests the default_lease_image setting; type any image."
                    value={draft.image}
                    onChange={(v) => set("image", v)}
                    load={loadImageOptions}
                  />
                  {!imageValid && (
                    <Text as="p" className={styles.warn}>
                      Image is required
                    </Text>
                  )}
                </div>

                <AsyncCombobox
                  label="Host"
                  aria-label="Host"
                  placeholder="Default host"
                  hint="Which host runs the lease; blank uses the default. Suggestions show each host's OS."
                  value={draft.host}
                  onChange={(v) => set("host", v)}
                  load={loadHostOptions}
                />

                <Field
                  label="Isolation"
                  hint="Lease isolation level; blank uses the server default (shared). In v1 the host must support the chosen level."
                >
                  <Select
                    aria-label="Isolation"
                    value={draft.isolation}
                    onChange={(_, d) => set("isolation", d.value)}
                  >
                    <option value="">Default (shared)</option>
                    {LEASE_ISOLATION_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className={styles.row}>
                  <div className={styles.rowCell}>
                    <AsyncCombobox
                      label="Network"
                      aria-label="Network"
                      placeholder="open"
                      value={draft.network}
                      onChange={(v) => set("network", v)}
                      load={loadNetworkOptions}
                    />
                  </div>
                  <Field
                    label="TTL (seconds)"
                    required
                    className={styles.rowCell}
                    validationState={ttlValid ? "none" : "error"}
                    validationMessage={
                      ttlValid ? undefined : "A positive integer is required"
                    }
                  >
                    <Input
                      type="number"
                      value={draft.ttl_seconds}
                      onChange={(_, d) => set("ttl_seconds", d.value)}
                    />
                  </Field>
                </div>

                <div className={styles.row}>
                  <Field
                    label="CPUs"
                    className={styles.rowCell}
                    validationState={cpusResult.ok ? "none" : "error"}
                    validationMessage={cpusResult.ok ? undefined : "Must be an integer"}
                  >
                    <Input
                      type="number"
                      value={draft.cpus}
                      onChange={(_, d) => set("cpus", d.value)}
                    />
                  </Field>
                  <Field
                    label="Memory (MB)"
                    className={styles.rowCell}
                    validationState={memResult.ok ? "none" : "error"}
                    validationMessage={memResult.ok ? undefined : "Must be an integer"}
                  >
                    <Input
                      type="number"
                      value={draft.memory_mb}
                      onChange={(_, d) => set("memory_mb", d.value)}
                    />
                  </Field>
                  <Field
                    label="PIDs"
                    className={styles.rowCell}
                    validationState={pidsResult.ok ? "none" : "error"}
                    validationMessage={pidsResult.ok ? undefined : "Must be an integer"}
                  >
                    <Input
                      type="number"
                      value={draft.pids}
                      onChange={(_, d) => set("pids", d.value)}
                    />
                  </Field>
                </div>

                <Field
                  label="Runner"
                  hint="The engine that runs the agent step; its config is below."
                >
                  <Select
                    aria-label="Runner"
                    value={draft.runner}
                    onChange={(_, d) => set("runner", d.value)}
                  >
                    {runnerOptions.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </Select>
                </Field>

                {isClaudeCodeRunner && (
                  <>
                    <AsyncCombobox
                      label="Model"
                      aria-label="Model"
                      placeholder="Blank uses the runner's default model"
                      hint="Blank uses the runner's default model."
                      value={draft.model}
                      onChange={(v) => set("model", v)}
                      load={loadModelOptions}
                    />

                    <AsyncCombobox
                      multiselect
                      label="Allowed tools"
                      aria-label="Allowed tools"
                      placeholder="Pick or type a tool name"
                      hint="Blank grants all tools; type to add a custom tool."
                      value={draft.allowed_tools}
                      onChange={(next) => set("allowed_tools", next)}
                      load={loadToolOptions}
                    />
                  </>
                )}

                {isScriptRunner && (
                  <Field label="Command template" hint={SCRIPT_COMMAND_HINT}>
                    <Textarea
                      aria-label="Command template"
                      className={styles.mono}
                      resize="vertical"
                      rows={4}
                      value={draft.command_template}
                      placeholder="e.g. curl -sf {{payload.url}} > out.txt"
                      onChange={(_, d) => set("command_template", d.value)}
                    />
                  </Field>
                )}

                {!isKnownRunner && (
                  <Field
                    label="Runner config (JSON)"
                    hint="Opaque config for this runner; must be a JSON object."
                    validationState={runnerConfigResult.ok ? "none" : "error"}
                    validationMessage={
                      runnerConfigResult.ok ? undefined : runnerConfigResult.error
                    }
                  >
                    <Textarea
                      aria-label="Runner config"
                      className={styles.mono}
                      resize="vertical"
                      rows={6}
                      value={draft.runner_config_text}
                      placeholder="{}"
                      onChange={(_, d) => set("runner_config_text", d.value)}
                    />
                  </Field>
                )}

                <div className={styles.tagInput}>
                  <AsyncCombobox
                    multiselect
                    label="Env requirements"
                    aria-label="Env requirements"
                    placeholder="Pick or type a secret name"
                    value={draft.env_requirements}
                    onChange={(next) => set("env_requirements", next)}
                    load={loadSecretOptions}
                  />
                  {unknownEnvNames.length > 0 && (
                    <Text as="p" className={styles.warn} role="note">
                      Not yet in the secret store: {unknownEnvNames.join(", ")}. Add{" "}
                      {unknownEnvNames.length > 1 ? "them" : "it"} on the Settings page
                      before a run needs {unknownEnvNames.length > 1 ? "them" : "it"}.
                    </Text>
                  )}
                </div>

                <Field label="Granted capabilities">
                  <div className={styles.capabilities}>
                    <AsyncCombobox
                      multiselect
                      aria-label="Granted capabilities"
                      placeholder="Pick or type a capability id"
                      hint="Capabilities from installed modules; type to add a custom id."
                      value={draft.granted_capabilities.map(
                        (c) => c.capability_id,
                      )}
                      onChange={onCapabilitiesChange}
                      load={loadCapabilityOptions}
                    />
                    {draft.granted_capabilities.map((c) => {
                      const res = capabilityResults.find(
                        (r) => r.key === c.key,
                      )?.result;
                      const invalid = res && !res.ok;
                      return (
                        <Field
                          key={c.key}
                          className={styles.capabilityConfig}
                          label={`${c.capability_id} config (JSON)`}
                          validationState={invalid ? "error" : "none"}
                          validationMessage={invalid ? res.error : undefined}
                        >
                          <Textarea
                            aria-label={`${c.capability_id} config`}
                            className={styles.mono}
                            resize="vertical"
                            rows={4}
                            value={c.config_text}
                            placeholder="{}"
                            onChange={(_, d) =>
                              updateCapabilityConfig(c.key, d.value)
                            }
                          />
                        </Field>
                      );
                    })}
                  </div>
                </Field>

                <Field label="Steps">
                  <div className={styles.steps}>
                    {draft.steps.length === 0 && (
                      <Text>No steps. Add a pre or collect step.</Text>
                    )}
                    {draft.steps.map((s, i) => {
                      // A step command is EITHER inline custom text OR a whole
                      // step-snippet reference (`snippet:<name>`), chosen per row.
                      const stepRef = parseSnippetRef(s.command_template);
                      const stepSnippet =
                        stepRef !== null
                          ? stepSnippets.find((sn) => sn.name === stepRef)
                          : undefined;
                      const stepSourceValue =
                        stepRef !== null ? `snippet:${stepRef}` : "custom";
                      return (
                      <div key={s.key} className={styles.stepRow}>
                        <Field
                          label="Phase"
                          className={styles.stepPhase}
                        >
                          <Select
                            aria-label={`Step ${i + 1} phase`}
                            value={s.phase}
                            onChange={(_, d) =>
                              updateStep(s.key, {
                                phase: d.value as PlaybookStepPhase,
                              })
                            }
                          >
                            <option value="pre">pre</option>
                            <option value="collect">collect</option>
                          </Select>
                        </Field>
                        <Field label="Label" className={styles.stepLabel}>
                          <Input
                            aria-label={`Step ${i + 1} label`}
                            value={s.label}
                            onChange={(_, d) =>
                              updateStep(s.key, { label: d.value })
                            }
                          />
                        </Field>
                        <Field label="Source" className={styles.stepSource}>
                          <Select
                            aria-label={`Step ${i + 1} command source`}
                            value={stepSourceValue}
                            onChange={(_, d) =>
                              updateStep(s.key, {
                                command_template:
                                  d.value === "custom" ? "" : d.value,
                              })
                            }
                          >
                            <option value="custom">Custom</option>
                            {/* Keep a dangling reference selectable even if its
                                snippet was deleted/renamed, so it round-trips. */}
                            {stepRef !== null && stepSnippet === undefined && (
                              <option value={`snippet:${stepRef}`}>
                                {stepRef} (missing)
                              </option>
                            )}
                            {stepSnippets.map((sn) => (
                              <option key={sn.id} value={`snippet:${sn.name}`}>
                                {sn.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Command" className={styles.stepCommand}>
                          {stepRef !== null ? (
                            <>
                              <Textarea
                                aria-label={`Step ${i + 1} command`}
                                className={styles.mono}
                                readOnly
                                resize="vertical"
                                rows={3}
                                value={stepSnippet?.content ?? ""}
                              />
                              <Text as="p" className={styles.snippetPreviewHint}>
                                Read-only preview of snippet “{stepRef}”. Edit it on
                                the Snippets page.
                              </Text>
                            </>
                          ) : (
                            <Input
                              aria-label={`Step ${i + 1} command`}
                              className={styles.mono}
                              value={s.command_template}
                              onChange={(_, d) =>
                                updateStep(s.key, { command_template: d.value })
                              }
                            />
                          )}
                        </Field>
                        <Button
                          size="small"
                          aria-label={`Remove step ${i + 1}`}
                          onClick={() => removeStep(s.key)}
                        >
                          Remove
                        </Button>
                      </div>
                      );
                    })}
                    <div>
                      <Button size="small" onClick={addStep}>
                        Add step
                      </Button>
                    </div>
                  </div>
                </Field>

                <div>
                  <div className={styles.fieldWithAction}>
                    <Label weight="semibold" htmlFor="pb-prompt-template">
                      {isScriptRunner
                        ? "Prompt template (optional)"
                        : "Prompt template"}
                    </Label>
                    {/* Stackable prompt snippets: each pick splices a
                        {{snippet.<name>}} token in at the caret. `inline`
                        keeps the MenuPopover in the dialog DOM instead of
                        portaling it to <body> — a portaled popup escapes the
                        modal Dialog's focus trap, which treats the interaction
                        leaving its surface as a dismissal and blanks the
                        dialog (see task #379). */}
                    <Menu inline>
                      <MenuTrigger disableButtonEnhancement>
                        <Button
                          size="small"
                          disabled={promptSnippets.length === 0}
                        >
                          Insert snippet
                        </Button>
                      </MenuTrigger>
                      <MenuPopover className={styles.snippetMenuPopover}>
                        <MenuList>
                          {promptSnippets.map((sn) => (
                            <MenuItem
                              key={sn.id}
                              onClick={() => insertPromptSnippet(sn.name)}
                            >
                              {sn.name}
                            </MenuItem>
                          ))}
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </div>
                  <Field
                    hint={
                      isScriptRunner
                        ? "Optional for the script runner — it runs the command, not a prompt."
                        : undefined
                    }
                  >
                    <Textarea
                      ref={promptRef}
                      id="pb-prompt-template"
                      className={styles.mono}
                      resize="vertical"
                      rows={8}
                      value={draft.prompt_template}
                      onChange={(_, d) => set("prompt_template", d.value)}
                    />
                  </Field>
                </div>

                <Field
                  label="Userdata source"
                  hint="Custom inline value, or one saved userdata snippet referenced whole."
                >
                  <Select
                    aria-label="Userdata source"
                    value={
                      userdataRef !== null ? `snippet:${userdataRef}` : "custom"
                    }
                    onChange={(_, d) => onUserdataSource(d.value)}
                  >
                    <option value="custom">Custom</option>
                    {/* Keep a dangling reference selectable even if its snippet
                        was deleted/renamed, so an existing playbook round-trips. */}
                    {userdataRef !== null && userdataSnippet === undefined && (
                      <option value={`snippet:${userdataRef}`}>
                        {userdataRef} (missing)
                      </option>
                    )}
                    {userdataSnippets.map((sn) => (
                      <option key={sn.id} value={`snippet:${sn.name}`}>
                        {sn.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Userdata template">
                  {userdataRef !== null ? (
                    <>
                      <Textarea
                        aria-label="Userdata template"
                        className={styles.mono}
                        readOnly
                        resize="vertical"
                        rows={8}
                        value={userdataSnippet?.content ?? ""}
                      />
                      <Text as="p" className={styles.snippetPreviewHint}>
                        Read-only preview of snippet “{userdataRef}”. Edit it on the
                        Snippets page.
                      </Text>
                    </>
                  ) : (
                    <Textarea
                      aria-label="Userdata template"
                      className={styles.mono}
                      resize="vertical"
                      rows={8}
                      value={draft.userdata_template}
                      onChange={(_, d) => set("userdata_template", d.value)}
                    />
                  )}
                </Field>

                <Text as="pre" className={styles.hint}>
                  {SUBSTITUTION_HINT}
                </Text>
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
            <DialogTitle>Delete playbook</DialogTitle>
            <DialogContent className={styles.deleteBody}>
              {deleteError ? (
                <Text role="alert" className={styles.error}>
                  {deleteError}
                </Text>
              ) : (
                deleting && (
                  <>
                    {usageLoading ? (
                      <Spinner
                        size="tiny"
                        label="Checking what this will delete…"
                      />
                    ) : deleteUsage ? (
                      <Text as="p">
                        Permanently deletes playbook “{deleting.name}”{" "}
                        <strong>and its run history</strong>:{" "}
                        {cascadeSummary(deleteUsage)} (and their logs). This cannot
                        be undone.
                      </Text>
                    ) : (
                      <Text as="p">
                        Permanently deletes playbook “{deleting.name}” and its run
                        history (dispatches, runs, findings, and their logs). This
                        cannot be undone.
                      </Text>
                    )}

                    {deleteUsage && deleteUsage.referencing_rules.length > 0 && (
                      <div role="note">
                        <Text as="p">
                          {deleteUsage.referencing_rules.length === 1
                            ? "This rule references this playbook and will stop dispatching it:"
                            : "These rules reference this playbook and will stop dispatching it:"}
                        </Text>
                        <ul className={styles.deleteRules}>
                          {deleteUsage.referencing_rules.map((r) => (
                            <li key={r.id}>{r.name}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {deleteUsage && deleteUsage.in_flight > 0 && (
                      <Text as="p" className={styles.warn} role="alert">
                        Can't delete yet: {deleteUsage.in_flight}{" "}
                        {plural(
                          deleteUsage.in_flight,
                          "dispatch is",
                          "dispatches are",
                        )}{" "}
                        still in flight. Wait for{" "}
                        {deleteUsage.in_flight === 1 ? "it" : "them"} to finish,
                        then delete.
                      </Text>
                    )}
                  </>
                )
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={deleteBusy}
                onClick={() => setDeleting(null)}
              >
                {deleteError ? "Close" : "Cancel"}
              </Button>
              {!deleteError && (
                <Button
                  appearance="primary"
                  disabled={
                    deleteBusy ||
                    usageLoading ||
                    (deleteUsage?.in_flight ?? 0) > 0
                  }
                  onClick={() => void onConfirmDelete()}
                >
                  {deleteBusy ? "Deleting…" : "Delete playbook + history"}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}

