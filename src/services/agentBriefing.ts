/**
 * The agent briefing served by `GET /api/agent-briefing` and shown on the
 * "Agent Briefing" page. A user pastes it into any AI coding agent running on
 * this machine (Claude Code, Codex, Cursor — anything that can make HTTP
 * requests) so the agent can drive this orchestrator's loopback API — creating
 * rules, playbooks, notifiers, dispatching runs — on their behalf.
 *
 * MAINTENANCE (load-bearing): this text is the ONLY thing a pasted-in agent
 * knows about the app. Whenever the operational surface changes — an endpoint
 * is added/renamed, a request/response shape changes, a setting key or runner
 * appears, template/matching semantics move — update this briefing in the same
 * change. The README ("Agent briefing" section) and CLAUDE.md both point here.
 */

export const AGENT_BRIEFING = `# Driving orchestrator via its local API (agent briefing)

You are talking to **orchestrator**, a single-user desktop app that watches
external systems (Azure DevOps), matches events against user-configured rules,
and runs data-driven playbooks inside short-lived container leases. Your job:
help the user configure and operate it over plain HTTP+JSON.

Base URL: \`http://127.0.0.1:3007/api\` (loopback only, NO auth). Verify with
\`GET /api/health\` -> \`{status:"ok", db:true, wisper:true}\` ("wisper" false means
the lease backend is down; config edits still work, runs will not).

\`GET /api/changes/stream\` is a Server-Sent Events feed of \`{resource, ts}\`
frames — one per data change (e.g. \`{"resource":"playbooks"}\`) — that the web UI
subscribes to so open pages refresh live. You do NOT need to do anything special
for the UI to update: every write you make is picked up automatically.

## Mental model (the pipeline)

producers (ADO poller) -> **events** -> **rules** (match) -> **dispatches**
(queued, one at a time) -> executor rents a container lease, runs the
playbook's steps + agent, saves a **run** with **findings** -> emits a
run-lifecycle event -> **notifiers** fire notifications.

Key invariants you must respect:
- The core is domain-neutral: all intent lives in DATA you write (rule
  criteria, prompts, templates, event-type strings) — never ask to change code.
- Requests are strictly validated: send ONLY documented keys (unknown keys are
  rejected with a 400 naming the offender).
- Secrets are write-only: you can set and reference them by NAME, never read a
  value back. Never echo a secret value the user gives you into any other field.

## Events

- \`GET /api/events?limit=N&cursor=<id>\` — newest first. \`GET /api/events/:id\`.
  Add \`?q=<text>\` to substring-search (case-insensitive) across source, type,
  subject_kind, subject_ref, and the raw payload JSON; whitespace-separated terms
  are ANDed and it composes with the cursor.
- Shape: \`{id, source, type, subject_kind, subject_ref, payload, ts}\`. Payload
  is opaque JSON from the producer.
- ADO producer events: \`ado.workitem.created/.assigned/.state_changed/
  .area_changed/.iteration_changed/.tagged/.updated\`, \`ado.pullrequest.created/
  .updated\` (source \`ado\`).
- Datadog producer events (source \`datadog\`, aggregate-driven — never one per
  log line):
  - \`datadog.logs.alert\` — a watched log query's grouped count tripped a
    statistical detector. ONE event per (watch, group) tick; rules discriminate
    on the payload, not distinct types. Payload: \`{watch, query, group_by, group,
    detectors, count, baseline, window_start, window_end, samples[], explorer_url}\`.
    \`detectors\` is a subset of \`["threshold","spike","novel"]\` (threshold =
    count>=min_count; spike = count>=spike_multiplier*trailing baseline; novel =
    first sighting of the group). Match e.g. \`payload.count gte 100\`,
    \`payload.detectors contains "spike"\`. \`subject_kind\` \`log_group\`,
    \`subject_ref\` \`<watch>/<group>\`, \`dedupe_key\` \`datadog:<watch>:<group>\`.
  - \`datadog.monitor.transition\` — a monitor (or monitor group) changed state.
    Payload: \`{monitor_id, name, query, group, from_state, to_state, url}\` (group
    \`*\` for an ungrouped monitor). Match e.g. \`payload.to_state eq "Alert"\`.
    \`subject_kind\` \`monitor\`, \`subject_ref\` \`<id>\`, \`dedupe_key\`
    \`datadog:monitor:<id>:<group>\`. The \`event_dedupe_cooldown_seconds\` setting
    then suppresses re-storms of the same subject.
- Run-lifecycle events (source \`orchestrator\`): \`run.completed\` / \`run.failed\`
  fire on terminal dispatch outcomes. Payload: \`{dispatch_id, run_id,
  playbook_id, playbook_name, rule_id, status, exit_code, error, findings,
  findings_count, collected, duration_ms, total_tokens, origin, chain_depth}\`.
  Rules can match these to CHAIN playbooks; the \`dispatch_max_chain_depth\`
  setting (default 3) caps runaway chains.

## Rules — \`GET/POST /api/rules\`, \`GET/PATCH/DELETE /api/rules/:id\`, \`POST /api/rules/:id/enable|disable\`

Body: \`{name, enabled?, match?, dispatch?, notify?}\`.
- \`match\`: \`{source?, type?, criteria?}\` — absent field = wildcard.
  - \`type\` supports \`*\` and \`prefix.*\` wildcards.
  - \`criteria\` keys are dotted paths into the event payload (\`fields.state\`),
    or \`event.<column>\` for the event row itself. Values: a scalar (strict
    equality), an array (membership), or an operator map ANDed together:
    \`eq/ne/in/nin/contains/exists\`, regex \`=~\`/\`!~\`, ordering \`gt/gte/lt/lte\`.
    The literal string \`"@Me"\` resolves to the \`identity_me\` setting.
    Malformed criteria fail closed (rule silently does not fire).
- \`dispatch\`: \`[{playbook_id, bindings?}]\` — playbooks to run on match.
- \`notify\`: \`[{notifier_id}]\` — notifiers to fire on match (not rate-capped).

## Playbooks — \`GET/POST /api/playbooks\`, \`GET/PATCH/DELETE /api/playbooks/:id\`

Body (required: name, image, ttl_seconds): \`{name, image, host?, isolation?,
ttl_seconds, resources?{cpus,memory_mb,pids}, network? ("open"|"none"),
userdata_template?, prompt_template?, runner?, runner_config?, env_requirements?,
steps?, granted_capabilities?, output_kind?}\`.
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
  against the selected host's advertised \`isolation_levels\` at dispatch time — a
  host that cannot provide it fails the dispatch BEFORE leasing (like an
  unoffered image) — and is sent on \`POST /v1/leases\`; \`dev\` mode ignores it. A
  value outside the allowed set is a \`400\` at save time.
- \`runner\` (see \`GET /api/runners\`):
  - \`claude-code\` (default): runs Claude Code in the lease against the
    rendered \`prompt_template\`. \`runner_config\`: \`{model?, allowed_tools?}\`
    (models list: \`GET /api/anthropic/models\`).
  - \`script\`: no LLM — \`runner_config.command_template\` (required) is rendered
    and run as the agent step; its stdout is the run's result text. Exit 0 =
    success. CAUTION: leases may be Windows containers (check the
    \`default_lease_image\` setting); commands then run under \`cmd /c\` and
    double quotes arrive backslash-escaped — avoid quotes/angle brackets in
    commands, or build strings in PowerShell via \`[char]34\`/\`[char]60\`.
- \`steps\`: \`[{phase: "pre"|"collect", command_template, label}]\` — \`pre\` runs
  before the agent (e.g. git clone), \`collect\` after success; collect stdout is
  saved on the run keyed by label.
- \`env_requirements\`: secret NAMES injected into the lease env; a missing
  secret fails the dispatch before leasing. Reference them in templates as
  \`{{env.NAME}}\`. IMPORTANT: the agent inside the lease only knows a variable
  exists if the prompt says so — state available env var names in
  \`prompt_template\`.
- Template substitution (prompt/userdata/step/script templates):
  \`{{event.type}}\`, \`{{event.source}}\`, \`{{event.subject_ref}}\`,
  \`{{payload.<dotted.path>}}\`, \`{{env.NAME}}\`. Unknown tokens render empty.
- Findings: an agent (or script) persists findings by printing
  \`<NOTES_TO_SAVE>[{"content":"...","visibility":"all","tags":["..."]}]</NOTES_TO_SAVE>\`.
- \`DELETE /api/playbooks/:id\` CASCADES the playbook's run history — its terminal
  dispatches, their runs, those runs' findings, and each dispatch's log file —
  then the playbook row (204). A playbook with any IN-FLIGHT (queued/leasing/
  running/collecting) dispatch is refused with 409 \`{error: "playbook has N
  in-flight dispatches"}\`; wait for those to finish first. A referencing rule is
  NOT a barrier — after the delete its dispatch target is dangling but fail-closes
  (the event just does not dispatch that target).
- \`GET /api/playbooks/:id/usage\` -> \`{dispatches, runs, findings, in_flight,
  referencing_rules: [{id, name}]}\` — the counts a delete would cascade, whether
  any dispatch is in flight, and the enabled rules that reference the playbook.

## Snippets — \`GET/POST /api/snippets\`, \`GET/PATCH/DELETE /api/snippets/:id\`

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
- \`userdata\`: a SINGLE whole-value reference — set \`userdata_template\` to
  exactly \`snippet:<name>\` (no inline mixing, no nesting).
- \`step\`: a whole saved command — set a step's \`command_template\` (or the
  \`script\` runner's \`runner_config.command_template\`) to \`snippet:<name>\`.
  Ordering the steps chains them.

A missing, renamed, or kind-mismatched reference FAILS the dispatch BEFORE any
lease is created (loudly, like a missing secret) — never silently dropped. A
rename therefore breaks every reference by design.

## Dispatches (the queue) — \`GET /api/dispatches\`, \`GET /api/dispatches/:id\`

- \`GET /api/dispatches\` lists newest-first; \`?status=\` filters to one state,
  \`?active=1\` filters to the non-terminal (queued/leasing/running/collecting)
  work. The Queue page is a QUEUE: it fetches \`?active=1\` and shows only
  waiting/in-flight dispatches. Terminal history (done/failed) lives on the
  Runs page (\`GET /api/runs\`), which links back per dispatch and offers retry.
- Add \`?q=<text>\` to \`GET /api/dispatches\` to substring-search (case-insensitive,
  whitespace-separated terms ANDed) across status, error, subject fields, event
  type, and playbook name. \`GET /api/runs\` takes the same \`?q=\` and searches
  playbook name, status, error, subject fields, and each run's result text,
  collected JSON, and findings content. Both compose with the other filters.
- Manual run: \`POST /api/dispatches\` body \`{event_id, playbook_id}\`.
- \`POST /api/dispatches/:id/retry\`; \`GET /api/dispatches/:id/log\` (full log).
- Status flow: queued -> leasing -> running -> collecting -> done | failed.
- Runs: \`GET /api/runs/:id\` -> run + collected output + findings.

## Notifiers & notifications

- \`GET/POST /api/notifiers\`, \`GET/PATCH/DELETE /api/notifiers/:id\`. Body:
  \`{name, title_template?, body_template?, enabled?, config?}\` (templates use
  the same \`{{...}}\` engine against the triggering event).
- Every fired notification is recorded in-app AND best-effort raised as a
  native desktop toast. \`GET /api/notifications\`, \`POST /api/notifications/:id/read\`,
  \`/read-all\`, \`GET /api/notifications/unread-count\`. \`GET /api/notifications\`
  takes \`?q=<text>\` to substring-search (case-insensitive, terms ANDed) across
  title, body, status, and error; it composes with the cursor and \`unread=1\`.

## Settings & secrets

- \`GET /api/settings\`, \`PUT /api/settings\` body \`{key, value}\` (whitelisted
  keys): \`default_lease_image\`, \`dispatcher_interval_seconds\`,
  \`dispatch_max_attempts\`, \`dispatch_timeout_seconds\`, \`dispatch_max_per_event\`,
  \`dispatch_max_per_hour\`, \`dispatch_max_chain_depth\`,
  \`event_dedupe_cooldown_seconds\`, \`identity_me\`, \`run_retention_max\`
  (caps kept terminal runs, default 2000; oldest beyond it are pruned with their
  findings and log files; 0 or negative disables pruning).
- Secrets: \`GET /api/secrets\` (names only), \`PUT /api/secrets\` body
  \`{key, value}\`, \`DELETE /api/secrets/:key\`. Typical names:
  \`CLAUDE_CODE_OAUTH_TOKEN\`, \`ADO_PAT\`, \`GIT_TOKEN\`, \`DD_API_KEY\`,
  \`DD_APP_KEY\`, \`WISPER_API_KEY\`.
- \`GET /api/settings/system\` -> read-only boot facts the UI shows next to the
  editable settings: \`{wisperBaseUrl, wisperHostId (null when unset), wisperMode
  ("dev"|"v1"), wisperApiKeyPresent (boolean — WHETHER the \`WISPER_API_KEY\`
  secret is set, never its value)}\`.
- \`GET /api/wisper/hosts\` -> the rentable host catalog for the playbook Host
  picker, fetched SERVER-SIDE so the API key never reaches the client:
  \`{hosts: [{id, name, os, online, images: [{id, name, price_cents_per_min}]}], warning?}\`.
  In \`v1\` mode it reads \`GET /v1/catalog\` with the bearer token; in \`dev\` mode it
  returns a single synthetic entry for \`WISPER_HOST_ID\`. DEGRADES like
  \`GET /api/anthropic/models\` — always 200, empty list + \`warning\` on any failure.
- Lease backend mode (boot env \`WISPER_MODE\`, default \`dev\`): \`dev\` speaks the
  unauthenticated local \`/dev/leases\` harness. \`v1\` speaks the authenticated
  \`/v1/leases\` consumer surface, sending \`Authorization: Bearer <WISPER_API_KEY>\`
  (resolved from the secret store at call time — set the \`WISPER_API_KEY\` secret
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

## Modules (integration producers)

- \`GET /api/modules\`, \`GET/PUT /api/modules/ado/config\` (org, project,
  pat_secret_ref, enabled, interval_seconds, watched, pull_requests),
  \`POST /api/modules/ado/backfill\`. Discovery pickers under
  \`/api/modules/ado/discovery/*\`. The ADO integration is READ-ONLY.
- \`GET/PUT /api/modules/datadog/config\` (enabled, site — a bare domain like
  \`us5.datadoghq.com\`, default \`datadoghq.com\`; api_key_secret_ref,
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
  enrich a dispatch prompt with fresh context — a grant with no config inherits the
  module's connection settings:
  - \`datadog.query_logs\` — a compact page of recent matching log lines. Config
    \`{query?, window_seconds?, limit?}\` (limit default 20, hard-max 50). On a
    \`datadog.logs.alert\` event the query (scoped to the tripped group) and window
    default off the payload so a bare grant Just Works; a configured \`query\` may
    use the \`{{...}}\` engine against the event.
  - \`datadog.get_monitor\` — one monitor's definition + current group states.
    Config \`{monitor_id?}\`; defaults to the event subject (a monitor id) when
    unset. Renders name, query, thresholds, options, states, url.

## Portability

- \`GET /api/config/export\` (add \`?scrub=environment\` to strip machine-local
  values) / \`POST /api/config/import\` — playbooks, rules, module config,
  settings; secrets travel as names only.

## Working style

Confirm before destructive calls (DELETE, imports). After creating rules or
playbooks, offer to test them with a manual dispatch against a recent event and
report the run's outcome from \`GET /api/runs/:id\`.`;
