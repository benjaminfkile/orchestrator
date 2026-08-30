# Changelog

All notable changes to orchestrator are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The initial MVP: an event-driven lease orchestrator that watches external systems,
matches events against user-configured rules, and runs data-driven playbooks
inside short-lived wisper leases. Two principles hold throughout — the code never
knows what it is running (behaviour is data, not branches), and the orchestrator
owns the lease lifecycle, never the agent inside it.

### Added

#### Pull requests

- `ado.pullrequest.*` payloads carry `is_draft`; `.updated` fires when a PR's
  draft flag changes and includes `previous_is_draft`.
- New listen-only events: `ado.pullrequest.pushed` (per iteration, with changed
  files), `.comment.created` (top-level and replies), `.thread.status_changed`,
  `.vote`, `.completed`, `.abandoned`.

#### Foundation

- knex + better-sqlite3 database bootstrap with a migration runner (migrations
  are registered explicitly in `src/db/migrations/index.ts`, not discovered from
  the filesystem), and the full schema: `app_settings`, `events`, `rules`,
  `playbooks`, `dispatches`, `runs`, `findings`, `module_config`, `notifiers`,
  `notification_log`, and `snippets` (plus additive columns: `runs.collected`,
  `playbooks.granted_capabilities`/`runner`/`runner_config`/`host`/`isolation`,
  `rules.notify`, `dispatches.released_at`/`release_pending`).
- `events` table + repository with dedupe-cooldown suppression on `dedupe_key`.
- `rules` and `playbooks` tables + CRUD repositories.
- `dispatches`, `runs`, and `findings` tables with an atomic FIFO claim.
- Config loader (validated environment), structured logger, and per-dispatch log
  files under the OS user-data directory.
- Single `ORCH_DATA_DIR` base for all on-disk state: the SQLite DB file, the
  per-dispatch log directory, and the encrypted secret store all resolve
  against it, so a launcher that sets `ORCH_DATA_DIR` keeps every piece of
  state in one folder. Used verbatim (no `orchestrator` subdirectory is
  appended); unset falls back to the OS user-data dir with an `orchestrator`
  subdirectory. `ORCH_DB_PATH` still overrides ONLY the DB file. The resolved
  paths are logged once at boot as `{dbPath, logsDir, secretsDir}`.

#### Wisper client

- `createLease` + `releaseLease` with typed errors.
- Synchronous exec (`execSync`) and streaming exec (`execStream`, SSE) with robust
  frame parsing.
- Shared fetch wrapper with `AbortController` and per-operation timeouts.
- Env-configurable client timeouts: `WISPER_CREATE_LEASE_TIMEOUT_MS` (default
  150000), `WISPER_EXEC_TIMEOUT_MS` (an explicit operator override; UNSET by
  default), and `WISPER_RELEASE_TIMEOUT_MS` (default 60000). When
  `WISPER_EXEC_TIMEOUT_MS` is unset the executor derives the per-call exec
  timeout (and the streaming inter-chunk idle window) at dispatch time from
  the lease's REMAINING TTL plus a small margin, capped at about 6 hours, so
  a step or agent command that runs the length of a lease is not killed at
  a fixed 60 seconds. An explicit value wins over the computed default. The
  lease-release path (executor finally block, boot's orphan reconcile, the
  periodic release sweep, and the dispatcher's late release before a
  retryable requeue) has its own separate short timeout
  `WISPER_RELEASE_TIMEOUT_MS` so a hung release socket cannot stall boot or
  a sweep pass for hours the way the exec-timeout cap would. Unset or
  invalid values fall back to their respective defaults, so behaviour is
  unchanged out of the box for normal workloads.
- Dispatch logs now record the resolved per-call exec timeout on the
  dispatch header line and on every pre/agent/collect step start line, so
  an operator can see the ceiling that bounded each exec without
  cross-referencing config.

#### Executor

