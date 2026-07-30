/**
 * The Azure DevOps `ado.get_work_item` capability — a bounded, READ-ONLY data
 * operation a playbook may be granted. Given the module's opaque `config` and the
 * `subjectRef` of the event being acted on (the work-item id, as a string), it
 * loads the item's fields + description and its most recent comments, and renders
 * a clean plaintext block for the agent's prompt.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) nothing here knows what the item
 * *means*: it reads generic fields and formats them: any intent lives in the data
 * and the user's prompt, never in a code branch. Per the READ-ONLY convention the
 * only ADO calls are reads (see {@link import("./client").ADOClient}).
 *
 * DEGRADE, NEVER BREAK. A capability feeds context into a dispatch; a fetch
 * failure must not abort the dispatch. Every error path returns a
 * {@link CapabilityResult} whose content is a short parenthetical note, so a
 * broken read simply contributes an explanatory line instead of throwing.
 */

import type {
  Capability,
  CapabilityInvocationContext,
  CapabilityResult,
} from "../registry";

import {
  ADOClient,
  type ADOClientOptions,
  type ADOComment,
  type ADOIdentityRef,
  type ADOWorkItem,
  type ADOWorkItemRelation,
} from "./client";
import type { SecretResolver } from "./poller";
import { buildWatchedWiql, type WatchedWiqlConfig } from "./wiql";

/** The stable capability id, as required by the task. */
export const ADO_GET_WORK_ITEM_CAPABILITY_ID = "ado.get_work_item";

/** The most recent comments included in the rendered block. */
export const ADO_CAPABILITY_MAX_COMMENTS = 20;

/**
 * The read surface this capability needs from an ADO client; {@link ADOClient}
 * satisfies it. Kept separate from the poller's client interface because this
 * capability additionally reads the comment thread.
 */
export interface AdoCapabilityReadClient {
  getWorkItems(ids: number[]): Promise<ADOWorkItem[]>;
  getWorkItemComments(id: number): Promise<ADOComment[]>;
}

/** Builds a read client from resolved connection options; injectable for tests. */
export type AdoCapabilityClientFactory = (
  opts: ADOClientOptions
) => AdoCapabilityReadClient;

/**
 * Data-only capability config, a subset of the module config. Every field is
 * optional so a half-filled config degrades to an error note rather than
 * throwing at the type layer.
 */
export interface AdoCapabilityConfig {
  /** Azure DevOps organization. */
  org?: string;
  /** Azure DevOps project. */
  project?: string;
  /** Name of the secret (in the secret store) holding the PAT. */
  pat_secret_ref?: string;
  /** Overrides the ADO base URL (tests point this at a mock host). */
  base_url?: string;
}

/** Injected collaborators for {@link createGetWorkItemCapability}. */
export interface GetWorkItemCapabilityDeps {
  /** Resolves the PAT from its `pat_secret_ref`. Required. */
  resolveSecret: SecretResolver;
  /** Builds the ADO read client; defaults to constructing an {@link ADOClient}. */
  clientFactory?: AdoCapabilityClientFactory;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a string-typed field, defaulting to "" when absent or non-string. */
function strField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Reduce an `AssignedTo` / `createdBy` identity value to a single display
 * string. The API sends an identity ref when a work item is expanded (else a
 * bare string); an unset value yields "".
 */
function identityLabel(raw: ADOIdentityRef | string | undefined): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return raw.displayName ?? raw.uniqueName ?? raw.id ?? "";
}

/** Split the `System.Tags` field ("a; b; c") into a trimmed, non-empty array. */
function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Strip HTML to readable plaintext with a simple, dependency-free tag-strip:
 * block-level tags become newlines, list items gain a "- " bullet, remaining
 * tags are removed, and the handful of common entities are decoded. Whitespace
 * is then collapsed so the result is a compact block. This is intentionally NOT
 * a full HTML parser — ADO descriptions/comments are lightly-formatted HTML.
 */
export function stripHtml(html: string): string {
  if (!html) return "";
  const withBreaks = html
    // Line/paragraph breaks → newlines.
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|tr|ul|ol|blockquote)\s*>/gi, "\n")
    // List items → a bulleted line.
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    // Every other tag is dropped.
    .replace(/<[^>]+>/g, "");
  const decoded = withBreaks
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&apos;/gi, "'")
    // Ampersand last so a literal "&amp;lt;" doesn't double-decode.
    .replace(/&amp;/gi, "&");
  return decoded
    // Trim trailing spaces on each line.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    // Collapse 3+ blank lines to at most one.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A flattened, domain-neutral view of the fields this capability renders. */
interface WorkItemView {
  id: number;
  title: string;
  work_item_type: string;
  state: string;
  assignee: string;
  area_path: string;
  tags: string[];
  description: string;
}

/** Flatten a raw {@link ADOWorkItem} into the fields the block renders. */
function toView(item: ADOWorkItem): WorkItemView {
  const f = item.fields;
  return {
    id: item.id,
    title: strField(f["System.Title"]),
    work_item_type: strField(f["System.WorkItemType"]),
    state: strField(f["System.State"]),
    assignee: identityLabel(f["System.AssignedTo"]),
    area_path: strField(f["System.AreaPath"]),
    tags: parseTags(f["System.Tags"]),
    description: strField(f["System.Description"]),
  };
}

