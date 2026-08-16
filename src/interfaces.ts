/**
 * Shared typed interfaces for the orchestrator core.
 *
 * Per the architecture principle, these types are domain-neutral: the fields
 * describe the SHAPE of an event, never its intent. Any domain meaning lives in
 * the string values (`source`, `type`, `subject_kind`, ...) supplied by config,
 * producers, and prompts — never in a code branch.
 */

/**
 * A persisted event as stored in the `events` table. `payload` is the parsed
 * JSON object; on disk it is a JSON-encoded TEXT column.
 */
export interface EventRecord {
  id: number;
  source: string;
  type: string;
  subject_kind: string;
  subject_ref: string;
  payload: unknown;
  dedupe_key: string | null;
  ts: number;
  last_dispatched_at: number | null;
  cleared_at: number | null;
}

/**
 * The fields a caller supplies to record a new event. `ts` defaults to the
 * current time when omitted; the lifecycle columns (`last_dispatched_at`,
 * `cleared_at`) are managed by the core and cannot be set at insert time.
 */
export interface NewEvent {
  source: string;
  type: string;
  subject_kind: string;
  subject_ref: string;
  payload?: unknown;
  dedupe_key?: string | null;
  ts?: number;
}

/**
 * The generic, domain-neutral display fields describing the SUBJECT that
 * triggered a run — derived from the triggering event and its opaque payload —
 * surfaced additively wherever runs and dispatches are read.
 *
 * Every field is nullable. `subject_kind`, `subject_ref`, and `event_type` are
 * copied straight off the event; they are null only when no event is joined.
 * `subject_title`/`subject_url`/`subject_type` are read GENERICALLY from the
 * opaque payload (`payload.title`/`payload.url`/`payload.work_item_type` when
 * each happens to be a string, else null) — a payload is never assumed to have a
 * shape. No code branches on any of these values; they are display hints only,
 * per the architecture principle. `subject_type` is a presentation hint the web
 * layer maps to an icon; the core never interprets it.
 */
export interface EventSubjectFields {
  subject_kind: string | null;
  subject_ref: string | null;
  event_type: string | null;
  subject_title: string | null;
  subject_url: string | null;
  subject_type: string | null;
}

/** Options for {@link listEvents}: newest-first pagination by id cursor. */
export interface ListEventsOptions {
  /** Return only events with an id strictly less than this cursor. */
  cursor?: number;
  /** Maximum number of events to return. Defaults to 50. */
  limit?: number;
  /**
   * Free-text search: whitespace-separated terms ANDed across `source`, `type`,
   * `subject_kind`, `subject_ref`, and the raw payload JSON. Empty = no filter.
   */
  q?: string;
}

/**
 * Result of an {@link emitEvent} call. On suppression the carried event is not
 * inserted and `reason` explains why; otherwise the inserted event is returned.
 */
export type EmitResult =
  | { suppressed: true; reason: "cooldown" }
  | { suppressed: false; event: EventRecord };

/**
 * The match predicate of a rule. Every field is optional; an absent field is a
 * wildcard. `criteria` carries arbitrary structural constraints evaluated by the
 * rules engine — its meaning is data, never a code branch.
 */
export interface RuleMatch {
  source?: string;
  type?: string;
  criteria?: Record<string, unknown>;
}

/**
 * A single dispatch target of a rule: which playbook to run and the optional
 * bindings passed to it. Bindings are opaque data forwarded to the playbook.
 */
export interface RuleDispatchTarget {
  playbook_id: number;
  bindings?: Record<string, unknown>;
}

/**
 * A single notify target of a rule: which notifier to deliver through when the
 * rule matches. Notify targets are independent of dispatch targets — a rule may
 * carry either, both, or neither.
 */
export interface RuleNotifyTarget {
  notifier_id: number;
}

/**
 * A persisted rule as stored in the `rules` table. `match` and `dispatch` are
 * parsed JSON; on disk they are JSON-encoded TEXT columns.
 */
export interface RuleRecord {
  id: number;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  dispatch: RuleDispatchTarget[];
  notify: RuleNotifyTarget[];
  created_at: number;
  updated_at: number;
}

/**
 * Fields a caller supplies to create a rule. `enabled` defaults to true; `match`
 * defaults to `{}`; `dispatch` and `notify` default to `[]`. Timestamps are
 * managed by the repo layer.
 */
