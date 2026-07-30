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

#### Foundation

- knex + better-sqlite3 database bootstrap with a migration runner, and the full
  schema: `app_settings`, `events`, `rules`, `playbooks`, `dispatches`, `runs`,
  `findings`, `run_collected`, and `module_config`.
- `events` table + repository with dedupe-cooldown suppression on `dedupe_key`.
- `rules` and `playbooks` tables + CRUD repositories.
- `dispatches`, `runs`, and `findings` tables with an atomic FIFO claim.
- Config loader (validated environment), structured logger, and per-dispatch log
  files under the OS user-data directory.

#### Wisper client

- `createLease` + `releaseLease` with typed errors.
- Synchronous exec (`execSync`) and streaming exec (`execStream`, SSE) with robust
  frame parsing.
- Shared fetch wrapper with `AbortController` and per-operation timeouts.
- Env-configurable client timeouts: `WISPER_CREATE_LEASE_TIMEOUT_MS` (default
  150000) and `WISPER_EXEC_TIMEOUT_MS` (default 60000, also the streaming
  inter-chunk idle window). Unset or invalid values fall back to the defaults, so
  behaviour is unchanged out of the box.

#### Executor

- `claude` stream-json output parsers.
- Prompt builder with `{{event.*}}` / `{{payload.*}}` / `{{env.*}}` template
  substitution.
- Dispatch pipeline state machine (`queued → leasing → running → collecting →
  done/failed`) with guaranteed lease release.
- Playbook `pre`/`collect` steps with secret masking.
- Per-dispatch timeout and startup reconciliation of orphaned dispatches.

#### Dispatcher & rules engine

- Single-flight FIFO dispatcher loop with a retry policy.
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
- Playbook env resolution and the seeded built-in `researcher` playbook.

#### REST API

- Routers for events, rules, playbooks, dispatches, runs, settings, modules, and
  secrets, plus a health probe and a per-dispatch log-tailing endpoint.

#### Web UI

- React + Vite SPA shell, routing, data layer, and Fluent UI baseline.
- Queue dashboard, Events, Rules, Playbooks, Runs (with live log), Modules, and
  Settings pages.
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