/** Order comments newest-first by `createdDate`, then cap to the most recent N. */
function recentCommentsNewestFirst(comments: ADOComment[]): ADOComment[] {
  // A stable copy sorted descending; unparseable dates sort as -Infinity so they
  // sink below dated comments rather than reordering unpredictably.
  const ts = (c: ADOComment): number => {
    const parsed = Date.parse(c.createdDate);
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...comments]
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, ADO_CAPABILITY_MAX_COMMENTS);
}

/** Render the flattened view + ordered comments into the plaintext block. */
function renderBlock(view: WorkItemView, comments: ADOComment[]): string {
  const lines: string[] = [
    `Title: ${view.title || "(none)"}`,
    `Type: ${view.work_item_type || "(none)"}`,
    `State: ${view.state || "(none)"}`,
    `Assignee: ${view.assignee || "(unassigned)"}`,
    `Area: ${view.area_path || "(none)"}`,
    `Tags: ${view.tags.length > 0 ? view.tags.join(", ") : "(none)"}`,
    "",
    "Description:",
    stripHtml(view.description) || "(none)",
    "",
    "Comments (newest first):",
  ];

  if (comments.length === 0) {
    lines.push("(none)");
  } else {
    const rendered = comments.map((c) => {
      const who = identityLabel(c.createdBy) || "(unknown)";
      const when = c.createdDate || "(no date)";
      const body = stripHtml(c.text) || "(empty)";
      return `[${when}] ${who}:\n${body}`;
    });
    // Blank line between comments keeps the block readable.
    lines.push(rendered.join("\n\n"));
  }

  return lines.join("\n");
}

/**
 * Build the `ado.get_work_item` capability. Register the returned object on the
 * ado module's `capabilities` array; the registry then exposes it by id.
 *
 * `fetch(config, subjectRef)` resolves the PAT from `config.pat_secret_ref`,
 * builds a read client, loads the work item and its comments, and renders a
 * plaintext block. ANY failure degrades to a labelled note — it never throws.
 */
export function createGetWorkItemCapability(
  deps: GetWorkItemCapabilityDeps
): Capability {
  const { resolveSecret } = deps;
  const clientFactory: AdoCapabilityClientFactory =
    deps.clientFactory ?? ((opts) => new ADOClient(opts));

  async function fetch(
    config: unknown,
    subjectRef: string
  ): Promise<CapabilityResult> {
    const label = `Work item ${subjectRef}`;
    try {
      const id = Number(subjectRef);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`invalid work-item ref "${subjectRef}"`);
      }

      const cfg = (config ?? {}) as AdoCapabilityConfig;
      if (!cfg.org || !cfg.project) {
        throw new Error("ADO module is not configured (org/project missing)");
      }

      const pat = await resolveSecret(cfg.pat_secret_ref ?? "");
      if (!pat) {
        throw new Error(
          `ADO PAT secret unavailable for ref "${cfg.pat_secret_ref ?? ""}"`
        );
      }

      const client = clientFactory({
        org: cfg.org,
        project: cfg.project,
        pat,
        baseUrl: cfg.base_url,
      });

      const items = await client.getWorkItems([id]);
      const item = items[0];
      if (!item) {
        throw new Error(`work item ${id} not found`);
      }
      const comments = await client.getWorkItemComments(id);

      const content = renderBlock(
        toView(item),
        recentCommentsNewestFirst(comments)
      );
      return { label, content };
    } catch (err) {
      return {
        label,
        content: `(capability ${ADO_GET_WORK_ITEM_CAPABILITY_ID} failed: ${errorMessage(
          err
        )})`,
      };
    }
  }

  return { id: ADO_GET_WORK_ITEM_CAPABILITY_ID, fetch };
}

/* -------------------------------------------------------------------------- *
 * Board / sprint capabilities
 *
 * Two further READ-ONLY capabilities that share one code path: run the extended
 * WIQL builder, batch-fetch the matching items, and render a plaintext block.
 * `ado.sprint_rollup` is built on the very same query pipeline as
 * `ado.query_work_items` — it just summarises the returned items instead of
 * tabulating them. Like `ado.get_work_item`, both DEGRADE, NEVER BREAK: any
 * failure yields a labelled parenthetical note rather than throwing into a run,
 * and neither issues anything but reads.
 * -------------------------------------------------------------------------- */

/** The stable capability ids, as required by the task. */
export const ADO_QUERY_WORK_ITEMS_CAPABILITY_ID = "ado.query_work_items";
export const ADO_SPRINT_ROLLUP_CAPABILITY_ID = "ado.sprint_rollup";

/** Default and hard-max result caps for {@link createQueryWorkItemsCapability}. */
export const ADO_QUERY_DEFAULT_TOP = 100;
export const ADO_QUERY_MAX_TOP = 500;

/** Default "stale" threshold, in days, for the sprint at-risk list. */
export const ADO_SPRINT_DEFAULT_STALE_DAYS = 5;