export interface NewRule {
  name: string;
  enabled?: boolean;
  match?: RuleMatch;
  dispatch?: RuleDispatchTarget[];
  notify?: RuleNotifyTarget[];
}

/** Mutable fields of a rule. Any omitted field is left unchanged. */
export interface RuleUpdate {
  name?: string;
  enabled?: boolean;
  match?: RuleMatch;
  dispatch?: RuleDispatchTarget[];
  notify?: RuleNotifyTarget[];
}

/** Resource limits requested for a playbook's lease. */
export interface PlaybookResources {
  cpus?: number;
  memory_mb?: number;
  pids?: number;
}

/**
 * The isolation level a lease's container runs under, as defined by wisper's
 * consumer surface: ordered weakest -> strongest. This is an infrastructure
 * concern (like `network` or `resources`), NOT domain intent — the core never
 * branches on the value. Omitting it lets the wisper server apply its own
 * default ("shared"); any value outside this set is rejected by wisper with a
 * 400 validation_error.
 */
export type LeaseIsolation = "shared" | "sandboxed" | "vm";

/** The valid {@link LeaseIsolation} values, weakest -> strongest, for validation. */
export const LEASE_ISOLATION_LEVELS: readonly LeaseIsolation[] = [
  "shared",
  "sandboxed",
  "vm",
];

/**
 * The phase in which a playbook step runs. `pre` steps run after lease creation
 * but before the agent exec; `collect` steps run only after the agent exits 0.
 * These strings describe pipeline stage, never domain intent.
 */
export type PlaybookStepPhase = "pre" | "collect";

/**
 * One ordered playbook step: a shell command (rendered through the template
 * engine — it may reference `{{env.NAME}}`, `{{event.*}}`, and `{{payload.*}}`)
 * run inside the lease during a given {@link PlaybookStepPhase}, tagged by a
 * human-readable `label`. Its meaning is entirely data — the executor never
 * branches on the command or label text.
 */
export interface PlaybookStep {
  phase: PlaybookStepPhase;
  command_template: string;
  label: string;
}

/**
 * One capability a playbook is granted: the registered capability's `id` and an
 * optional `config` blob. When `config` is omitted the executor falls back to the
 * owning module's persisted config at dispatch time. The shape of `config` is
 * opaque to the core — its meaning is defined entirely by the owning capability.
 */
export interface GrantedCapability {
  capability_id: string;
  config?: Record<string, unknown>;
}

/**
 * One entry in a playbook's `env_requirements`. Two forms are accepted (all
 * tolerantly parsed — see `parseEnvRequirements`):
 *
 *   - a plain `string` (the legacy shape) — the resolved secret is BOTH injected
 *     into the lease environment AND available to server-side `{{env.NAME}}`
 *     template rendering in step commands, userdata, prompts, and the script
 *     runner's command template. This is what every existing playbook uses.
 *   - an object `{name, inject: "step-only"}` — the resolved secret is available
 *     to server-side `{{env.NAME}}` template rendering but is NEVER placed into
 *     the lease env. Use this for one-shot credentials (e.g. a PAT that a `pre`
 *     step's `git clone` needs once) so the agent step running inside the lease
 *     cannot read the value out of its process environment. The trade-off is
 *     documented at {@link EnvRequirementObject.inject}.
 *
 * The distinction lives entirely in delivery — resolution and missing-secret
 * handling are identical for both forms (unmet names are collected and reported
 * together, and the dispatch fails BEFORE any lease is created).
 */
export type EnvRequirement = string | EnvRequirementObject;

/**
 * Object form of an {@link EnvRequirement}: a required secret that is NOT
 * injected into the lease environment. Only `inject: "step-only"` is defined
 * today; other values are rejected on save (and skipped on tolerant parse).
 *
 * Trade-off: a step-only secret still appears in the RENDERED command string
 * sent to wisper for the one exec that references it — visible in the container
 * process's cmdline while that step runs. That is accepted: the goal is that the
 * value does not PERSIST in the lease environment for the whole run, where an
 * LLM with shell access could read it out at any time.
 */
export interface EnvRequirementObject {
  name: string;
  inject: "step-only";
}

/**
 * A persisted playbook as stored in the `playbooks` table. The JSON columns
 * (`resources`, `runner_config`, `env_requirements`, `steps`,
 * `granted_capabilities`) are parsed; on disk they are JSON-encoded TEXT columns.
 *
 * `runner` names the registered runner that owns building the agent-step command
 * and parsing its output; `runner_config` is that runner's opaque config —
 * interpreted ONLY inside the owning runner and never by the core.
 */
