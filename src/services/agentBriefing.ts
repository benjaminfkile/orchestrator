/**
 * The agent briefing served by `GET /api/agent-briefing` and shown on the
 * "Agent Briefing" page. A user pastes it into any AI coding agent running on
 * this machine (Claude Code, Codex, Cursor, or anything that can make HTTP
 * requests) so the agent can drive this orchestrator's loopback API (creating
 * rules, playbooks, notifiers, dispatching runs) on their behalf.
 *
 * MAINTENANCE (load-bearing): this text is the ONLY thing a pasted-in agent
 * knows about the app. Whenever the operational surface changes (an endpoint
 * is added/renamed, a request/response shape changes, a setting key or runner
 * appears, template/matching semantics move), update this briefing in the same
 * change. The README ("Agent briefing" section) and CLAUDE.md both point here.
 *
 * Rendered per request with the port this server actually booted on (`PORT`,
 * default 3007), so the base URL stays correct however the app is run.
 */

export function agentBriefing(port: number): string {
  const baseUrl = `http://127.0.0.1:${port}/api`;
  return `# Driving orchestrator via its local API (agent briefing)

You are talking to **orchestrator**, a single-user desktop app that watches
external systems (Azure DevOps), matches events against user-configured rules,
and runs data-driven playbooks inside short-lived container leases. Your job:
help the user configure and operate it over plain HTTP+JSON.

Base URL: \`${baseUrl}\` (loopback only, NO auth). Verify with
\`GET /api/health\` -> \`{status:"ok", db:true, wisper:true}\` ("wisper" false means
the lease backend is down; config edits still work, runs will not). This text is
served at \`GET /api/agent-briefing\` -> \`{briefing}\`; re-fetch it any time to
refresh these instructions.

\`GET /api/changes/stream\` is a Server-Sent Events feed of \`{resource, ts}\`
frames (one per data change, e.g. \`{"resource":"playbooks"}\`) that the web UI
subscribes to so open pages refresh live. You do NOT need to do anything special
for the UI to update: every write you make is picked up automatically.

## Mental model (the pipeline)

producers (ADO poller) -> **events** -> **rules** (match) -> **dispatches**
(queued, one at a time) -> executor rents a container lease, runs the
playbook's steps + agent, saves a **run** with **findings** -> emits a
run-lifecycle event -> **notifiers** fire notifications.

Key invariants you must respect:
- The core is domain-neutral: all intent lives in DATA you write (rule
  criteria, prompts, templates, event-type strings); never ask to change code.
- Send ONLY documented keys. The rules/playbooks/snippets/notifiers/dispatches
  write endpoints (and the datadog config PUT) reject unknown body keys with a
  400 naming the offender; secrets and the ADO config do not, so a typo there
  can persist silently; double-check those bodies yourself. Settings
  whitelists the \`key\` (unknown keys 400) but ignores extra body properties.
- Secrets are write-only: you can set and reference them by NAME, never read a
  value back. Never echo a secret value the user gives you into any other field.

## Events

- \`GET /api/events?limit=N&before=<id>\`: newest first (\`limit\` default 50, max
  500); \`before\` pages past the given event id. \`GET /api/events/:id\`.
  Add \`?q=<text>\` to substring-search (case-insensitive) across source, type,
  subject_kind, subject_ref, and the raw payload JSON; whitespace-separated terms
  are ANDed and it composes with \`before\`.
- \`POST /api/events\` mints a synthetic event through the normal intake so a
  dispatch can be created on a fresh stack that has no integration modules
  configured. Body: \`{source? (default "manual"), type (required, e.g.
  "test.manual"), subject_ref (required), subject_kind? (default "manual"),
  payload? (JSON object)}\`. A deterministic \`dedupe_key\` of
  \`manual:<source>:<type>:<subject_ref>\` is applied so the normal cooldown
  collapses repeats: a first mint returns \`201\` with the created event; a mint
  that lands inside the cooldown returns \`200\` with the existing event. Rules
  match the minted event exactly as if a producer had emitted it.
- \`GET /api/events/facets\` -> \`{sources, types}\`: every recorded source/type
  merged with what the registered modules can emit (works on an empty DB). Use
  it to discover valid \`match.type\` strings before writing a rule.
- Shape: \`{id, source, type, subject_kind, subject_ref, payload, dedupe_key,
  ts, last_dispatched_at, cleared_at}\`. Payload is opaque JSON from the
  producer. All columns are addressable in rule criteria as \`event.<column>\`. Only the newest 1000 events are kept (dispatch-referenced ones survive).
- ADO producer events: \`ado.workitem.created/.assigned/.state_changed/
  .area_changed/.iteration_changed/.tagged/.updated\`, \`ado.pullrequest.created/
  .updated/.pushed/.comment.created/.thread.status_changed/.vote/.completed/
  .abandoned\` (source \`ado\`). PR payloads carry \`is_draft\`; \`.updated\` fires on a
  status or draft-flag change with \`previous_status\` and \`previous_is_draft\`;
  \`.pushed\` carries \`iteration_id\`, \`source_commit\`, \`changed_files\`;
  \`.comment.created\` carries \`thread_id\`, \`comment_id\`, \`parent_comment_id\`
  (null unless a reply), \`author\`, \`content\`, \`file_path\`, \`line\`;
  \`.thread.status_changed\` carries \`status\` and \`previous_status\`; \`.vote\`
  carries \`vote\`, \`vote_label\`, \`previous_vote\`; the README lists every field.
- Datadog producer events (source \`datadog\`, aggregate-driven: never one per
  log line):
  - \`datadog.logs.alert\`: a watched log query's grouped count tripped a
    statistical detector. ONE event per (watch, group) tick; rules discriminate
    on the payload, not distinct types. Payload: \`{watch, query, group_by, group,
    detectors, count, baseline, window_start, window_end, samples[], explorer_url}\`.
    \`detectors\` is a subset of \`["threshold","spike","novel"]\` (threshold =
    count>=min_count; spike = count>=spike_multiplier*trailing baseline; novel =
    first sighting of the group). Match e.g. \`payload.count gte 100\`,
    \`payload.detectors contains "spike"\`. \`subject_kind\` \`log_group\`,
    \`subject_ref\` \`<watch>/<group>\`, \`dedupe_key\` \`datadog:<watch>:<group>\`.
  - \`datadog.monitor.transition\`: a monitor (or monitor group) changed state.
    Payload: \`{monitor_id, name, query, group, from_state, to_state, url}\` (group
    \`*\` for an ungrouped monitor). Match e.g. \`payload.to_state eq "Alert"\`.
    \`subject_kind\` \`monitor\`, \`subject_ref\` \`<id>\`, \`dedupe_key\`
    \`datadog:monitor:<id>:<group>\`. The \`event_dedupe_cooldown_seconds\` setting
    then suppresses re-storms of the same subject.
- Run-lifecycle events (source \`orchestrator\`): \`run.started\` fires each time
  the dispatcher hands a claimed dispatch to the executor; a retried dispatch
  emits it once per attempt (never for dispatches that stay queued or are
  dropped by a cap/gate); \`run.completed\` / \`run.failed\`
  fire on terminal dispatch outcomes. \`run.started\` payload: \`{dispatch_id,
  playbook_id, playbook_name, rule_id, origin, chain_depth}\`: the start-time
  subset, with no terminal fields. Terminal payload: \`{dispatch_id, run_id,
  playbook_id, playbook_name, rule_id, status, exit_code, error, findings,
  findings_count, collected, duration_ms, total_tokens, origin, chain_depth}\`.
  \`origin\` is an OBJECT describing the triggering event (\`{event_id, source,
  type, subject_kind, subject_ref}\`), so a chaining rule matches e.g.
  \`payload.origin.subject_ref\`; \`findings\` is \`[{content, tags}]\`.
  Rules can match these to notify or CHAIN playbooks; the
  \`dispatch_max_chain_depth\` setting (default 3) caps runaway chains for every
  run-lifecycle event (\`run.started\` included).

## Rules: \`GET/POST /api/rules\`, \`GET/PATCH/DELETE /api/rules/:id\`, \`POST /api/rules/:id/enable|disable\`

Body: \`{name, enabled?, match?, dispatch?, notify?}\`.
- \`match\`: \`{source?, type?, criteria?}\`: absent field = wildcard.
  - \`type\` supports \`*\` and \`prefix.*\` wildcards (\`prefix.*\` also matches the
    bare \`prefix\`).
  - \`criteria\` keys are dotted paths into the event payload (\`fields.state\`),
    or \`event.<column>\` for the event row itself. Values: a scalar (strict
    equality), an array (membership), or an operator map ANDed together:
    \`eq/ne/in/nin/contains/exists\`, regex \`=~\`/\`!~\`, ordering \`gt/gte/lt/lte\`
    (aliases also accepted: \`=\`, \`==\`, \`!=\`, \`<>\`, \`not_in\`, \`has\`, \`regex\`,
    \`matches\`, \`not_matches\`, \`>\`, \`>=\`, \`<\`, \`<=\`).
    The literal string \`"@Me"\` resolves to the \`identity_me\` setting in
    scalar/array specs and eq/ne/in/nin/contains/ordering operands, but NOT inside
    regex patterns; when \`identity_me\` is unset it compares literally.
    Malformed criteria fail closed (rule silently does not fire).
- \`dispatch\`: \`[{playbook_id, bindings?}]\`: playbooks to run on match.
  \`bindings\` is validated and stored but NOT currently read by the executor or
  exposed to templates; do not rely on it to parameterize a run.
- \`notify\`: \`[{notifier_id}]\`: notifiers to fire on match (not rate-capped).
- \`DELETE /api/rules/:id\` -> 204. 409 \`{error: "rule has N in-flight dispatches"}\`
  while any dispatch created by this rule is queued/leasing/running/collecting;
  wait for those to finish first. On success the terminal dispatches that
  referenced the rule have their \`rule_id\` set to null so the run history stays
  readable.

## Playbooks: \`GET/POST /api/playbooks\`, \`GET/PATCH/DELETE /api/playbooks/:id\`

Body (required: name, image, ttl_seconds): \`{name, image, host?, isolation?,
ttl_seconds, resources?{cpus,memory_mb,pids}, network? ("open"|"none"),
userdata_template?, prompt_template?, runner?, runner_config?,
env_requirements? (array of \`"NAME"\` or \`{name, inject: "step-only"}\`),
steps?, granted_capabilities?, output_kind?}\`. \`output_kind\` is a stored
string (default \`findings\`) that the core never interprets.
- \`image\`: literal image ref, or \`setting:<key>\` resolved from app settings at
  dispatch time (convention: \`setting:default_lease_image\`).
- \`host\` (optional string, or \`null\` to clear to the default): which host runs
  the lease. Opaque here; \`null\`/omitted uses the configured default host
  (\`WISPER_HOST_ID\`). In \`v1\` mode it and \`image\` are NAMES resolved against the
  wisper catalog at dispatch time (host matches a catalog host's id OR name,
  image matches an offered image ref); an unknown/offline host or an unoffered
  image fails the dispatch BEFORE leasing (like a missing secret). In \`dev\` mode
  it is used verbatim as the dev hostId. Host suggestions:
  \`GET /api/wisper/hosts\`.
- \`isolation\` (optional \`"shared"|"sandboxed"|"vm"\`, or \`null\` to clear to the
  server default): the lease isolation level, ordered weakest -> strongest. An
  infrastructure knob, never domain intent. \`null\`/omitted lets the wisper
  server apply its default (\`shared\`). In \`v1\` mode a non-null value is checked
  against the selected host's advertised \`isolation_levels\` at dispatch time (a
  host that cannot provide it fails the dispatch BEFORE leasing, like an
  unoffered image) and is sent on \`POST /v1/leases\`; \`dev\` mode ignores it. A
  value outside the allowed set is a \`400\` at save time. Note
  \`GET /api/wisper/hosts\` does NOT expose isolation levels, so you cannot
  pre-check support; a mismatch surfaces as the dispatch failure.
- \`resources\` (optional \`{cpus?, memory_mb?, pids?}\`): only forwarded in
  \`dev\` mode. In \`v1\` mode resources are fixed by the selected offer server-side,
  so the field is IGNORED at lease creation and \`POST /v1/leases\` NEVER carries
  \`resources\` or a top-level \`gpus\` (the server rejects either with a \`400\`
  \`validation_error\`). It is kept in the playbook body for dev-mode use and
  round-trips through save/list unchanged.
- \`runner\` (see \`GET /api/runners\`):
  - \`claude-code\` (default): runs Claude Code in the lease against the
    rendered \`prompt_template\`. \`runner_config\`: \`{model?, allowed_tools?}\`
    (models list: \`GET /api/anthropic/models\`). The executor STAGES the fully
    rendered prompt into the lease as a file at \`/work/prompt.txt\` on
    createLease (via the wisper contract's \`files\` array), and the agent
    command reads it into \`claude\` on STDIN:
    \`sh -c 'claude -p ... < /work/prompt.txt'\` on linux and
    \`cmd /c type C:\\work\\prompt.txt | claude -p ...\` on windows (Windows
    leases use the same unix-style request path; wisp maps it onto the
    container filesystem). No rendered prompt content ever appears in any
    exec command, so a large prompt never trips the windows argv/env caps. A
    rendered prompt over the wisper file budget (1 MiB total decoded bytes)
    fails the dispatch with a clear validation error BEFORE any lease is
    created. On linux leases the command is prefixed \`IS_SANDBOX=1\` so the
    claude CLI accepts \`--dangerously-skip-permissions\` under root (wisp
    execs run as root); an image only needs \`claude\` reachable on the
    default PATH.
  - \`script\`: no LLM; \`runner_config.command_template\` (required; a missing/
    empty one fails the dispatch BEFORE leasing) is rendered
    and run as the agent step; its stdout is the run's result text. Exit 0 =
    success. CAUTION: leases may be Windows containers (check the
    \`default_lease_image\` setting); commands then run under \`cmd /c\` and
    double quotes arrive backslash-escaped; avoid quotes/angle brackets in
    commands, or build strings in PowerShell via \`[char]34\`/\`[char]60\`.
- \`steps\`: \`[{phase: "pre"|"collect", command_template, label}]\`: \`pre\` runs
  before the agent (e.g. git clone), \`collect\` after success; collect stdout is
  saved on the run keyed by label.
- \`env_requirements\`: required secret NAMES. Each entry is EITHER a plain
  string (the legacy shape: the resolved secret is injected into the lease env
  AND available to server-side \`{{env.NAME}}\` template rendering EVERYWHERE:
  step \`command_template\`s, \`userdata_template\`, \`prompt_template\`,
  \`prompt\`-kind snippet content, and the \`script\` runner's
  \`command_template\`) OR an object \`{name, inject: "step-only"}\` (the resolved
  secret is available to \`{{env.NAME}}\` rendering ONLY in step
  \`command_template\`s and the \`script\` runner's \`command_template\`; it is
  NEVER placed in the lease env, and \`prompt_template\` / \`userdata_template\` /
  \`prompt\`-kind snippet content also do NOT see it, so a step-only value can
  never reach the lease (via userdata, or via the staged \`/work/prompt.txt\`
  prompt file) or the prompt the agent sees). A missing
  secret fails the dispatch before leasing under both shapes. Use
  \`inject: "step-only"\` for one-shot credentials (e.g. a PAT that a \`pre\`
  step's \`git clone\` needs once); the value still appears in that step's
  rendered command sent to wisper, but does not persist in the lease env for
  the whole run. IMPORTANT: the agent inside the lease only knows a lease-env
  variable exists if the prompt says so; state available env var names in
  \`prompt_template\` (do NOT advertise \`step-only\` names, they are not there).
- Template substitution (prompt/userdata/step/script templates):
  \`{{event.type}}\`, \`{{event.source}}\`, \`{{event.subject_ref}}\`,
  \`{{payload.<dotted.path>}}\`, and \`{{env.NAME}}\` (a resolved secret). The
  \`env\` root is available in step \`command_template\`s, the \`script\` runner's
  \`command_template\`, \`prompt_template\`, \`userdata_template\`, and
  \`prompt\`-kind snippet content. \`prompt_template\`, \`userdata_template\`, and
  \`prompt\`-kind snippet content render against the LEASE-injectable env only;
  a \`{name, inject: "step-only"}\` secret is EXCLUDED there (it renders empty),
  so a step-only value can never reach the lease (via userdata) or the prompt
  the agent sees. Unknown tokens render empty.
- Findings: an agent (or script) persists findings by printing
  \`<NOTES_TO_SAVE>[{"content":"...","visibility":"all","tags":["..."]}]</NOTES_TO_SAVE>\`.
  \`visibility\` is \`self|siblings|descendants|ancestors|all\` (default \`all\`);
  \`content\` must be a non-empty string. Invalid entries are SILENTLY skipped
  (never fatal); multiple blocks in one output accumulate.
- \`DELETE /api/playbooks/:id\` CASCADES the playbook's run history (its terminal
  dispatches, their runs, those runs' findings, and each dispatch's log file)
  and then the playbook row (204). A playbook with any IN-FLIGHT (queued/leasing/
  running/collecting) dispatch is refused with 409 \`{error: "playbook has N
  in-flight dispatches"}\`; wait for those to finish first. A referencing rule is
  NOT a barrier: after the delete its dispatch target is dangling but fail-closes
  (the event just does not dispatch that target).
- \`GET /api/playbooks/:id/usage\` -> \`{dispatches, runs, findings, in_flight,
  referencing_rules: [{id, name}]}\`: the counts a delete would cascade, whether
  any dispatch is in flight, and the enabled rules that reference the playbook.

## Snippets: \`GET/POST /api/snippets\`, \`GET/PATCH/DELETE /api/snippets/:id\`

Reusable, user-authored template fragments resolved at DISPATCH TIME, so editing
one propagates to every playbook that references it. Body: \`{kind, name,
content, description?}\`; \`kind\` is \`prompt\` | \`userdata\` | \`step\` and
\`name\` is unique WITHIN a kind. \`GET /api/snippets?kind=<kind>\` filters.
Duplicate \`(kind, name)\` on create -> 409.

References are BY NAME and differ by kind ON PURPOSE:
- \`prompt\`: STACKABLE \`{{snippet.<name>}}\` tokens inside a \`prompt_template\`
  (this token mechanic is EXCLUSIVE to prompts). A prompt snippet's content is
  itself rendered with the full context (event/payload/env AND further
  \`{{snippet.*}}\` tokens), so snippets nest; nesting is bounded (depth 5) and
  cycle-guarded.
- \`userdata\`: a SINGLE whole-value reference: set \`userdata_template\` to
  exactly \`snippet:<name>\` (no inline mixing, no nesting).
- \`step\`: a whole saved command: set a step's \`command_template\` (or the
  \`script\` runner's \`runner_config.command_template\`) to \`snippet:<name>\`.
  Ordering the steps chains them.

A missing, renamed, or kind-mismatched reference FAILS the dispatch BEFORE any
lease is created (loudly, like a missing secret), never silently dropped. A
rename therefore breaks every reference by design.

## Dispatches (the queue): \`GET /api/dispatches\`, \`GET /api/dispatches/:id\`

- \`GET /api/dispatches/:id\` embeds every run of the dispatch (retries add
  rows), each with its findings. \`GET /api/dispatches\` lists newest-first;
  \`?status=\` filters to one state, \`?active=1\` filters to the non-terminal
  (queued/leasing/running/collecting) work. The Queue page is a QUEUE: it
  fetches \`?active=1\` and shows only waiting/in-flight dispatches. Terminal history (done/failed) lives on the
  Runs page (\`GET /api/runs\`), which links back per dispatch and offers retry.
- Add \`?q=<text>\` to \`GET /api/dispatches\` to substring-search (case-insensitive,
  whitespace-separated terms ANDed) across status, error, subject fields, event
  type, and playbook name. \`GET /api/runs\` takes the same \`?q=\` and searches
  playbook name, status, error, subject fields, and each run's result text,
  collected JSON, and findings content. Both compose with the other filters.
- Manual run: \`POST /api/dispatches\` body \`{event_id, playbook_id}\` -> 201
  (404 for an unknown event or playbook). Deliberately bypasses
  \`dispatch_max_per_event\`, but still counts against the per-hour cap and the
  run/token budget gate.
- \`POST /api/dispatches/:id/retry\`: 409 unless the status is exactly \`failed\`.
- \`GET /api/dispatches/:id/log\`: a \`text/plain\` stream that TAILS the log
  until the dispatch is terminal (it deliberately stays open while the dispatch
  runs; do not curl it and wait); 404 until the log file exists.
- There is NO cancel endpoint: an in-flight dispatch runs to completion (which
  is also why deleting its playbook is refused until it finishes).
- Status flow: queued -> leasing -> running -> collecting -> done | failed.
  A dispatch held by the run/token budget gate stays \`queued\` annotated with
  \`{waiting_reason: "budget", window_count, budget, next_eligible_at, ...}\`;
  check those fields when a dispatch seems stuck.
- Lease release bookkeeping: \`released_at\` (ms since epoch or null) is the
  timestamp of a successful lease release; \`release_pending: true\` marks a row
  whose lease release is stuck retrying. A release sweep runs once at boot and
  periodically while the dispatcher is up; it reattempts release for any
  TERMINAL (\`done\`/\`failed\`) dispatch with a non-null \`lease_id\` and a null
  \`released_at\`; in-flight dispatches are never touched (their lease is owned
  by the running pipeline, which releases it itself). A wisper "not_found"
  response is treated as a successful release. \`POST /api/dispatches/:id/retry\`
  refuses (409) while a failed dispatch still holds an unreleased lease; wait
  for the sweep (typically under a minute), then retry.
- A retryable dispatch failure is NEVER requeued while it still holds an
  unreleased lease: the dispatcher tries one more inline release first, and if
  that also fails it leaves the row \`failed\` with \`release_pending\` set (the
  sweep then chases the release) instead of requeueing; a stuck release is
  strong evidence the host/wisper path is unhealthy, and requeueing would drop
  the lease handle so the lease would run to wisper's TTL failsafe, billed.
- Runs: \`GET /api/runs/:id\` -> run + collected output + findings. \`GET
  /api/runs\` also takes \`?limit=\` (1..1000) and \`?status=\` (a dispatch status).

## Notifiers & notifications

- \`GET/POST /api/notifiers\`, \`GET/PATCH/DELETE /api/notifiers/:id\`. Body:
  \`{name, title_template?, body_template?, enabled?, config?}\` (templates use
  the same \`{{...}}\` engine against the triggering event).
- Every fired notification is recorded in-app AND best-effort raised as a
  native desktop toast (on Windows a click opens the run page, or the inbox; ORCH_WEB_URL sets the web origin). \`GET /api/notifications\`, \`POST /api/notifications/:id/read\`,
  \`/read-all\`, \`GET /api/notifications/unread-count\`. \`GET /api/notifications\`
  takes \`?q=<text>\` to substring-search (case-insensitive, terms ANDed) across
  title, body, status, and error; it composes with the cursor and \`unread=1\`.
  \`GET /api/notifications/stream\` is an SSE feed of new notifications.

## Settings & secrets

- \`GET /api/settings\`, \`PUT /api/settings\` body \`{key, value}\` (whitelisted
  keys): \`default_lease_image\`, \`dispatch_concurrency\` (any value above 1 is
  clamped to 1: dispatches run one at a time),
  \`dispatcher_interval_seconds\`,
  \`dispatch_max_attempts\`, \`dispatch_timeout_seconds\`, \`dispatch_max_per_event\`,
  \`dispatch_max_per_hour\`, \`dispatch_max_chain_depth\`,
  \`event_dedupe_cooldown_seconds\`, \`identity_me\`, \`run_retention_max\`
  (caps kept terminal runs, default 2000; oldest beyond it are pruned with their
  findings and log files; 0 or negative disables pruning),
  \`run_budget_per_hour\`, \`run_budget_window_minutes\` (default 60), and
  \`token_budget_per_window\`. The run/token budgets are a GATE, not a rejection:
  when the window's run count or token spend is exhausted, further dispatches
  are HELD in \`queued\` (annotated with \`waiting_reason: "budget"\`, see
  Dispatches) until the window frees up.
- Secrets: \`GET /api/secrets\` (names only), \`PUT /api/secrets\` body
  \`{key, value}\`, \`DELETE /api/secrets/:key\`. Typical names:
  \`CLAUDE_CODE_OAUTH_TOKEN\`, \`ADO_PAT\`, \`GIT_TOKEN\`, \`DD_API_KEY\`,
  \`DD_APP_KEY\`, \`WISPER_API_KEY\`.
- \`GET /api/settings/system\` -> read-only boot facts the UI shows next to the
  editable settings: \`{wisperBaseUrl, wisperHostId (null when unset), wisperMode
  ("dev"|"v1"), wisperApiKeyPresent (boolean: WHETHER the \`WISPER_API_KEY\`
  secret is set, never its value)}\`.
- \`GET /api/wisper/hosts\` -> the rentable host catalog for the playbook Host
  picker, fetched SERVER-SIDE so the API key never reaches the client:
  \`{hosts: [{id, name, os, online, images: [{id, name, price_cents_per_min}]}], warning?}\`.
  In \`v1\` mode it reads \`GET /v1/catalog\` with the bearer token; in \`dev\` mode it
  returns a single synthetic entry for \`WISPER_HOST_ID\`. DEGRADES like
  \`GET /api/anthropic/models\`: always 200, empty list + \`warning\` on any failure.
- Lease backend mode (boot env \`WISPER_MODE\`, default \`dev\`): \`dev\` speaks the
  unauthenticated local \`/dev/leases\` harness. \`v1\` speaks the authenticated
  \`/v1/leases\` consumer surface, sending \`Authorization: Bearer <WISPER_API_KEY>\`
  (resolved from the secret store at call time; set the \`WISPER_API_KEY\` secret
  before switching). In v1 a missing key, or a \`401\`/\`403\`, fails the dispatch
  terminally (never retried) naming \`WISPER_API_KEY\`; a \`402\` fails terminally as
  insufficient funds. In v1 the client also resolves a playbook's \`host\` selector
  and \`image\` NAME against \`GET /v1/catalog\` (cached in-process ~60s) to the
  \`host_id\`/\`host_image_id\` the lease body needs; an unknown/offline host or an
  unoffered image fails the dispatch terminally BEFORE leasing. \`WISPER_HOST_ID\`
  is the default catalog host (id or name) when a playbook sets no \`host\`. In v1
  a playbook's non-null \`isolation\` is also checked against the resolved host's
  catalog \`isolation_levels\` and, if supported, sent on \`POST /v1/leases\`; a
  host that cannot provide it fails the dispatch terminally BEFORE leasing. The
  dispatch/executor surface is otherwise identical between modes.
- Wisper base URL (boot env \`WISPER_BASE_URL\`, default \`http://localhost:8080\`):
  a plaintext \`http://\` URL to a NON-loopback host is REFUSED at startup so the
  \`WISPER_API_KEY\` and injected secrets are not sent unencrypted; use \`https://\`,
  or a loopback host (\`localhost\`/\`127.0.0.1\`/\`::1\`) for local dev. Set
  \`WISPER_ALLOW_INSECURE_HTTP=1\` (or \`true\`) to downgrade the refusal to a loud
  warning when terminating TLS yourself.
- On-disk state layout (boot env \`ORCH_DATA_DIR\` / \`ORCH_DB_PATH\`): the SQLite
  DB, per-dispatch log files, and the encrypted secret store all live under a
  single base directory. \`ORCH_DATA_DIR\` (verbatim, no \`orchestrator\` suffix
  appended) redirects all three; \`ORCH_DB_PATH\` still overrides ONLY the DB
  file. When neither is set the base defaults to \`<OS user-data
  dir>/orchestrator\`. The resolved paths are logged once at startup as
  \`{dbPath, logsDir, secretsDir}\`.
- Create-lease timeout (boot env \`WISPER_CREATE_LEASE_TIMEOUT_MS\`, default
  150000 ms): the blocking create-lease call waits this long for wisper to
  provision the lease (clone/build can take minutes for heavy images).
- Per-call exec timeout (boot env \`WISPER_EXEC_TIMEOUT_MS\`, optional
  operator override): governs the per-call timeout for the pipeline's step
  execs and the streaming agent exec (inter-chunk IDLE window there, not a
  wall-clock cap). When UNSET the executor derives the value per call from
  the lease's REMAINING TTL plus a small margin, capped at about 6 hours, so
  a step or agent command that runs the length of a long lease is not killed
  by a fixed 60 seconds. An explicit env value wins over that computed
  default. Total run time is bounded separately by the per-dispatch deadline
  (\`min(ttl_seconds - 60, dispatch_timeout_seconds)\`), not by this timeout.
- Per-call release timeout (boot env \`WISPER_RELEASE_TIMEOUT_MS\`, default
  60 s): governs the per-call timeout for every lease-release DELETE, i.e.
  the executor's finally-block release, boot's orphan reconcile, the periodic
  release sweep, and the dispatcher's late release before a retryable
  requeue. Kept short and separate from the exec timeout so a hung socket
  cannot stall boot or a sweep pass for hours the way the multi-hour exec
  cap would.

## Modules (integration producers)

- \`GET /api/modules\` -> \`[{id, producers: [{producerId, trigger, lastTickAt,
  lastError, nextFireAt}]}]\`: whether each poller is armed and its last error.
- \`GET /api/modules/:id/config\` -> \`{module_id, config}\`; \`PUT\` takes the
  BARE config object (do not round-trip the GET wrapper back).
- ADO config keys (\`/api/modules/ado/config\`): org, project, base_url,
  pat_secret_ref, enabled, interval_seconds, watched, pull_requests. NOT
  shape-validated on PUT (unlike datadog); a typoed key persists silently, so
  double-check the body. The ADO integration is READ-ONLY.
- \`POST /api/modules/ado/backfill\` body \`{producer_id?, limit?, dry_run?}\` ->
  \`{candidates, emitted}\` (400 when the module is disabled or unconfigured).
- Discovery pickers under \`/api/modules/ado/discovery/*\` (\`orgs\`,
  \`projects?org=\`, \`work-item-types?org=&project=\`,
  \`states?org=&project=&type=\`, \`area-paths?org=&project=\`,
  \`iterations?org=&project=\`, \`identities?org=&project=&q=\`; \`workitems?q=\`
  searches the CONFIGURED project's work items and needs the module enabled), plus
  \`GET /api/modules/ado/identity/me\`. On a PAT lacking scopes these DEGRADE to
  200 + an empty list with an \`X-Ado-Restricted\` header, never a hard 401.
- \`POST /api/modules/ado/workitems/:id/materialize\` -> 201 with a stored
  \`ado.workitem.manual\` event (source \`ado\`; rule matching and dedupe are
  skipped): the way to mint a real test event on demand.
- Grantable capabilities (\`GET /api/capabilities\` -> \`[{id, module_id}]\`) are
  READ-ONLY prompt enrichers granted per playbook; for ANY capability, a grant
  with no \`config\` inherits the owning module's stored connection config. ADO
  contributes \`ado.get_work_item\`, \`ado.query_work_items\`, \`ado.sprint_rollup\`,
  and \`ado.get_work_item_links\`.
- \`GET/PUT /api/modules/datadog/config\` (enabled, site (a bare domain like
  \`us5.datadoghq.com\`, default \`datadoghq.com\`), api_key_secret_ref,
  app_key_secret_ref, interval_seconds, monitors, watches). Config is
  shape-validated on PUT (unknown keys rejected -> 400). The two keys are read
  from the secret store by name and sent as \`DD-API-KEY\`/\`DD-APPLICATION-KEY\`.
  READ-ONLY. Two aggregate-driven producers (\`datadog.logwatch\`,
  \`datadog.monitor\`) arm on an interval when enabled + configured; each seeds
  SILENTLY on its first tick (a restart never replays), keeps its statistical
  baselines / state in memory, and fails quiet (a failed tick logs a warning and
  emits nothing). See the Events section for the two event types they emit. Each
  \`watches[]\` entry is \`{name, query, group_by, window_seconds?, sample_limit?,
  detect:{min_count?, spike_multiplier?, baseline_windows?, novel_groups?}}\`;
  \`monitors\` is \`{enabled?, monitor_tags?}\`. It also contributes two READ-ONLY
  grantable capabilities (\`GET /api/capabilities\`, module_id \`datadog\`) that
  enrich a dispatch prompt with fresh context; a grant with no config inherits the
  module's connection settings:
  - \`datadog.query_logs\`: a compact page of recent matching log lines. Config
    \`{query?, window_seconds?, limit?}\` (limit default 20, hard-max 50). On a
    \`datadog.logs.alert\` event the query (scoped to the tripped group) and window
    default off the payload so a bare grant Just Works; a configured \`query\` may
    use the \`{{...}}\` engine against the event.
  - \`datadog.get_monitor\`: one monitor's definition + current group states.
    Config \`{monitor_id?}\`; defaults to the event subject (a monitor id) when
    unset. Renders name, query, thresholds, options, states, url.

## Optional smoke-test seed content

- A product install starts EMPTY: no playbooks, rules, or notifiers ship with
  the schema.
- Example content is available as an OPTIONAL seeder, invoked explicitly with
  \`npm run seed:smoke-test\` (see the README's Testing section). It installs the \`smoke-test-clone-and-claude-linux\` playbook
  (env: \`CLAUDE_CODE_OAUTH_TOKEN\` lease-injected + \`ADO_PAT\` step-only;
  pre steps install the azure CLI, clone the org's first repo, scrub the
  credential, run a FATAL credential-leak hunt, and install the claude CLI),
  seven \`smoke test: ado.workitem.*\` dispatch rules that fire when a work
  item's \`tags\` contains the playbook name, the \`desktop\` notifier, and
  three notify rules ("Smoke test started/finished/failed") on its
  \`run.started\`/\`run.completed\`/\`run.failed\` events. The script is
  idempotent by name (a second run skips every row that already exists) and
  never overwrites a user's edits.
- Tagging any watched work item \`smoke-test-clone-and-claude-linux\` (once
  the seed is installed) fires an end-to-end pipeline test (event -> rule ->
  lease -> agent -> findings -> release) with toasts on start, success, and
  failure. The leak hunt exits non-zero (failing the dispatch loudly) if the
  scrubbed PAT is discoverable in the container env, \`~/.azure\`, git
  remote/config, or on disk.

## Portability

- \`GET /api/config/export\` (add \`?scrub=environment\` to strip machine-local
  values): one JSON document (\`schema_version\` 2): playbooks, rules (with
  their \`dispatch\` AND \`notify\` targets), notifiers, snippets, module config
  (always exported DISABLED), whitelisted settings (never \`identity_me\`);
  secrets travel as NAMES only. Notifiers preserve their \`enabled\` bit (unlike
  modules); they are reactive sinks that only fire when a matched rule
  targets them. Rule \`notify\` targets are rewritten to reference notifiers by
  NAME. 409s when a stored secret VALUE is found pasted inside a template OR
  inside a notifier's free-form \`config\` blob. Note: NOTHING in the core
  consumes notifier \`config\` today (delivery never reads it) and the leak
  scan only catches values that match a currently STORED secret, so an
  unstored credential pasted into \`config\` would slip through. Never paste
  credentials into a notifier's \`config\` at all.
- \`POST /api/config/import\` body \`{document, mode?, dry_run?}\`: \`mode\` is
  \`merge\` (default: skip name collisions) or \`overwrite\` (replace them);
  \`dry_run: true\` computes the full plan with NO writes. Notifiers are matched
  by NAME idempotently (an overwrite patches in place, preserving the local
  id so existing rule \`notify\` targets keep resolving) and rule \`notify\`
  targets rebind to the local notifier ids. Reads schema versions \`1\` and
  \`2\`; a v1 document (which had no notifiers and no rule \`notify\`) imports
  cleanly with those fields treated as empty. Returns per-object actions plus
  \`missing_secrets\` and a post-import checklist; the apply is one transaction
  (409 rolls back everything on a rule whose playbook OR notifier is
  unresolvable). ALWAYS dry-run first and show the user the plan.

## Working style

Confirm before destructive calls (DELETE, imports). After creating rules or
playbooks, offer to test them: mint a synthetic event with \`POST /api/events\`
(works on a fresh stack with no modules configured; the ADO materialize endpoint
is fine too when ADO is set up), dispatch it manually, and report the run's
outcome from \`GET /api/runs/:id\`.`;
}