/**
 * The state values `ado.sprint_rollup` treats as terminal by default — i.e. the
 * items it EXCLUDES to arrive at the "open" set, and which never count as
 * at-risk. These are ADO workflow-state strings (data, overridable via config),
 * not domain concepts branched on in code. Override with `terminal_states`.
 */
export const ADO_SPRINT_DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Done",
  "Resolved",
  "Removed",
  "Completed",
];

/**
 * The state values `ado.sprint_rollup` surfaces as a short "in review" list by
 * default. Again a plain, overridable data list (via `review_states`), matched
 * against the `System.State` field — no code path branches on its meaning.
 */
export const ADO_SPRINT_DEFAULT_REVIEW_STATES = ["In Review", "Code Review"];

/** Milliseconds in a day, for the sprint at-risk staleness comparison. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The read surface the board capabilities need: run a WIQL query for ids, then
 * batch-fetch those items. {@link ADOClient} satisfies it.
 */
export interface AdoBoardReadClient {
  runWiql(query: string): Promise<number[]>;
  getWorkItems(ids: number[]): Promise<ADOWorkItem[]>;
}

/** Builds a board read client from resolved connection options; injectable for tests. */
export type AdoBoardClientFactory = (opts: ADOClientOptions) => AdoBoardReadClient;

/**
 * Config for {@link createQueryWorkItemsCapability}: the connection fields (which
 * mirror the ado module config, so a grant may inherit them) plus a
 * {@link WatchedWiqlConfig}-shaped filter and a `top` cap. Every field is
 * optional so a half-filled config degrades rather than throwing at the type
 * layer; `assignee_mode` defaults to `any` when omitted.
 */
export interface AdoQueryWorkItemsConfig
  extends AdoCapabilityConfig,
    Partial<WatchedWiqlConfig> {
  /** Cap on returned rows; defaults to {@link ADO_QUERY_DEFAULT_TOP}, hard-max {@link ADO_QUERY_MAX_TOP}. */
  top?: number;
}

/**
 * Config for {@link createSprintRollupCapability}: connection fields plus the
 * team + area to roll up. `current_for_team` scopes `@CurrentIteration` to a
 * team's sprint; `area_path` (optional) narrows to one board. The terminal /
 * review state lists and `stale_days` are overridable data with sane defaults.
 */
export interface AdoSprintRollupConfig extends AdoCapabilityConfig {
  /** Area path to scope the rollup to; omitted → the whole project. */
  area_path?: string;
  /** `<Project>\<Team>` whose current sprint to roll up; omitted → plain `@CurrentIteration`. */
  current_for_team?: string;
  /** Days without a change before an open item is "at risk"; default {@link ADO_SPRINT_DEFAULT_STALE_DAYS}. */
  stale_days?: number;
  /** States treated as terminal (excluded from the open set); default {@link ADO_SPRINT_DEFAULT_TERMINAL_STATES}. */
  terminal_states?: string[];
  /** States surfaced in the "in review" list; default {@link ADO_SPRINT_DEFAULT_REVIEW_STATES}. */
  review_states?: string[];
}

/** Injected collaborators for the board capabilities. */
export interface AdoBoardCapabilitiesDeps {
  /** Resolves the PAT from its `pat_secret_ref`. Required. */
  resolveSecret: SecretResolver;
  /** Builds the board read client; defaults to constructing an {@link ADOClient}. */
  clientFactory?: AdoBoardClientFactory;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
}

/** A flattened, domain-neutral row rendered by the board capabilities. */
interface WorkItemRow {
  id: number;
  work_item_type: string;
  title: string;
  state: string;
  assignee: string;
  area_path: string;
  changed: string;
}

/** Flatten a raw {@link ADOWorkItem} into a {@link WorkItemRow}. */
function toRow(item: ADOWorkItem): WorkItemRow {
  const f = item.fields;
  return {
    id: item.id,
    work_item_type: strField(f["System.WorkItemType"]),
    title: strField(f["System.Title"]),
    state: strField(f["System.State"]),
    assignee: identityLabel(f["System.AssignedTo"]),
    area_path: strField(f["System.AreaPath"]),
    changed: strField(f["System.ChangedDate"]),
  };
}

/** Clamp a requested `top` into `[1, ADO_QUERY_MAX_TOP]`, defaulting when unset. */
function clampTop(raw: unknown): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(raw)
      : ADO_QUERY_DEFAULT_TOP;
  if (n < 1) return 1;
  if (n > ADO_QUERY_MAX_TOP) return ADO_QUERY_MAX_TOP;
  return n;
}

/**
 * Assemble the {@link WatchedWiqlConfig} for a query config, defaulting
 * `assignee_mode` to `any` so an unset assignee filter simply matches everyone.
 */
function toWatchedConfig(cfg: AdoQueryWorkItemsConfig): WatchedWiqlConfig {
  return {
    assignee_mode: cfg.assignee_mode ?? "any",
    people: cfg.people,
    work_item_types: cfg.work_item_types,
    states: cfg.states,
    state_mode: cfg.state_mode,
    area_paths: cfg.area_paths,
    iteration: cfg.iteration,
    tags: cfg.tags,
  };
}