export interface PlaybookRecord {
  id: number;
  name: string;
  image: string;
  /**
   * Optional host selector, opaque to the core. In `v1` mode it is resolved
   * against the wisper catalog (matching a host's id OR name) at dispatch time;
   * in `dev` mode it is used verbatim as the dev hostId. `null` means "use the
   * configured default" (`WISPER_HOST_ID`).
   */
  host: string | null;
  /**
   * Optional lease isolation level (see {@link LeaseIsolation}). `null` means
   * "let the server apply its default" (`shared`); in `v1` mode a non-null value
   * is checked against the selected host's advertised levels before leasing and
   * sent to `POST /v1/leases`. `dev` mode ignores it.
   */
  isolation: LeaseIsolation | null;
  ttl_seconds: number;
  resources: PlaybookResources;
  network: string;
  userdata_template: string;
  prompt_template: string;
  runner: string;
  runner_config: Record<string, unknown>;
  env_requirements: EnvRequirement[];
  steps: unknown[];
  granted_capabilities: GrantedCapability[];
  output_kind: string;
  created_at: number;
  updated_at: number;
}

/**
 * Fields a caller supplies to create a playbook. Only `name`, `image`, and
 * `ttl_seconds` are required; the rest fall back to the table defaults
 * (`network` = "open", `output_kind` = "findings", JSON columns empty).
 */
export interface NewPlaybook {
  name: string;
  image: string;
  /** Optional host selector (see {@link PlaybookRecord.host}); omit for the default. */
  host?: string | null;
  /** Optional lease isolation (see {@link PlaybookRecord.isolation}); omit/null for the server default. */
  isolation?: LeaseIsolation | null;
  ttl_seconds: number;
  resources?: PlaybookResources;
  network?: string;
  userdata_template?: string;
  prompt_template?: string;
  runner?: string;
  runner_config?: Record<string, unknown>;
  env_requirements?: EnvRequirement[];
  steps?: unknown[];
  granted_capabilities?: GrantedCapability[];
  output_kind?: string;
}

/** Mutable fields of a playbook. Any omitted field is left unchanged. */
export interface PlaybookUpdate {
  name?: string;
  image?: string;
  /** Optional host selector (see {@link PlaybookRecord.host}); `null` clears it to the default. */
  host?: string | null;
  /** Optional lease isolation (see {@link PlaybookRecord.isolation}); `null` clears it to the server default. */
  isolation?: LeaseIsolation | null;
  ttl_seconds?: number;
  resources?: PlaybookResources;
  network?: string;
  userdata_template?: string;
  prompt_template?: string;
  runner?: string;
  runner_config?: Record<string, unknown>;
  env_requirements?: EnvRequirement[];
  steps?: unknown[];
  granted_capabilities?: GrantedCapability[];
  output_kind?: string;
}

/**
 * Lifecycle states of a dispatch. A dispatch starts `queued`, is atomically
 * claimed into `leasing`, then advances through `running`/`collecting` to a
 * terminal `done` or `failed`. These strings are the ONLY allowed statuses;
 * they describe pipeline stage, never domain intent.
 */
export type DispatchStatus =
  | "queued"
  | "leasing"
  | "running"
  | "collecting"
  | "done"
  | "failed";

/**
 * A persisted dispatch as stored in the `dispatches` table: one queued unit of
 * work pairing an event with the playbook to run against it.
 *
 * Lease release bookkeeping (`released_at` and `release_pending`) is present on
 * every dispatch, terminal or not: the executor's in-line release retries and
 * the periodic sweep both key on it so a failed release is never abandoned. A
 * `released_at` of `null` on a row with a non-null `lease_id` means the lease
 * is still owed to wisper regardless of the dispatch's lifecycle state.
 */