- `claude` stream-json output parsers.
- Prompt builder and shared template engine with `{{event.*}}` /
  `{{payload.*}}` substitution, plus an `{{env.*}}` root for step commands,
  `userdata_template`, `prompt_template`, `prompt`-kind snippet content, and
  the script runner's command template. `prompt_template`, `userdata_template`,
  and `prompt`-kind snippet content render against the LEASE-injectable env
  only, so a `{name, inject: "step-only"}` secret never reaches the lease (via
  userdata) or the prompt the agent sees.
- Runner seam (`src/runners/`): a playbook names its `runner` (`claude-code`,
  the default, or `script`, which runs a rendered `runner_config.command_template`
  as the agent step with no LLM) and carries an opaque `runner_config`;
  `GET /api/runners` lists the ids. The claude-code runner delivers the prompt
  as an argv argument on linux and via the `ORCH_AGENT_PROMPT` lease env var on
  windows leases (prompts over 30000 chars fail a windows dispatch).
- Snippets: reusable `prompt` / `userdata` / `step` template fragments
  (`snippets` table, `/api/snippets`) resolved at dispatch time; a missing or
  kind-mismatched reference fails the dispatch before leasing.
- Per-playbook `host` selector and `isolation` level (`shared`/`sandboxed`/`vm`);
  in `v1` mode both are resolved against `GET /v1/catalog` before leasing.
- Dispatch pipeline state machine (`queued → leasing → running → collecting →
  done/failed`) with guaranteed lease release.
- Playbook `pre`/`collect` steps with secret masking.
- Per-dispatch timeout and startup reconciliation of orphaned dispatches.
- Lease-release tracking: `released_at`/`release_pending` on every dispatch,
  bounded in-line release retries in the executor, and a release sweep
  (one-shot at boot, periodic while the dispatcher runs, plus an emergency
  sweep on fatal process errors) that reattempts release for dispatches whose
  lease is still owed; a wisper `not_found` counts as released.
- The sweep touches TERMINAL (done/failed) dispatches only — an in-flight
  dispatch's lease is owned by its own pipeline and is never released out from
  under it.
- `resetToQueued` and the manual retry endpoint clear release tracking
  alongside the lease handles, so a stale timestamp from a prior attempt can
  no longer hide a leaked lease from the sweep; the retry endpoint refuses
  (409) while a failed dispatch still holds an unreleased lease.

#### Dispatcher & rules engine

- Single-flight FIFO dispatcher loop with a retry policy.
- `run.started` run-lifecycle event: emitted each time a claimed dispatch is
  handed to the executor, payload mirroring the terminal events minus
  terminal-only fields; chain-depth capped like `run.completed`/`run.failed`.
- A retryable failure holding an unreleased lease is never requeued: the
  dispatcher attempts one final inline release and otherwise leaves the row
  terminal `failed` with `release_pending` set for the sweep, so the lease
  handle is never dropped.
- Pure, fail-closed rule matcher with a full operator set.
- Event→dispatch wiring with per-event and per-hour caps.
- Optional run-budget gate: `run_budget_per_hour` over a
  `run_budget_window_minutes` rolling window defers (never drops) queued
  dispatches once that many runs have STARTED in the window; over-budget work
  stays `queued` and drains FIFO as the window slides. A secondary, reactive
  `token_budget_per_window` circuit breaker pauses claiming while summed
  in-window run tokens exceed the budget. Disabled by default; the intake
  `dispatch_max_per_hour` overflow valve is unchanged. Queued dispatches held by
  the gate expose an additive `waiting_reason: "budget"` (with
  `window_count`/`budget`/`next_eligible_at`) on the dispatches API and a
  "budget hold" indicator in the Queue UI.
- Run-history retention: the `run_retention_max` setting (default 2000) caps how
  many TERMINAL dispatches (done/failed) are kept. The oldest beyond the cap are
  pruned — their runs, findings, and per-dispatch log files — in FK-safe batched
  transactions, after each terminal transition and once at boot. Non-terminal
  dispatches, events, and the notification log are never touched; pruning is
  best-effort and never fails a dispatch. Set 0 or negative to disable it.