/**
 * The shared query pipeline both board capabilities run: build the WIQL, fetch
 * ids, cap to `top`, then batch-fetch and flatten the items into rows.
 */
async function loadRows(
  client: AdoBoardReadClient,
  cfg: AdoQueryWorkItemsConfig
): Promise<WorkItemRow[]> {
  const query = buildWatchedWiql(toWatchedConfig(cfg));
  const ids = await client.runWiql(query);
  const capped = ids.slice(0, clampTop(cfg.top));
  if (capped.length === 0) return [];
  const items = await client.getWorkItems(capped);
  return items.map(toRow);
}

/** Render the rows into the labelled `id | type | title | state | assignee | area | changed` table. */
function renderTable(rows: WorkItemRow[]): string {
  const header = "id | type | title | state | assignee | area | changed";
  const body = rows.map((r) =>
    [
      r.id,
      r.work_item_type || "-",
      r.title || "-",
      r.state || "-",
      r.assignee || "(unassigned)",
      r.area_path || "-",
      r.changed || "-",
    ].join(" | ")
  );
  return [header, ...body].join("\n");
}

/**
 * Build the `ado.query_work_items` capability: run the configured watched-query
 * filter (capped at `top`) and render a bounded, labelled item table. Read-only;
 * any failure degrades to a parenthetical note.
 */
export function createQueryWorkItemsCapability(
  deps: AdoBoardCapabilitiesDeps
): Capability {
  const { resolveSecret } = deps;
  const clientFactory: AdoBoardClientFactory =
    deps.clientFactory ?? ((opts) => new ADOClient(opts));

  async function connect(cfg: AdoCapabilityConfig): Promise<AdoBoardReadClient> {
    if (!cfg.org || !cfg.project) {
      throw new Error("ADO module is not configured (org/project missing)");
    }
    const pat = await resolveSecret(cfg.pat_secret_ref ?? "");
    if (!pat) {
      throw new Error(
        `ADO PAT secret unavailable for ref "${cfg.pat_secret_ref ?? ""}"`
      );
    }
    return clientFactory({
      org: cfg.org,
      project: cfg.project,
      pat,
      baseUrl: cfg.base_url,
    });
  }

  async function fetch(config: unknown): Promise<CapabilityResult> {
    try {
      const cfg = (config ?? {}) as AdoQueryWorkItemsConfig;
      const client = await connect(cfg);
      const rows = await loadRows(client, cfg);
      return {
        label: `Work items (${rows.length})`,
        content: rows.length ? renderTable(rows) : "(no matching work items)",
      };
    } catch (err) {
      return {
        label: "Work items",
        content: `(capability ${ADO_QUERY_WORK_ITEMS_CAPABILITY_ID} failed: ${errorMessage(
          err
        )})`,
      };
    }
  }

  return { id: ADO_QUERY_WORK_ITEMS_CAPABILITY_ID, fetch };
}

/** Count occurrences keyed by `key(row)`, returned as `[value, count]` sorted by count desc then value asc. */
function countBy(
  rows: WorkItemRow[],
  key: (r: WorkItemRow) => string
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) || "(none)";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
}

/** Render one at-risk/unassigned/in-review list section into lines. */
function renderList(title: string, rows: WorkItemRow[]): string[] {
  const lines = [`${title} (${rows.length}):`];
  if (rows.length === 0) {
    lines.push("- (none)");
  } else {
    for (const r of rows) {
      lines.push(
        `- #${r.id} ${r.title || "(untitled)"} (${r.state || "(no state)"}, ` +
          `assignee ${r.assignee || "(unassigned)"}, changed ${
            r.changed || "(unknown)"
          })`
      );
    }
  }
  return lines;
}

/**
 * Build the `ado.sprint_rollup` capability. Runs the same query pipeline as
 * `ado.query_work_items` over the team's current-sprint OPEN items (everything
 * but the terminal states), then renders a labelled summary: counts by state and
 * by type, plus short at-risk / unassigned / in-review lists. Read-only and
 * error-degrading.
 */