export interface DispatchRecord {
  id: number;
  event_id: number;
  rule_id: number | null;
  playbook_id: number;
  status: DispatchStatus;
  lease_id: string | null;
  wisp_contract_id: string | null;
  attempts: number;
  error: string | null;
  /**
   * Timestamp (ms since epoch) when the lease was successfully released, or
   * `null` when either no lease was ever created OR the release has not yet
   * succeeded. The sweep queries for `lease_id IS NOT NULL AND released_at IS
   * NULL` so a stuck release keeps retrying past the dispatch's terminal state.
   */
  released_at: number | null;
  /**
   * Set to true when the executor's in-line release retries were exhausted, so
   * the periodic sweep knows to keep trying. Cleared when the sweep finally
   * succeeds. `released_at IS NULL` is the actual sweep predicate; this flag is
   * a display hint (and a way for operators to spot leases stuck needing help).
   */
  release_pending: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Fields a caller supplies to enqueue a dispatch. `status` defaults to
 * `queued`, `attempts` to 0; the lease/contract/error columns start null and
 * are filled in as the pipeline runs. Timestamps are managed by the repo layer.
 */
export interface NewDispatch {
  event_id: number;
  playbook_id: number;
  rule_id?: number | null;
  status?: DispatchStatus;
  lease_id?: string | null;
  wisp_contract_id?: string | null;
  attempts?: number;
  error?: string | null;
  released_at?: number | null;
  release_pending?: boolean;
}

/** Mutable fields of a dispatch. Any omitted field is left unchanged. */
export interface DispatchUpdate {
  status?: DispatchStatus;
  lease_id?: string | null;
  wisp_contract_id?: string | null;
  attempts?: number;
  error?: string | null;
  released_at?: number | null;
  release_pending?: boolean;
}

/**
 * A persisted run as stored in the `runs` table: one attempt to execute a
 * dispatch. `usage` is parsed JSON (or null); on disk it is a JSON-encoded TEXT
 * column. `exit_code`, `result_text`, `log_path`, and `ended_at` are null until
 * the run completes.
 */
export interface RunRecord {
  id: number;
  dispatch_id: number;
  exit_code: number | null;
  result_text: string | null;
  usage: unknown;
  /**
   * Captured stdout of the playbook's `collect` steps, keyed by each step's
   * `label`; parsed JSON (or null when no collect step ran). On disk it is a
   * JSON-encoded TEXT column.
   */
  collected: Record<string, string> | null;
  log_path: string | null;
  started_at: number;
  ended_at: number | null;
}

/**
 * Fields a caller supplies to open a run. Only `dispatch_id` is required;
 * `started_at` defaults to the current time and the completion columns start
 * null.
 */
export interface NewRun {
  dispatch_id: number;
  exit_code?: number | null;
  result_text?: string | null;
  usage?: unknown;
  collected?: Record<string, string> | null;
  log_path?: string | null;
  started_at?: number;
  ended_at?: number | null;
}

/** Mutable fields of a run. Any omitted field is left unchanged. */
export interface RunUpdate {
  exit_code?: number | null;
  result_text?: string | null;
  usage?: unknown;
  collected?: Record<string, string> | null;
  log_path?: string | null;
  ended_at?: number | null;
}

/**
 * One row of the run-history list: a dispatch (the unit of a run) with its
 * latest run's outcome left-joined in. Dispatches that failed before producing
 * a run still appear, with the run-derived fields (`duration_ms`, `exit_code`,
 * `total_tokens`) null and `findings_count` 0. The frontend joins playbook
 * names separately, so no playbook fields are included here. The
 * {@link EventSubjectFields} trace each row back to its triggering event's
 * subject without a second request.
 */
export interface RunHistoryRow extends EventSubjectFields {
  dispatch_id: number;
  playbook_id: number;
  status: DispatchStatus;
  created_at: number;
  /** Run's `ended_at` when a run exists, else the dispatch's `updated_at`. */
  ended_at: number;
  /** `ended_at - started_at` when a run exists, else null. */
  duration_ms: number | null;
  exit_code: number | null;
  /** Sum of the run's usage token fields when present, else null. */
  total_tokens: number | null;
  findings_count: number;
  error: string | null;
}

/**
 * A persisted finding as stored in the `findings` table: a unit of output
 * produced by a run. `tags` is parsed JSON; on disk it is a JSON-encoded TEXT
 * column.
 */
export interface FindingRecord {
  id: number;
  run_id: number;
  content: string;
  tags: string[];
  visibility: string;
}

/**
 * Fields a caller supplies to record a finding. `tags` defaults to `[]` and
 * `visibility` to `"all"`.
 */
export interface NewFinding {
  run_id: number;
  content: string;
  tags?: string[];
  visibility?: string;
}

/**
 * A persisted notifier as stored in the `notifiers` table: a user-built outbound
 * sink. A notification is JUST a notification — there is no delivery `kind`.
 * `config` is a parsed JSON blob kept for future use (no longer read by
 * delivery). The title/body templates are rendered against the triggering event
 * when the notifier delivers. Per the architecture principle all intent lives in
 * the name/templates — no code branches on their content. On disk `config` is a
 * JSON-encoded TEXT column and `enabled` is 0/1.
 */
export interface NotifierRecord {
  id: number;
  name: string;
  config: Record<string, unknown>;
  title_template: string;
  body_template: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Fields a caller supplies to create a notifier. Only `name` is required;
 * `config` defaults to `{}`, the templates to `""`, and `enabled` to true.
 * Timestamps are managed by the repo layer.
 */
export interface NewNotifier {
  name: string;
  config?: Record<string, unknown>;
  title_template?: string;
  body_template?: string;
  enabled?: boolean;
}

/** Mutable fields of a notifier. Any omitted field is left unchanged. */
export interface NotifierUpdate {
  name?: string;
  config?: Record<string, unknown>;
  title_template?: string;
  body_template?: string;
  enabled?: boolean;
}

/**
 * Terminal delivery status of a notification-log row. Every fired notification
 * is recorded `delivered` (the in-app record always lands); a best-effort
 * desktop toast that fails does not change this — its error is carried in
 * `error`. `failed` remains a valid status for unexpected delivery outcomes.
 */
export type NotificationStatus = "delivered" | "failed";

/**
 * A persisted notification-log row as stored in the `notification_log` table:
 * one delivered notification, the append-only store backing the web inbox.
 * `notifier_id`/`event_id` are nullable so a row survives deletion of either.
 * `read_at` is null until the inbox marks the row read.
 */
export interface NotificationLogRecord {
  id: number;
  notifier_id: number | null;
  event_id: number | null;
  title: string;
  body: string;
  status: NotificationStatus;
  error: string | null;
  read_at: number | null;
  created_at: number;
}

/**
 * Fields a caller supplies to append a notification-log row. `notifier_id`,
 * `event_id`, and `error` default to null; `read_at` starts null; `created_at`
 * is managed by the repo layer.
 */
export interface NewNotificationLog {
  notifier_id?: number | null;
  event_id?: number | null;
  title: string;
  body: string;
  status: NotificationStatus;
  error?: string | null;
}

/** Options for {@link listNotifications}: newest-first pagination by id cursor. */
export interface ListNotificationsOptions {
  /** Return only rows with an id strictly less than this cursor. */
  cursor?: number;
  /** Maximum number of rows to return. Defaults to 50. */
  limit?: number;
  /** When true, return only unread rows (`read_at` is null). */
  unreadOnly?: boolean;
  /**
   * Free-text search: whitespace-separated terms ANDed across `title`, `body`,
   * `status`, and `error`. Empty = no filter.
   */
  q?: string;
}

/**
 * The kind of a reusable snippet. Partitions the `snippets` store into three
 * DIFFERENT composition models resolved at dispatch time (see the executor):
 *   - `prompt`   — stackable `{{snippet.<name>}}` tokens inside a prompt_template
 *   - `userdata` — a single whole-value `snippet:<name>` reference
 *   - `step`     — a whole saved command referenced per step / script runner
 * Intent lives entirely in the name/description/content — never in a code branch.
 */
export type SnippetKind = "prompt" | "userdata" | "step";

/** The three valid {@link SnippetKind} values, for validation. */
export const SNIPPET_KINDS: readonly SnippetKind[] = [
  "prompt",
  "userdata",
  "step",
];

/**
 * A persisted snippet row. `name` is unique WITHIN a `kind` (references are by
 * name), so a rename breaks every reference on purpose — the dispatch fails
 * loudly at resolution, like a missing secret.
 */
export interface SnippetRecord {
  id: number;
  kind: SnippetKind;
  name: string;
  description: string;
  content: string;
  created_at: number;
  updated_at: number;
}

/**
 * Fields a caller supplies to create a snippet. `kind`, `name`, and `content`
 * are required; `description` defaults to `""`. Timestamps are managed by the
 * repo layer.
 */
export interface NewSnippet {
  kind: SnippetKind;
  name: string;
  content: string;
  description?: string;
}

/**
 * Mutable fields of a snippet. Any omitted field is left unchanged. `kind` and
 * `name` may both change — a rename is allowed and deliberately breaks any
 * reference by name (see {@link SnippetRecord}).
 */
export interface SnippetUpdate {
  kind?: SnippetKind;
  name?: string;
  content?: string;
  description?: string;
}