#### Module framework

- Module + producer registries and an interval/manual trigger scheduler.
- Per-module config storage that reconciles producer triggers on write.

#### Azure DevOps module

- Read-only ADO REST client.
- Watched-query WIQL builder (pure, config-driven).
- Work-item poller producer with silent-seed snapshot diffing.
- `ado.get_work_item` fetch capability (degrades to a note, never throws).
- `ado.query_work_items` capability: a bounded, labelled work-item table from a
  config-driven WIQL filter (`top` default 100, hard max 500).
- `ado.sprint_rollup` capability: a current-sprint summary (counts by state/type
  plus at-risk, unassigned, and in-review lists), built on `ado.query_work_items`.
  Both are read-only and degrade to a note on any ADO error.
- `ado.get_work_item_links` capability: the subject's ancestors, children,
  related items, and attachment pointers as a size-capped block (default 8000
  chars), with an authenticated download hint only when the PAT env var is
  among the playbook's `env_requirements`.
- Pull-request producer (`ado.pullrequest`): polls the project's active PRs,
  optionally filtered by creator, and emits `ado.pullrequest.created` /
  `.updated` with the repo clone URL and branches.
- `POST /api/modules/:id/backfill`: replays the currently watched work items
  through normal intake as `ado.workitem.created` events without touching the
  poller's snapshot.
- ADO discovery endpoints (`/api/modules/ado/discovery/*`, `/identity/me`)
  backing the SPA's cascading pickers; a PAT lacking scope degrades a list to
  `200 []` with an `X-Ado-Restricted` header.

#### Datadog module

- Read-only Datadog client (log aggregate/search, monitor states) with
  shape-validated module config.
- `datadog.logwatch` producer: per-watch grouped counts with threshold, spike,
  and novel-group detectors emitting one `datadog.logs.alert` per tripped group.
- `datadog.monitor` producer: emits `datadog.monitor.transition` on a monitor or
  group state change against a known prior state.
- `datadog.query_logs` and `datadog.get_monitor` capabilities (read-only,
  degrade to a note).

#### Notifications

- Notifiers (`notifiers` table, `/api/notifiers`) and rule `notify` targets: a
  fired notifier always records one `notification_log` row and best-effort
  raises a native desktop toast (PowerShell WinRT on Windows, `osascript` on
  macOS, `notify-send` on Linux). There are no delivery kinds.
- Notification inbox API (`/api/notifications`, unread count, mark read, SSE
  stream) and the in-app bell.

#### Portability

- `GET /api/config/export` / `POST /api/config/import`: a portable document
  (`schema_version` 2) of playbooks, rules with their `dispatch` AND `notify`
  targets, notifiers (referenced by name from `notify` targets), snippets,
  module config (exported disabled), and whitelisted settings with secrets as
  names only; import supports merge / overwrite and dry-run and applies in one
  transaction. Notifiers preserve their `enabled` bit (they are reactive
  outbound sinks that only fire when a matched rule targets them, so they
  cannot poll or dispatch on their own). Notifier `config` is a free-form blob
  and **nothing in the core consumes it today** (delivery never reads it); the
  exporter's leak scan only catches values that MATCH a currently STORED
  secret, so an unstored credential pasted into `config` would slip through.
  Do NOT paste credentials into a notifier's `config` at all. The importer
  reads both **v2** and **v1** documents; a v1 document (which had no
  notifiers and no rule `notify` field) imports cleanly, with those fields
  defaulting to empty.
- Work-item event payloads carry the human web-UI `url`
  (`_apis/wit/workItems/{id}` → `_workitems/edit/{id}`, host/org/project
  preserved) so a click opens the item rather than raw REST JSON; the original
  API url is kept as `api_url`. The transform is ADO-specific and lives in the
  module. A scoped data migration rewrites the `url` of existing `ado` events
  whose payload matches that pattern, leaving all other payloads untouched.