export function createSprintRollupCapability(
  deps: AdoBoardCapabilitiesDeps
): Capability {
  const { resolveSecret } = deps;
  const clientFactory: AdoBoardClientFactory =
    deps.clientFactory ?? ((opts) => new ADOClient(opts));
  const now = deps.now ?? Date.now;

  async function connect(cfg: AdoCapabilityConfig): Promise<AdoBoardReadClient> {
    if (!cfg.org || !cfg.project) {
      throw new Error("ADO module is not configured (org/project missing)");
    }
    const pat = await resolveSecret(cfg.pat_secret_ref ?? "");
    if (!pat) {
      throw new Error(
        `ADO PAT secret unavailable for ref "${cfg.pat_secret_ref ?? ""}"`
      );
    }
    return clientFactory({
      org: cfg.org,
      project: cfg.project,
      pat,
      baseUrl: cfg.base_url,
    });
  }

  async function fetch(config: unknown): Promise<CapabilityResult> {
    const label = "Sprint rollup";
    try {
      const cfg = (config ?? {}) as AdoSprintRollupConfig;
      const client = await connect(cfg);

      const terminalStates =
        cfg.terminal_states?.length
          ? cfg.terminal_states
          : ADO_SPRINT_DEFAULT_TERMINAL_STATES;
      const reviewStates =
        cfg.review_states?.length
          ? cfg.review_states
          : ADO_SPRINT_DEFAULT_REVIEW_STATES;
      const staleDays =
        typeof cfg.stale_days === "number" && cfg.stale_days > 0
          ? cfg.stale_days
          : ADO_SPRINT_DEFAULT_STALE_DAYS;

      // Build on ado.query_work_items: same pipeline, current-sprint open items.
      const queryCfg: AdoQueryWorkItemsConfig = {
        org: cfg.org,
        project: cfg.project,
        pat_secret_ref: cfg.pat_secret_ref,
        base_url: cfg.base_url,
        assignee_mode: "any",
        area_paths: cfg.area_path ? [cfg.area_path] : undefined,
        iteration: cfg.current_for_team
          ? { current_for_team: cfg.current_for_team }
          : "current",
        states: terminalStates,
        state_mode: "exclude",
        top: ADO_QUERY_MAX_TOP,
      };
      const rows = await loadRows(client, queryCfg);

      if (rows.length === 0) {
        return { label, content: "(no open items in the current sprint)" };
      }

      const terminalSet = new Set(terminalStates);
      const reviewSet = new Set(reviewStates);
      const staleBefore = now() - staleDays * MS_PER_DAY;

      const atRisk = rows.filter((r) => {
        if (terminalSet.has(r.state)) return false;
        const ts = Date.parse(r.changed);
        return Number.isFinite(ts) && ts < staleBefore;
      });
      const unassigned = rows.filter((r) => !r.assignee);
      const inReview = rows.filter((r) => reviewSet.has(r.state));

      const lines: string[] = [
        `Open items: ${rows.length}`,
        "",
        "By state:",
        ...countBy(rows, (r) => r.state).map(([s, n]) => `- ${s}: ${n}`),
        "",
        "By type:",
        ...countBy(rows, (r) => r.work_item_type).map(([t, n]) => `- ${t}: ${n}`),
        "",
        ...renderList(`At-risk (no change in ${staleDays}+ days)`, atRisk),
        "",
        ...renderList("Unassigned", unassigned),
        "",
        ...renderList("In review", inReview),
      ];

      return { label, content: lines.join("\n") };
    } catch (err) {
      return {
        label,
        content: `(capability ${ADO_SPRINT_ROLLUP_CAPABILITY_ID} failed: ${errorMessage(
          err
        )})`,
      };
    }
  }

  return { id: ADO_SPRINT_ROLLUP_CAPABILITY_ID, fetch };
}

/* -------------------------------------------------------------------------- *
 * Work-item link traversal capability
 *
 * `ado.get_work_item_links` is a THIRD, separately-grantable READ-ONLY
 * capability: given the subject work item it renders its hierarchy (ancestors to
 * the root, with descriptions), its children + related items (compact one-line
 * rows, capped), and pointers to its attachments (never their content). Like the
 * others it DEGRADES, NEVER BREAKS and issues only reads. It also keeps a hard
 * SIZE CEILING on the rendered block: the whole prompt rides a single 32767-char
 * env var on Windows leases (see the runDispatch prompt-too-large guard), so this
 * block must never grow without bound — it truncates children/related first, then
 * attachments, keeping the valuable ancestor context last, always with a visible
 * marker.
 * -------------------------------------------------------------------------- */

/** The stable capability id, as required by the task. */
export const ADO_GET_WORK_ITEM_LINKS_CAPABILITY_ID = "ado.get_work_item_links";

/** Default ceiling, in characters, on the whole rendered links block. */
export const ADO_LINKS_DEFAULT_MAX_CHARS = 8000;
/**
 * Absolute upper bound on the configurable block ceiling, well under the Windows
 * 32767-char env-var limit (and the executor's ~30000 prompt guard) so this one
 * block can never, by itself, approach the prompt-too-large threshold.
 */
export const MAX_LINKS_BLOCK_HARD_CAP = 20000;
/** Defensive default cap on how far up the parent chain to walk. */
export const ADO_LINKS_DEFAULT_MAX_DEPTH = 10;
/** Default cap on rows rendered per children/related group. */
export const ADO_LINKS_DEFAULT_GROUP_CAP = 25;
/** Default env-var name whose presence in the lease gates the attachment fetch hint. */
export const ADO_LINKS_DEFAULT_PAT_ENV_VAR = "ADO_PAT";

/**
 * The ADO link-type keys this capability matches. These are DATA — API string
 * constants — not domain concepts: no code path branches on what a "parent" or
 * a "related" link *means*, only on the wire key.
 */
const REL_PARENT = "System.LinkTypes.Hierarchy-Reverse";
const REL_CHILD = "System.LinkTypes.Hierarchy-Forward";
const REL_RELATED = "System.LinkTypes.Related";
const REL_ATTACHMENT = "AttachedFile";

/** Marker appended wherever the size ceiling forces content to be dropped. */
const TRUNCATION_MARKER = "...truncated (size limit)";

/** The read surface this capability needs; {@link ADOClient} satisfies it. */
export interface AdoLinksReadClient {
  getWorkItems(ids: number[]): Promise<ADOWorkItem[]>;
}

/** Builds a links read client from resolved connection options; injectable for tests. */
export type AdoLinksClientFactory = (opts: ADOClientOptions) => AdoLinksReadClient;

/**
 * Config for {@link createGetWorkItemLinksCapability}: the shared connection
 * fields plus the size/shape knobs. Every field is optional so a half-filled
 * config degrades rather than throwing at the type layer.
 */
export interface AdoWorkItemLinksConfig extends AdoCapabilityConfig {
  /** Ceiling on the rendered block; default {@link ADO_LINKS_DEFAULT_MAX_CHARS}. */
  max_chars?: number;
  /** Cap on parent-chain depth; default {@link ADO_LINKS_DEFAULT_MAX_DEPTH}. */
  max_ancestor_depth?: number;
  /** Cap on rows per children/related group; default {@link ADO_LINKS_DEFAULT_GROUP_CAP}. */
  max_group_rows?: number;
  /**
   * Env-var name whose presence in the lease's environment enables the
   * attachment fetch hint; default {@link ADO_LINKS_DEFAULT_PAT_ENV_VAR}. The
   * hint is rendered only when this name is among the dispatch's `envNames`.
   */
  pat_env_var?: string;
}

/** Injected collaborators for {@link createGetWorkItemLinksCapability}. */
export interface GetWorkItemLinksCapabilityDeps {
  /** Resolves the PAT from its `pat_secret_ref`. Required. */
  resolveSecret: SecretResolver;
  /** Builds the links read client; defaults to constructing an {@link ADOClient}. */
  clientFactory?: AdoLinksClientFactory;
}

/** Clamp a config integer into `[min, max]`, defaulting when unset/invalid. */
function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Extract the work-item id a relation points at, or `undefined` if the url is
 * not a work-item resource url (e.g. an attachment). Case-insensitive because
 * ADO uses both `workItems` and `workitems` in the wild.
 */