- On-demand work-item picker: `GET /api/modules/ado/discovery/workitems?q=` runs
  a project-scoped title search (plus an exact-id lookup when `q` is a positive
  integer), capped at 25 rows shaped like the poller payload. Read-only.
- Single-item materialize: `POST /api/modules/ado/workitems/:id/materialize`
  fetches one work item and records it as a single `ado.workitem.manual` event
  with the poller-identical payload — no dedupe, rule matching skipped — so a
  playbook can be dispatched against it manually (`404` if the item is absent).
  The poller's payload builder is extracted to a shared module and reused, so a
  materialized event is byte-for-byte the shape a poll tick emits.

#### Secrets & playbooks

- Encrypted-at-rest secret store with a keychain-backed key (passphrase fallback).
- Playbook env resolution and the seeded first-launch
  `smoke-test-clone-and-claude-linux` playbook (which replaced the earlier
  `researcher` seed).
- Step-only secrets: an `env_requirements` entry may be
  `{name, inject: "step-only"}` — resolved for server-side template rendering
  (and log masking) but never injected into the lease environment.
- The seeded first-launch smoke test: the playbook (ADO clone via step-only
  `ADO_PAT`, credential scrub, fatal credential-leak hunt, claude run), seven
  tag-gated `ado.workitem.*` dispatch rules, a `desktop` notifier, and notify
  rules on its `run.started`/`run.completed`/`run.failed` events; the seed
  replaces the `researcher` playbook only when it is still pristine and
  unreferenced.
- The seeded install-claude step falls back to the CLI's native installer when
  npm is absent, symlinking the binary onto the default PATH; the linux
  `claude-code` runner prefixes `IS_SANDBOX=1` so the CLI runs under wisp's
  root execs.

#### REST API

- Routers for events, rules, playbooks (with `/usage` and a cascading delete),
  dispatches (manual `POST`, `/retry`), runs, settings (`/system`), modules,
  secrets, notifiers, notifications, snippets, runners, capabilities, the
  Anthropic model list, the wisper host catalog, the agent briefing, the
  `/api/changes/stream` SSE feed, and config export/import, plus a health probe
  and a per-dispatch log-tailing endpoint. Free-text `?q=` search on events,
  dispatches, runs, and notifications.

#### Web UI

- React + Vite SPA shell, routing, data layer, and Fluent UI baseline.
- Queue dashboard, Events, Rules, Playbooks, Snippets, Runs (with live log),
  Modules, Notifications, Notifiers, Agent Briefing, and Settings pages; live
  refetch off the change stream; System / Light / Dark theme; responsive
  layout with a collapsible nav rail.
- App-wide system-status banner surfacing the two boot-config dead-ends that
  silently disable leasing: v1 mode with no `WISPER_API_KEY` secret, and an
  unset `WISPER_HOST_ID`; session-dismissable, clears live when the missing
  value is stored.
- Per-entry "Step-only" toggle on the playbook Env requirements editor.
- `SubjectCell` renders the triggering subject as a flex stack — a leading,
  colour-tinted type icon (a presentation-layer registry keyed by event-source
  prefix and the opaque `subject_type`; ADO Bug/User Story/Epic/Task/Initiative
  glyphs with a neutral fallback) plus the title, both wrapped in the same
  external link when a url is present — with ellipsis truncation and a hover
  tooltip. The event type sits on its own secondary line (Runs) or its dedicated
  column/row (Queue, run detail), so the title and event type never overlap.

#### Tests & docs

- End-to-end fake-wisper integration test of the full MVP flow.
- README architecture refresh, configuration/module reference tables, and a local
  bring-up runbook; this changelog.

[Unreleased]: https://github.com/benjaminfkile/orchestrator/commits/main