function relationWorkItemId(url: string): number | undefined {
  const m = /\/workitems\/(\d+)(?:$|[/?#])/i.exec(url);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Collect the linked work-item ids of a given `rel` type, in relation order. */
function linkedIds(item: ADOWorkItem, rel: string): number[] {
  const out: number[] = [];
  for (const relation of item.relations ?? []) {
    if (relation.rel !== rel) continue;
    const id = relationWorkItemId(relation.url);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/** The single parent id (first `Hierarchy-Reverse` link), or `undefined`. */
function parentIdOf(item: ADOWorkItem): number | undefined {
  return linkedIds(item, REL_PARENT)[0];
}

/** A flattened attachment pointer: name, byte size, and download url. */
interface AttachmentPointer {
  name: string;
  size?: number;
  url: string;
}

/** Collect the item's attachment pointers (never their content), in order. */
function attachmentsOf(item: ADOWorkItem): AttachmentPointer[] {
  const out: AttachmentPointer[] = [];
  for (const relation of item.relations ?? []) {
    if (relation.rel !== REL_ATTACHMENT) continue;
    const attrs = relation.attributes ?? {};
    out.push({
      name: typeof attrs.name === "string" ? attrs.name : "(unnamed)",
      size: typeof attrs.resourceSize === "number" ? attrs.resourceSize : undefined,
      url: relation.url,
    });
  }
  return out;
}

/** Render a byte count as a compact human-readable size (or "unknown size"). */
function humanSize(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Order items most-recently-changed first (undated sink to the bottom). */
function byChangedDesc(items: ADOWorkItem[]): ADOWorkItem[] {
  const ts = (item: ADOWorkItem): number => {
    const parsed = Date.parse(strField(item.fields["System.ChangedDate"]));
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...items].sort((a, b) => ts(b) - ts(a));
}

/** The result of walking the parent chain to (or toward) the root. */
interface AncestorChain {
  /** Ancestors ordered ROOT-first, then down to the immediate parent. */
  ordered: ADOWorkItem[];
  /** True when the depth cap stopped the walk before the root was reached. */
  truncated: boolean;
}

/**
 * Walk `Hierarchy-Reverse` parent links up from `subject` to the root, batching
 * one fetch per level (hierarchies here are shallow). Stops at the root, at the
 * depth cap (marking `truncated`), or on a cycle. The subject itself is not
 * included.
 */
async function loadAncestors(
  client: AdoLinksReadClient,
  subject: ADOWorkItem,
  maxDepth: number
): Promise<AncestorChain> {
  const chain: ADOWorkItem[] = [];
  const visited = new Set<number>([subject.id]);
  let current = subject;
  let truncated = false;
  for (;;) {
    const parentId = parentIdOf(current);
    if (parentId === undefined || visited.has(parentId)) break;
    if (chain.length >= maxDepth) {
      truncated = true;
      break;
    }
    const [parent] = await client.getWorkItems([parentId]);
    if (!parent) break;
    visited.add(parentId);
    chain.push(parent);
    current = parent;
  }
  // `chain` is nearest-parent-first; render root-first for top-down reading.
  return { ordered: chain.reverse(), truncated };
}

/** A one-line compact descriptor of a linked item: `#id | type | state | assignee | title`. */
function compactRow(item: ADOWorkItem): string {
  const f = item.fields;
  return [
    `#${item.id}`,
    strField(f["System.WorkItemType"]) || "-",
    strField(f["System.State"]) || "-",
    identityLabel(f["System.AssignedTo"]) || "(unassigned)",
    strField(f["System.Title"]) || "(untitled)",
  ].join(" | ");
}

/** Render the ancestors section, optionally including each ancestor's description. */
function renderAncestors(chain: AncestorChain, withDescriptions: boolean): string {
  const lines = ["Ancestors (root first):"];
  if (chain.ordered.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }
  for (const item of chain.ordered) {
    const f = item.fields;
    lines.push(
      `#${item.id} ${strField(f["System.WorkItemType"]) || "-"} · ` +
        `${strField(f["System.State"]) || "-"} · ` +
        `${identityLabel(f["System.AssignedTo"]) || "(unassigned)"} · ` +
        `${strField(f["System.Title"]) || "(untitled)"}`
    );
    if (withDescriptions) {
      const desc = stripHtml(strField(f["System.Description"]));
      const body = desc
        ? desc
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")
        : "  (no description)";
      lines.push(body);
    }
  }
  if (chain.truncated) {
    lines.push(`(ancestor chain truncated at depth ${chain.ordered.length})`);
  }
  return lines.join("\n");
}

/**
 * Render a children/related group. With `cap <= 0` the rows are dropped for size
 * (a visible marker replaces them but the count stays); otherwise up to `cap`
 * rows are rendered, with an explicit `+N more not shown` line when the group is
 * larger than what is shown.
 */
function renderGroup(title: string, items: ADOWorkItem[], cap: number): string {
  const total = items.length;
  if (total === 0) return `${title} (0):\n(none)`;
  if (cap <= 0) return `${title} (${total}): ${TRUNCATION_MARKER}`;
  const shown = items.slice(0, cap);
  const lines = [`${title} (${total}):`, ...shown.map(compactRow)];
  if (total > shown.length) {
    lines.push(`+${total - shown.length} more not shown`);
  }
  return lines.join("\n");
}

/**
 * Render the attachments section as POINTERS ONLY — never content. The
 * authenticated fetch hint is rendered only when `showHint` is set (i.e. the PAT
 * env var is in the dispatch env). With `dropped` the pointer list is omitted for
 * size, leaving a visible marker and the count.
 */
function renderAttachments(
  attachments: AttachmentPointer[],
  showHint: boolean,
  patEnvVar: string,
  dropped: boolean
): string {
  const total = attachments.length;
  if (total === 0) return "Attachments (0):\n(none)";
  if (dropped) return `Attachments (${total}): ${TRUNCATION_MARKER}`;
  const lines = [`Attachments (${total}):`];
  for (const att of attachments) {
    lines.push(`- ${att.name} (${humanSize(att.size)}) — ${att.url}`);
  }
  if (showHint) {
    lines.push(
      `To download (authenticated): curl -u :$${patEnvVar} ` +
        `-o ./work/attachments/<name> <url>`
    );
  }
  return lines.join("\n");
}

/** Join the four sections (in display order) into one block. */
function assembleBlock(
  ancestors: string,
  children: string,
  related: string,
  attachments: string
): string {
  return [ancestors, children, related, attachments].join("\n\n");
}

/** Hard-cut a block to `max` chars, leaving a visible marker. Never exceeds `max`. */
function hardCut(block: string, max: number): string {
  if (block.length <= max) return block;
  const marker = `\n${TRUNCATION_MARKER}`;
  if (max <= marker.length) return block.slice(0, max);
  return block.slice(0, max - marker.length) + marker;
}

/** Inputs to {@link renderLinksBlock}, already fetched and flattened. */
interface LinksRenderInput {
  chain: AncestorChain;
  children: ADOWorkItem[];
  related: ADOWorkItem[];
  attachments: AttachmentPointer[];
  maxChars: number;
  groupCap: number;
  showHint: boolean;
  patEnvVar: string;
}

/**
 * Render the whole links block under a hard size ceiling. Ancestor context is the
 * most valuable, so it is kept longest; children/related rows are shed FIRST
 * (their per-group cap is walked down toward zero), then the attachment list,
 * then — only if the ancestor block alone still overflows — the ancestor
 * descriptions, and finally a hard cut. Every reduction leaves a visible marker,
 * and the returned block never exceeds `maxChars`.
 */
export function renderLinksBlock(input: LinksRenderInput): string {
  const { chain, children, related, attachments, maxChars, groupCap, showHint, patEnvVar } =
    input;

  const ancestorsFull = renderAncestors(chain, true);
  const attachmentsFull = renderAttachments(attachments, showHint, patEnvVar, false);

  // Stage 1: shed children/related rows first — walk the group cap down toward 0.
  for (let cap = groupCap; cap >= 0; cap--) {
    const block = assembleBlock(
      ancestorsFull,
      renderGroup("Children", children, cap),
      renderGroup("Related", related, cap),
      attachmentsFull
    );
    if (block.length <= maxChars) return block;
  }

  // Stage 2: children/related fully shed didn't fit — drop the attachment list.
  const childrenDropped = renderGroup("Children", children, 0);
  const relatedDropped = renderGroup("Related", related, 0);
  const attachmentsDropped = renderAttachments(attachments, showHint, patEnvVar, true);
  const stage2 = assembleBlock(
    ancestorsFull,
    childrenDropped,
    relatedDropped,
    attachmentsDropped
  );
  if (stage2.length <= maxChars) return stage2;

  // Stage 3: the ancestor block itself overflows — drop its descriptions.
  const ancestorsCompact = renderAncestors(chain, false);
  const stage3 = assembleBlock(
    ancestorsCompact,
    childrenDropped,
    relatedDropped,
    attachmentsDropped
  );
  if (stage3.length <= maxChars) return stage3;

  // Stage 4: even the leanest block overflows — hard-cut it.
  return hardCut(stage3, maxChars);
}

/**
 * Build the `ado.get_work_item_links` capability. Register the returned object on
 * the ado module's `capabilities` array; the registry then exposes it by id in
 * `/api/capabilities` and the playbook editor picker.
 *
 * `fetch(config, subjectRef, context)` resolves the PAT, batch-fetches the
 * subject, walks its ancestors to the root, batch-fetches its children + related
 * items in ONE call, lists its attachment pointers, and renders a size-bounded
 * plaintext block. The attachment fetch hint is rendered only when the PAT env
 * var (default `ADO_PAT`) is among the dispatch's `envNames`. ANY failure
 * degrades to a labelled note — it never throws.
 */
export function createGetWorkItemLinksCapability(
  deps: GetWorkItemLinksCapabilityDeps
): Capability {
  const { resolveSecret } = deps;
  const clientFactory: AdoLinksClientFactory =
    deps.clientFactory ?? ((opts) => new ADOClient(opts));

  async function fetch(
    config: unknown,
    subjectRef: string,
    context?: CapabilityInvocationContext
  ): Promise<CapabilityResult> {
    const label = `Work item ${subjectRef} links`;
    try {
      const id = Number(subjectRef);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`invalid work-item ref "${subjectRef}"`);
      }

      const cfg = (config ?? {}) as AdoWorkItemLinksConfig;
      if (!cfg.org || !cfg.project) {
        throw new Error("ADO module is not configured (org/project missing)");
      }

      const pat = await resolveSecret(cfg.pat_secret_ref ?? "");
      if (!pat) {
        throw new Error(
          `ADO PAT secret unavailable for ref "${cfg.pat_secret_ref ?? ""}"`
        );
      }

      const client = clientFactory({
        org: cfg.org,
        project: cfg.project,
        pat,
        baseUrl: cfg.base_url,
      });

      const maxChars = clampInt(
        cfg.max_chars,
        ADO_LINKS_DEFAULT_MAX_CHARS,
        500,
        MAX_LINKS_BLOCK_HARD_CAP
      );
      const maxDepth = clampInt(
        cfg.max_ancestor_depth,
        ADO_LINKS_DEFAULT_MAX_DEPTH,
        1,
        100
      );
      const groupCap = clampInt(
        cfg.max_group_rows,
        ADO_LINKS_DEFAULT_GROUP_CAP,
        1,
        500
      );
      const patEnvVar =
        typeof cfg.pat_env_var === "string" && cfg.pat_env_var.length > 0
          ? cfg.pat_env_var
          : ADO_LINKS_DEFAULT_PAT_ENV_VAR;
      const showHint = (context?.envNames ?? []).includes(patEnvVar);

      const [subject] = await client.getWorkItems([id]);
      if (!subject) {
        throw new Error(`work item ${id} not found`);
      }

      // Ancestors: sequential (each level reveals the next), capped at maxDepth.
      const chain = await loadAncestors(client, subject, maxDepth);

      // Children + related: ONE batched fetch of the union of both id sets.
      const childIds = linkedIds(subject, REL_CHILD);
      const relatedIds = linkedIds(subject, REL_RELATED);
      const unionIds = [...new Set([...childIds, ...relatedIds])];
      const linkedItems = unionIds.length
        ? await client.getWorkItems(unionIds)
        : [];
      const byId = new Map(linkedItems.map((item) => [item.id, item]));
      const resolve = (ids: number[]): ADOWorkItem[] =>
        ids
          .map((linkedId) => byId.get(linkedId))
          .filter((item): item is ADOWorkItem => item !== undefined);
      const children = byChangedDesc(resolve(childIds));
      const related = byChangedDesc(resolve(relatedIds));

      const attachments = attachmentsOf(subject);

      const content = renderLinksBlock({
        chain,
        children,
        related,
        attachments,
        maxChars,
        groupCap,
        showHint,
        patEnvVar,
      });
      return { label, content };
    } catch (err) {
      return {
        label,
        content: `(capability ${ADO_GET_WORK_ITEM_LINKS_CAPABILITY_ID} failed: ${errorMessage(
          err
        )})`,
      };
    }
  }

  return { id: ADO_GET_WORK_ITEM_LINKS_CAPABILITY_ID, fetch };
}
