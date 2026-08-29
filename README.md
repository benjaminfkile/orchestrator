# orchestrator

Event-driven lease orchestrator. It watches external systems (Azure DevOps
first), matches what it sees against user-configured **rules**, and runs
data-driven **playbooks** (e.g. the seeded first-launch smoke test) inside
short-lived container **leases** rented from a locally running [wisper-api](https://github.com/benjaminfkile/wisper-api)
(which brokers them down to [wisp](https://github.com/benjaminfkile/wisp) via
[wisp-agent](https://github.com/benjaminfkile/wisp-agent)).

It is a **single-user desktop app**: an Express + better-sqlite3/knex backend and
a React + Vite SPA in `web/`. The API binds `127.0.0.1` with **no auth layer** —
the OS user is the security boundary — so it must never be exposed off-loopback.

Two load-bearing design rules govern the whole system:

- **The code never knows what it is running.** The core and every integration
  module are domain-neutral: no `PR`, `work_item`, `bug`, or `review` lives in a
  code branch. Behaviour is defined entirely by data — a playbook's prompt, its
  granted capabilities' config, and event payloads. Intent words appear only in
  user config, prompts, and user-chosen event-type strings.
- **The orchestrator owns the lease, never the agent.** Lease creation, every
  step inside a lease, and lease termination are driven by orchestrator code. The
  agent's only job is to do its work and exit; the executor provisions, executes,
  collects, and **always** releases (the lease TTL is only a crash failsafe).

## Architecture

The pipeline is a straight line from an observed change to a released lease:

```
Producers (ADO poller)        Rules engine            Dispatch queue (FIFO)
  runWiql + snapshot diff  →   match source/type/  →   one row = one lease
       │                       criteria, apply caps         │
       ▼                            ▲                        ▼
    Events ──────────────────────────                    Executor (state machine)
    {source, type, subject_kind,                            │  createLease (userdata provisions)
     subject_ref, payload, dedupe_key}                      │  pre steps  (git clone, …)
                                                            │  agent step (claude stream-json)
                                                            │  collect steps → findings/output
                                                            ▼  ALWAYS releaseLease
                                        wisper-api /dev/leases (local)
                                                            │
                                          wisp-agent → wisp → container
```

### Producers → Events

Integration modules contribute **producers** (a query + a trigger). The ADO
work-item poller runs a watched WIQL query on each tick, batch-fetches the
matching items, and **diffs** them against an in-memory snapshot. A second ADO
producer polls the project's **active pull requests** and diffs them the same
way. The first tick after start (or any config change) seeds each snapshot
**silently** so a restart never replays the whole board (or every open PR). Every
ADO call is read-only; the only output is generic `events` rows. Emitted event
types are the sole place a domain word may appear: `ado.workitem.created`,
`.assigned`, `.state_changed`, `.area_changed`, `.iteration_changed`, `.tagged`,
`.updated`, and — from the PR producer — `ado.pullrequest.created` / `.updated`.

Events carry `{source, type, subject_kind, subject_ref, payload, dedupe_key}`.
Intake dedupes within a cooldown window (`event_dedupe_cooldown_seconds`) keyed
on `dedupe_key`, so a poller that re-observes the same state does not re-fire.

### Events → Rules → Dispatches

The **rules engine** (`src/services/ruleEngine.ts`) is a pure, total, fail-closed
matcher. A rule's `match` has three optional parts — `source`, `type`, and
`criteria` — and each absent part is a wildcard:

- `source` — exact string equality against the event's source.
- `type` — `*` (any), `prefix.*` (matches `prefix` or `prefix.<anything>`), or an
  exact string.
- `criteria` — a `{ path: { operator: operand } }` map. Paths are dotted into
  `event.payload` by default; an `event.` prefix reads the event row instead
  (`event.subject_ref`). Supported operators: `eq`/`=`/`==`, `ne`/`!=`/`<>`,
  `in`, `nin`/`not_in`, `contains`/`has`, `regex`/`=~`/`matches`,
  `!~`/`not_matches`, `gt`/`>`, `gte`/`>=`, `lt`/`<`, `lte`/`<=`, `exists`. An
  unknown operator, a malformed regex, or a type mismatch fails **closed** (the
  criterion simply does not match) — a misconfigured rule declines to fire, it
  never crashes the path. The literal operand `"@Me"` resolves to the
  `identity_me` setting before comparison.

A matching rule names one or more `dispatch` targets (`{playbook_id, bindings}`).
Event→dispatch wiring enqueues one dispatch per target, guarded by caps
(`dispatch_max_per_event`, `dispatch_max_per_hour`).

### Dispatches → Executor → wisper

**Dispatches** are the durable FIFO queue; one dispatch = one lease lifecycle. A
dispatch starts `queued`, is atomically claimed into `leasing`, then advances
through `running` → `collecting` to a terminal `done` or `failed`. The
**dispatcher** (`src/services/dispatcher.ts`) is a single-flight loop
(concurrency is clamped to 1 for now) that claims the oldest `queued` dispatch,
runs it, and applies a retry policy (`dispatch_max_attempts`) on retryable
failures. On boot, `reconcileOrphanedDispatches` fails anything left mid-pipeline
by an unclean shutdown and releases the leases it still held; a one-shot release
sweep then runs before any new dispatch, and process-level
`unhandledRejection`/`uncaughtException` handlers run a last-chance emergency
sweep (bounded to a few seconds) before exiting.

The **executor** (`src/executor/executor.ts`) is the pipeline state machine:

1. Resolve the playbook's `image` (a `setting:<key>` reference is looked up in
   `app_settings` at dispatch time) and its `env_requirements` secret names (a
   missing secret fails the dispatch *before* any lease is rented, reporting only
   the missing names). In `v1` mode the playbook's `host` selector (default:
   `WISPER_HOST_ID`) and image name are also resolved against the wisper catalog
   to concrete ids here, before leasing.
2. `createLease` — provisioning runs in the lease `userdata`; the `POST
   /dev/leases` 201 does not return until the lease is ready.
3. Run each `pre` step as an exec (e.g. `git clone …` using a rendered or
   injected token).
4. Run the agent step: a fixed `claude --print --dangerously-skip-permissions
   --output-format stream-json --verbose` invocation (prefixed `IS_SANDBOX=1`
   on linux so the CLI accepts the flag under wisp's root execs), plus the playbook's
   optional `--model`/`--allowedTools`, with the composed prompt as the trailing
   argument. Its streamed exit code is the completion signal.
5. On exit 0, run `collect` steps and persist their captured output plus any
   `<NOTES_TO_SAVE>` findings the agent emitted.
6. **Always** `DELETE /dev/leases/:id` (`/v1/leases/:id` in v1 mode), on every
   path including failure and timeout. The release is retried inline with
   bounded backoff (200 ms/500 ms; a wisper `not_found` counts as released);
   on exhaustion the dispatch is flagged `release_pending` and the **release
   sweep** — once at boot plus every 60 s while the dispatcher runs — retries
   it. The sweep touches only TERMINAL (`done`/`failed`) rows: an in-flight
   dispatch's lease is owned by its own pipeline. Every dispatch records
   `released_at`/`release_pending`, and a dispatch is never requeued (retry
   policy or manual `/retry`) while it still holds an unreleased lease. A
   per-dispatch hard deadline
   (`min(ttl_seconds − margin, dispatch_timeout_seconds)`) tightens the TTL.

The **wisper client** (`src/wisper/client.ts`) wraps the lease endpoints:
`createLease`, `execSync`, `execStream` (SSE exec with robust frame parsing,
terminating on the `exit` event), and `releaseLease`, all over a shared fetch
wrapper with an `AbortController`. Secrets reach the container only via the
`env` field and are masked in logs.

The client speaks one of two surfaces, chosen by `WISPER_MODE` (default `dev`):

- **`dev`** — the unauthenticated local harness: `POST /dev/leases`,
  `POST /dev/leases/:id/exec[?stream=1]`, `DELETE /dev/leases/:id`
  (`?hostId=` selects the host). No auth header.
- **`v1`** — the authenticated consumer surface: `POST /v1/leases`
  (snake-case body with catalog `host_id`/`host_image_id`),
  `POST /v1/leases/:id/exec[?stream=1]`, `DELETE /v1/leases/:id` (lease
  ownership comes from the principal, so no `hostId`). A playbook still names its
  image (and, optionally, a host) by **name**; before leasing, the client resolves
  the (host selector, image name) pair against `GET /v1/catalog` (cached in-process
  ~60s; a failed fetch is not cached) into the `host_id`/`host_image_id` the body
  needs. The selector matches a catalog host's **id or name**; the image matches
  an offered `image_ref`. An unknown host, an offline host (absent from the
  catalog), or an image the host does not offer fails the dispatch **before**
  leasing (`image X is not offered by host Y`) — the same loud, pre-lease
  semantics as a missing secret. Every request carries
  `Authorization: Bearer <WISPER_API_KEY>`, where the key is resolved from the
  secret store **at call time** (never `process.env`) and never logged. A
  missing key, or a `401`/`403`, is a terminal (never-retried) error naming
  `WISPER_API_KEY`; a `402` is a terminal `insufficient_funds` error carrying
  the required/available cents. `host_offline`/`upstream_timeout` stay
  retryable, exactly as in `dev`.

The public client interface is identical in both modes, so the executor is
mode-agnostic. Note that in `v1` mode the create body deliberately carries no
`resources`/`gpus` — sizes are fixed server-side by the selected catalog offer;
a playbook's `resources` parameterize only the dev-mode body.

### Snippets (reusable template fragments)

**Snippets** (`snippets` table, `src/db/snippets.ts`, `/api/snippets`) are
reusable, user-authored template fragments resolved at **dispatch time**, so
editing one propagates to every playbook that references it. A snippet is
`{kind, name, description, content}` and `name` is unique **within** a `kind`.
The `kind` column partitions the store into three DIFFERENT composition models
(the coupling is intentional — see `CLAUDE.md`'s architecture principle: intent
lives entirely in the name/description/content, never in a code branch):

- **`prompt`** — STACKABLE `{{snippet.<name>}}` tokens inside a
  `prompt_template`. This token mechanic is EXCLUSIVE to prompts. A prompt
  snippet's `content` is itself rendered with the full template context
  (`event`/`payload`/`env` **and** further `{{snippet.*}}` tokens), so snippets
  nest; the executor resolves them iteratively with a depth cap (5) and cycle
  detection before leasing. An **unknown** snippet name FAILS the dispatch (a
  deliberate deviation from the engine's unknown-token-renders-empty rule —
  silently dropping prompt text is unacceptable).
- **`userdata`** — a SINGLE whole-value reference: set `userdata_template` to
  exactly `snippet:<name>` (mirroring the image field's `setting:` pattern). No
  inline mixing, no nesting; the resolved content is then rendered by the normal
  template engine.
- **`step`** — a whole saved command: set a step's `command_template` (or the
  `script` runner's `runner_config.command_template`) to `snippet:<name>`.
  Ordering the steps chains them.

References are BY NAME, so a rename (or re-kind) BREAKS every reference to a
snippet — **by design**. There is no back-reference bookkeeping: a missing,
renamed, or kind-mismatched reference FAILS the dispatch **before any lease is
created**, loudly (`unknown <kind> snippet "<name>"`), exactly like a missing
secret — never silently dropped.

### Run-lifecycle callbacks

The dispatcher feeds two kinds of generic events back into the orchestrator's
own intake (`src/services/runEvents.ts`) so rules can react to a dispatch's
lifecycle and notify or chain further playbooks. This is a callback built from
existing machinery — no new tables, no new transport.

- **`run.started`**: fires each time the dispatcher hands a **claimed** dispatch
  to the executor, so a dispatch that is retried emits it once per attempt.
  Dispatches that never start (dropped by a cap, held by the run/token budget
  gate, or blocked by the chain-depth cap) emit nothing.
- **`run.completed`** — fires on a terminal `done`.
- **`run.failed`** — fires on a terminal `failed` (never before a retry — only
  the final give-up emits). One exception to "retries continue": a retryable
  failure whose lease release keeps failing is converted to terminal `failed`
  early (the dispatcher refuses to requeue a row still holding an unreleased
  lease; the release sweep then owns the release) and emits `run.failed` then.

Every callback event carries `source` **`orchestrator`**, copies the originating
event's `subject_kind`/`subject_ref`, and has a null `dedupe_key`. `run.started`
carries a start-time subset of the terminal payload — no `status`, `exit_code`,
`error`, `findings`, `findings_count`, `collected`, `duration_ms`,
`total_tokens`, or `run_id` (nothing is created until the run actually finishes):

| Payload field | Meaning |
|---|---|
| `dispatch_id` | The dispatch. |
| `run_id` | Latest run's id, or `null` if the dispatch failed before any run opened (terminal only). |
| `playbook_id` · `playbook_name` | The dispatched playbook (`playbook_name` `null` if it was deleted). |
| `rule_id` | Rule that enqueued the dispatch, or `null` for a manual dispatch. |
| `status` | `"done"` or `"failed"` — mirrors the event type (terminal only). |
| `exit_code` | The agent step's exit code, or `null` (terminal only). |
| `error` | The dispatch's failure message, or `null` (terminal only). |
| `findings` | Array of `{content, tags}` findings the run recorded (terminal only). |
| `findings_count` | Number of findings — handy as a criterion (terminal only). |
| `collected` | The run's collected output, or `null` (terminal only). |
| `duration_ms` · `total_tokens` | Run duration and summed token usage, or `null` (terminal only). |
| `origin` | `{event_id, source, type, subject_kind, subject_ref}` of the triggering event. |
| `chain_depth` | One greater than the originating event's depth — the loop guard. |

**Chain-loop guard.** Because a `run.*` event can itself match a rule that
dispatches another run, every run-lifecycle callback — `run.started` included —
increments `chain_depth`, and intake's `dispatch_max_chain_depth` gate (default
**3**) creates **no** dispatches once an event's `chain_depth` reaches the cap —
so a react-to-your-own-run rule cannot loop forever. Events without a numeric
`chain_depth` (every producer event) are treated as depth 0.

Example rule that chains a second playbook off a completed run only when it
produced findings:

```json
{
  "name": "escalate runs that found something",
  "enabled": true,
  "match": {
    "source": "orchestrator",
    "type": "run.completed",
    "criteria": { "findings_count": { "gt": 0 } }
  },
  "dispatch": [{ "playbook_id": 2 }]
}
```

## REST API

All routes are under `/api`, loopback only, JSON in/out. Errors render as
`{ error }`.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Liveness probe: `{ status, db, wisper }` (wisper `/healthz` probed with a 2 s timeout, cached 30 s). |
| `GET /api/events` · `GET /api/events/:id` | List / read stored events. The list is newest-first and cursor-paginated: `?limit=` (1..500, default 50), `?before=<id>` pages past an id, and `?q=` substring-searches (case-insensitive, whitespace-separated terms ANDed) across source, type, subject fields, and the raw payload JSON. |
| `POST /api/events` | Mint a synthetic event through the normal intake so a dispatch can be created on a fresh stack that has no integration modules configured. Body: `{ source? (default "manual"), type (required, e.g. "test.manual"), subject_ref (required), subject_kind? (default "manual"), payload? (JSON object) }`. A deterministic `dedupe_key` of `manual:<source>:<type>:<subject_ref>` is applied so the normal `event_dedupe_cooldown_seconds` cooldown collapses repeats: a first mint returns `201` with the created event; a mint that lands inside the cooldown returns `200` with the existing event. Rules match the minted event exactly as if a producer had emitted it. |
| `GET /api/events/facets` | Distinct `source` + `type` values (DB distincts merged with the registered modules' advertised event types), for the Events filters and Rule source/type pickers. |
| `GET /api/rules` · `GET /api/rules/:id` | List / read rules. |
| `POST /api/rules` · `PATCH /api/rules/:id` | Create / update a rule. |
| `DELETE /api/rules/:id` | Delete a rule (204). 409 `{error: "rule has N in-flight dispatches"}` while any dispatch created by this rule is queued/leasing/running/collecting. On success the terminal dispatches that referenced the rule have their `rule_id` set to null so the run history stays readable. |
| `POST /api/rules/:id/enable` · `POST /api/rules/:id/disable` | Toggle a rule. |
| `GET /api/playbooks` · `GET /api/playbooks/:id` | List / read playbooks. |
| `POST /api/playbooks` · `PATCH /api/playbooks/:id` | Create / update a playbook (unknown body keys and a duplicate `name` are rejected: 400 / 409). |
| `DELETE /api/playbooks/:id` | Delete a playbook AND cascade its terminal run history (dispatches, runs, findings, per-dispatch log files); 409 `{error: "playbook has N in-flight dispatches"}` while any dispatch is queued/leasing/running/collecting. A rule that still references the playbook is not a barrier; its dangling target simply never dispatches. |
| `GET /api/playbooks/:id/usage` | `{dispatches, runs, findings, in_flight, referencing_rules: [{id, name}]}`: what a delete would cascade and the enabled rules that reference the playbook. |
| `GET /api/dispatches` · `GET /api/dispatches/:id` | Read the dispatch queue (newest-first). `?status=` filters to one state, `?active=1` to the non-terminal work (queued/leasing/running/collecting), `?q=` substring-searches status, error, subject fields, event type, and playbook name. `GET /:id` embeds the dispatch's runs, each with its findings. A queued dispatch held by the run/token budget gate is annotated with `waiting_reason: "budget"` plus `window_count`/`budget`/`next_eligible_at`. |
| `POST /api/dispatches` | Manually queue a playbook against an event: `{event_id, playbook_id}` → 201 with the created `queued` dispatch (`rule_id` null). No rule matching; 404 if either id is unknown. Bypasses the per-event cap. |
| `GET /api/dispatches/:id/log` | Tail the per-dispatch log as chunked `text/plain`: current content, then appended bytes, until the dispatch is terminal or the client disconnects; 404 until the log file exists. |
| `POST /api/dispatches/:id/retry` | Requeue a `failed` dispatch (attempts reset) and kick the dispatcher; 409 unless the status is `failed`, and 409 while the dispatch still holds an unreleased lease (the release sweep must resolve it first). |
| `GET /api/runs` | Run history, newest-first: one row per dispatch with its latest run's outcome joined in. `?status=` filters to a dispatch status, `?limit=` (1..1000, default 200) caps rows, `?q=` substring-searches playbook name, status, error, subject fields, and each run's result text, collected output, and findings content. |
| `GET /api/runs/:id` | Read a run with its collected output, findings, and the triggering event's subject fields. |
| `GET /api/notifiers` · `GET /api/notifiers/:id` | List / read notifiers (outbound sinks). |
| `POST /api/notifiers` · `PATCH /api/notifiers/:id` · `DELETE /api/notifiers/:id` | Create / update / delete a notifier (`name` required; `config`/templates optional; there is no delivery `kind`). |
| `GET /api/notifications` | Notification-log inbox, newest-first, cursor-paginated (`limit`≤500, default 50; `cursor`); `unread=1` restricts to unread rows; `?q=` substring-searches title, body, status, and error. |
| `GET /api/notifications/unread-count` | `{ count }` of rows not yet marked read. |
| `GET /api/notifications/stream` | Server-Sent Events: one `data:` frame per newly written notification row (heartbeat comment keeps it warm). |
| `POST /api/notifications/:id/read` · `POST /api/notifications/read-all` | Mark one row / every unread row read (`read-all` → `{ updated }`). |
| `GET /api/snippets` · `GET /api/snippets/:id` | List / read reusable template snippets. `?kind=` (`prompt`\|`userdata`\|`step`) filters the list. |
| `POST /api/snippets` · `PATCH /api/snippets/:id` · `DELETE /api/snippets/:id` | Create / update / delete a snippet (`kind`+`name`+`content` required; `kind` validated; duplicate `(kind, name)` → 409). Renames are allowed and **break references by name** by design. |
| `GET /api/settings` | Every stored setting as a `{key: value}` map. |
| `GET /api/settings/system` | Read-only host facts from boot config: `wisperBaseUrl`, `wisperHostId`, `wisperMode` (`dev`\|`v1`), and `wisperApiKeyPresent` (boolean — whether the `WISPER_API_KEY` secret is set, never its value). |
| `PUT /api/settings` | Upsert one `{key, value}`; `key` must be a known setting (see below). |
| `GET /api/modules` | Registered modules with each producer's live trigger/status. |
| `GET /api/modules/:id/config` · `PUT /api/modules/:id/config` | Read / replace a module's opaque JSON config. |
| `POST /api/modules/:id/backfill` | Replay a producer's already-watched items through normal intake (`{producer_id?, limit?, dry_run?}` → `{candidates, emitted}`); `dry_run` counts without emitting. 400 when no producer supports it. |
| `GET /api/modules/ado/discovery/orgs` | Orgs the configured PAT identity can reach: `[{accountName}]`. |
| `GET /api/modules/ado/discovery/projects?org=` | Projects in an org: `[{name}]`. |
| `GET /api/modules/ado/discovery/work-item-types?org=&project=` | Work-item types in a project: `[{name}]`. |
| `GET /api/modules/ado/discovery/states?org=&project=&type=` | Workflow states for a type: `[{name}]`. |
| `GET /api/modules/ado/discovery/area-paths?org=&project=` | Area-path roots: `string[]`. |
| `GET /api/modules/ado/discovery/iterations?org=&project=` | Iteration paths: `string[]`. |
| `GET /api/modules/ado/discovery/identities?org=&project=&q=` | Identity search (`q` optional; empty matches all): `[{displayName, uniqueName}]`. |
| `GET /api/modules/ado/discovery/workitems?q=` | Work-item picker search over the **configured** org/project: title search (`System.Title CONTAINS WORDS`) plus, when `q` is a positive integer, an exact-id lookup; capped at 25 rows shaped `[{id, title, work_item_type, state, area_path, iteration_path, assignee, url}]`. Read-only; requires the module enabled+configured. |
| `POST /api/modules/ado/workitems/:id/materialize` | Fetch ONE work item and record it as a single `ado.workitem.manual` event (poller-identical payload, no dedupe, rule matching skipped) so a playbook can be dispatched against it. `201` with the created event row; `404` if the item does not exist in ADO. |
| `GET /api/modules/ado/identity/me` | The PAT's own identity `{uniqueName?, displayName?}` — used to prefill the `identity_me` setting. |
| `GET /api/secrets` | Stored secret **names** only (`{keys}`) — never a value. |
| `PUT /api/secrets` | Upsert `{key, value}`; echoes the name only. |
| `DELETE /api/secrets/:key` | Remove a secret (idempotent). |
| `GET /api/anthropic/models` | Anthropic model list `{models: [{id, display_name}], warning?}` for the playbook Model picker. Always 200 (degrades to an empty list + `warning`). |
| `GET /api/wisper/hosts` | Rentable host catalog `{hosts: [{id, name, os, online, images: [{id, name, price_cents_per_min}]}], warning?}` for the playbook Host picker. Fetched **server-side** (in `v1` mode via `GET /v1/catalog` with the bearer token) so the API key never reaches the browser; in `dev` mode a single synthetic entry for `WISPER_HOST_ID`. Always 200 (degrades to an empty list + `warning`). |
| `GET /api/agent-briefing` | The agent briefing `{briefing}` — see **Agent briefing**. |
| `GET /api/runners` | Registered runner ids `{runners: ["claude-code", …]}` for the playbook Runner picker. |
| `GET /api/capabilities` | Grantable capabilities `[{id, module_id}]` for the playbook capability picker. |
| `GET /api/changes/stream` | SSE stream of coalesced resource-change frames `{resource, ts}` driving the SPA's live refetch (a comment ping every 15 s keeps it warm). |
| `GET /api/config/export` | Portable config document (`schema_version` 2: playbooks, rules with their `dispatch` AND `notify` targets, notifiers, snippets, module config exported DISABLED, whitelisted settings minus `identity_me`; secrets as NAMES only in `required_secrets`). Notifiers preserve their `enabled` bit (unlike modules); a notifier is a reactive outbound sink that only fires when a matched rule targets it. `?scrub=environment` blanks the module `org`/`project` and `default_lease_image`. 409 when a stored secret VALUE is found pasted inside the document. Notifier `config` is scanned the same way, but the scan only catches values that match a currently STORED secret, so credentials must NOT be pasted into a notifier's `config` at all (nothing consumes that blob today anyway). |
| `POST /api/config/import` | Import a config document `{document, mode: merge\|overwrite, dry_run}`; `merge` (default) skips name collisions, `overwrite` replaces them; dry-run returns the full plan with no writes. Notifiers are matched by NAME idempotently and rule `notify` targets rebind to the local notifier ids. Reads schema versions **1 and 2**; a v1 document (which had no notifiers and no rule `notify`) imports cleanly with those fields defaulting to empty. Returns per-object actions, `missing_secrets`, and a post-import checklist; the apply is one transaction (400 on a malformed document, 409 on a rule whose playbook or notifier is unresolvable). |

The secret store is **write-only** across the API: a value is readable only
inside a lease, via the executor's `env` injection. It never crosses the API
boundary.

The `discovery`, `identity`, and `anthropic` reads exist only to feed the SPA's
pickers, and all of them keep credentials server-side. Every ADO discovery call
resolves the module's PAT (by its `pat_secret_ref`) from the secret store on the
server and never returns it; a missing config or secret answers `400`, and an
upstream Azure DevOps failure is passed through as `502`. The Anthropic model
lookup resolves its credential the same way (see below) and travels it only in
the outbound request header. See **Web UI** for how each picker consumes these.

## Configuration reference

### Environment variables

Read once at boot (copy `.env.example` to `.env`). A malformed value fails fast
with a clear message, except the two optional `WISPER_*_TIMEOUT_MS` knobs, which
silently fall back to their default so a typo never blocks boot.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3007` | Loopback API port. Must be an integer 1-65535. |
| `ORCH_DATA_DIR` | *(unset)* | Base directory for ALL of orchestrator's on-disk state: the SQLite DB file (default `<ORCH_DATA_DIR>/orchestrator.sqlite`), the per-dispatch log directory (`<ORCH_DATA_DIR>/logs/dispatch-<id>.log`), and the encrypted secret store (`<ORCH_DATA_DIR>/secrets.enc` + `secrets.salt`). Used verbatim (no `orchestrator` subdirectory is appended). When unset, the OS user-data base is used with an `orchestrator` subdirectory (`%APPDATA%\orchestrator` on Windows, `~/Library/Application Support/orchestrator` on macOS, `$XDG_DATA_HOME` or `~/.local/share`, plus `/orchestrator`, elsewhere). Set this so a launcher can keep every piece of state in one folder. |
| `ORCH_DB_PATH` | `<data-dir>/orchestrator.sqlite` | SQLite database file path override. Set it to redirect ONLY the DB file (per-dispatch logs and the secret store still resolve against `ORCH_DATA_DIR` or the OS user-data default). |
| `WISPER_BASE_URL` | `http://localhost:8080` | Base URL of the wisper-api (must be http(s)). A plaintext `http://` URL is accepted only for loopback hosts (`localhost`, `127.0.0.1`, `::1`); a non-loopback `http://` URL is refused at boot so the API key and injected secrets never travel unencrypted. |
| `WISPER_ALLOW_INSECURE_HTTP` | *(unset)* | Set `1` or `true` to downgrade the non-loopback plaintext-http refusal to a loud warning (for operators terminating TLS themselves). |
| `WISPER_MODE` | `dev` | Which wisper surface the client speaks: `dev` (unauthenticated `/dev/leases` harness) or `v1` (authenticated `/v1/leases` consumer surface). In `v1` mode every request carries `Authorization: Bearer <WISPER_API_KEY>` — set the `WISPER_API_KEY` **secret** (not an env var) first. Any other value fails fast. |
| `WISPER_HOST_ID` | *(unset)* | The **default host** a playbook uses when it sets no `host`. In `dev` mode it is the hostId targeted on the `/dev/leases` endpoints; in `v1` mode it is the default catalog host **id or name** resolved against `GET /v1/catalog` at dispatch time. **Required to rent leases** — validated lazily, so an unset value does not crash boot but leaves leasing (and the dispatcher) idle. |
| `WISPER_CREATE_LEASE_TIMEOUT_MS` | `150000` | Client timeout (ms) for the blocking create-lease call. The `POST /dev/leases` 201 is not sent until the lease is fully provisioned (clone/build/host can take minutes for heavy images), so this is the longest per-operation timeout. Raise it when provisioning is slow. Unset or invalid → default. |
| `WISPER_EXEC_TIMEOUT_MS` | *(unset; derived per call)* | Explicit operator override for the per-call **exec** timeout (ms): pre steps, the streaming agent exec, and collect steps. For the streaming agent exec it is an inter-chunk **idle** window, *not* a wall-clock cap on total run time (the per-dispatch deadline bounds that). When UNSET the executor derives the value per call from the lease's **remaining TTL** plus a small margin, capped at about 6 hours, so a step or agent command that runs the length of a lease is not killed by a fixed 60 s client timeout. Set an explicit value here only to fix a single timeout across every exec. Precedence: this override wins over the executor's computed default. Unset or invalid falls back to the computed default. Release has its own, shorter timeout: see `WISPER_RELEASE_TIMEOUT_MS`. |
| `WISPER_RELEASE_TIMEOUT_MS` | `60000` | Per-call timeout (ms) for wisper lease-release requests: the executor's finally-block release, boot's orphan reconcile, the periodic release sweep, and the dispatcher's late release before a retryable requeue. Release is a quick control-plane DELETE and MUST NOT reuse the multi-hour exec-timeout cap: boot awaits the orphan reconcile sequentially before the dispatcher starts, and a hung socket per row would otherwise stall startup (or a whole sweep pass) for hours per row. Unset or invalid falls back to the default. |
| `ORCH_DISABLE_KEYCHAIN` | *(unset)* | Set `1` to force the passphrase-derived key even when an OS keychain is available. |
| `ORCH_MASTER_KEY` | *(unset)* | Passphrase the secret-store key is derived from (scrypt against a persisted salt) when no keychain is used. Keep it stable or the store won't decrypt. |

The **secret store** is encrypted at rest. When an OS keychain is available it
holds a random key automatically and neither `ORCH_*` key variable is needed.
Headless/CI (no keychain, or `ORCH_DISABLE_KEYCHAIN=1`) requires a stable
`ORCH_MASTER_KEY`.

### App settings (`app_settings` table)

Tunables edited through `PUT /api/settings` (or the Settings page). All are stored
as TEXT; writes are whitelisted to the keys the core actually reads.

| Key | Default | Effect |
|---|---|---|
| `default_lease_image` | *(none — required)* | Concrete image the seeded `smoke-test-clone-and-claude-linux` playbook resolves via its `setting:default_lease_image` reference. A dispatch fails if unset. |
| `dispatch_concurrency` | `1` | In-flight dispatch cap. Values > 1 are clamped to 1 (single-flight for now). |
| `dispatcher_interval_seconds` | `30` | Safety-net tick cadence for the dispatcher loop. |
| `dispatch_max_attempts` | `3` | Max attempts before a retryable failure gives up. |
| `dispatch_timeout_seconds` | *(unset)* | Optional per-dispatch hard deadline; only tightens `ttl_seconds − margin`. |
| `dispatch_max_per_event` | `10` | Cap on dispatches enqueued from a single event. |
| `dispatch_max_per_hour` | `100` | Rolling per-hour dispatch cap. |
| `dispatch_max_chain_depth` | `3` | Chain-loop guard: an event whose `chain_depth` reaches this cap creates no dispatches, so run-callback rules can't loop forever. |
| `event_dedupe_cooldown_seconds` | `300` | Window in which a repeated `dedupe_key` is suppressed at intake. |
| `run_retention_max` | `2000` | Cap on kept **terminal** runs (done/failed). The oldest beyond it are pruned — along with their runs, findings, and per-dispatch log files — after each terminal transition and once at boot. Absent/garbage falls back to 2000; **0 or negative disables pruning entirely**. |
| `identity_me` | `""` | Identity the literal `"@Me"` operand resolves to in rule criteria. |
| `run_budget_per_hour` | `0` (off) | Run budget gate: max agent runs STARTED per rolling window; the dispatcher claims nothing once the cap is hit. `0`/unset disables the gate. |
| `run_budget_window_minutes` | `60` | Length of the budget gate's rolling window, in minutes. |
| `token_budget_per_window` | `0` (off) | Optional trailing-window token circuit breaker: summed run token usage within the window is capped when set. `0`/unset = off. |

### Secrets

Referenced **by name** from playbook `env_requirements` and module config; the
values live only in the encrypted store. The seeded
`smoke-test-clone-and-claude-linux` playbook requires:

| Secret name | Used by | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | agent step | Authenticates the `claude` CLI inside the lease. |
| `ADO_PAT` | `clone first repo in project` and credential-leak-hunt pre-steps (**step-only**) | Passed to `az repos list` via `AZURE_DEVOPS_EXT_PAT` and spliced into the clone URL; the leak-hunt step renders it again to grep the disk for its content. Delivered as `{name: "ADO_PAT", inject: "step-only"}` so it renders into pre-step templates but never lands in the lease environment — the agent step running inside the lease has no way to read it. The seeded playbook's third pre-step scrubs the credential from the git remote and clears `~/.azure`; the fourth (fatal) verifies the scrub. |

**Lease-env vs step-only secrets.** Each `env_requirements` entry is either a
plain string (the legacy shape) or an object `{name, inject: "step-only"}`. Both
forms are resolved the same way (a missing name fails the dispatch before any
lease is created), but they differ in **delivery**:

- A **plain string** entry is injected into the lease environment AND is
  available to server-side `{{env.NAME}}` template rendering in step
  `command_template`s, `userdata_template`, `prompt_template`, `prompt`-kind
  snippet content, and the `script` runner's `command_template`. This is what
  every existing playbook uses.
- A **`{name, inject: "step-only"}`** entry is available to server-side
  `{{env.NAME}}` template rendering ONLY in step `command_template`s and the
  `script` runner's `command_template`. Its value is **never** placed into the
  lease env; the executor also renders `userdata_template`, `prompt_template`,
  and `prompt`-kind snippet content against the lease-injectable env only, so a
  step-only value can never reach the lease (via userdata) or the prompt the
  agent sees. Use this for one-shot credentials that a `pre` step needs once
  (e.g. an ADO PAT interpolated into a `git clone` URL) so the agent step
  running inside the lease cannot read the value out of its process environment
  — a persistent LLM with shell access would otherwise see every value in the
  container env for the whole run.

Trade-off: a step-only secret still appears in the RENDERED command string sent
to wisper for the one exec that uses it, so it is briefly visible in the
container process's cmdline while that step runs. That is accepted; the goal is
that it does not PERSIST in the lease environment for later steps (and the
agent step) to read. Redaction covers step-only values in the dispatch log
identically to lease-env values.

The ADO module additionally reads a PAT under whatever name you set as its
`pat_secret_ref` (e.g. `ado_pat`).

The Datadog module reads two keys — an API key and an Application key — under
whatever names you set as its `api_key_secret_ref` and `app_key_secret_ref`
(e.g. `DD_API_KEY`, `DD_APP_KEY`). They are sent as the `DD-API-KEY` and
`DD-APPLICATION-KEY` headers and never logged or returned.

When `WISPER_MODE=v1`, the wisper client reads the `WISPER_API_KEY` secret (a
`wck_live_*` consumer key) at call time and sends it as
`Authorization: Bearer <key>` on every lease request. Like the module keys it is
resolved from the store server-side, never from `process.env`, and never logged
or placed in an error message — an auth failure names only the secret. The same
key backs `GET /api/wisper/hosts`, the server-side catalog proxy behind the
playbook **Host** picker: the browser holds only the resulting host list, never
the key. In `dev` mode that endpoint has no catalog and returns a single
synthetic entry for `WISPER_HOST_ID`; either way it degrades to an empty list +
`warning` on any failure so the Host field always falls back to free-text.

**Anthropic model-list credential.** `GET /api/anthropic/models` (which backs the
playbook Model picker) authenticates with a secret resolved server-side in a
fixed fallback order — it never reads `process.env` and never returns the value:

| Secret name | Auth used |
|---|---|
| `ANTHROPIC_API_KEY` | Preferred. Sent as the `x-api-key` header. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Fallback when no API key is set. Sent as `Authorization: Bearer <token>` with the `anthropic-beta: oauth-2025-04-20` header — the same token minted by `claude setup-token` that the agent step uses. |

With neither set, the endpoint still answers `200` with an empty list and a
`warning`, and the Model field falls back to free-text entry. A successful lookup
is cached in-process for ~10 minutes; failures are not cached.

## Module config reference: `ado`

`PUT /api/modules/ado/config` stores opaque JSON under `module_config` key `ado`.
Every field is optional — a half-filled config never throws; it degrades to a
manual trigger and a no-op tick. The producer only arms an interval trigger when
`enabled` **and** `org` **and** `project` are all set.

| Field | Type | Notes |
|---|---|---|
| `org` | string | Azure DevOps organization. |
| `project` | string | Azure DevOps project. |
| `pat_secret_ref` | string | Name of the secret holding the PAT. |
| `enabled` | boolean | Master switch; only an enabled module polls. |
| `interval_seconds` | number | Poll cadence; defaults to `60`. |
| `base_url` | string | Overrides the ADO base URL (tests point this at a mock). |
| `watched` | object | Watched work-item query builder config (below). |
| `pull_requests` | object | Additive config for the PR producer (below). |

`watched` shapes the WIQL query (`SELECT [System.Id] FROM WorkItems … ORDER BY
[System.ChangedDate] DESC`). Each configured filter contributes one AND-ed clause;
an absent or empty field contributes none:

| Field | Type | Notes |
|---|---|---|
| `assignee_mode` | `"me"` \| `"people"` \| `"any"` | `me` → `[System.AssignedTo] = @Me`; `people` → OR over `people`; `any` → no assignee clause (whole team). |
| `people` | string[] | Identities OR-ed on `[System.AssignedTo]` when mode is `people`. |
| `work_item_types` | string[] | Values OR-ed on `[System.WorkItemType]`. |
| `states` | string[] | Values OR-ed on `[System.State]`. |
| `state_mode` | `"include"` \| `"exclude"` | Treat `states` as an allow-list (default) or a deny-list (`[System.State] NOT IN (…)`). Ignored when `states` is empty. |
| `area_paths` | string[] | Roots OR-ed on `[System.AreaPath] UNDER`. |
| `iteration` | `"current"` \| `{current_for_team}` \| `{path}` \| `null` | `current` → `= @CurrentIteration`; `{current_for_team: "<Project>\\<Team>"}` → the team-scoped `@CurrentIteration('[…]\…')`; `{path: "<Project>\\<Iteration>"}` → `[System.IterationPath] UNDER '<path>'` (bound to one named iteration and its children); `null` → omitted. |
| `tags` | string[] | Tags AND-ed as `[System.Tags] CONTAINS '<tag>'`, one clause each. |

`pull_requests` configures the PR producer (`GET …/git/pullrequests?…status=active`,
diffed against a snapshot). It only arms its own interval trigger when `enabled`
(and the module's `org`/`project` are set):

| Field | Type | Notes |
|---|---|---|
| `enabled` | boolean | Master switch for the PR producer. |
| `interval_seconds` | number | Poll cadence; falls back to the module default (`60`). |
| `creators` | string[] | Watched creator identities (`uniqueName` or `displayName`). A PR fires only if its `createdBy` matches one; empty/absent = any creator. |

### ADO capabilities

The module contributes four **READ-ONLY** capabilities a playbook may be
granted (`GET /api/capabilities`, `module_id` `ado`). Each renders a labelled
plaintext block into the agent prompt at dispatch time and **degrades, never
breaks**: any ADO failure contributes a `(capability ... failed: ...)` note
instead of failing the dispatch. A grant with no `config` inherits the module's
persisted connection settings (`org`, `project`, `pat_secret_ref`, `base_url`);
an explicit `config` may restate them plus the fields below.

| Capability | Config | Renders |
|---|---|---|
| `ado.get_work_item` | connection fields only | The subject work item (id from the event `subject_ref`): title, type, state, assignee, area, tags, description, and its 20 most recent comments. |
| `ado.query_work_items` | the `watched`-style filter fields (`assignee_mode`, `people`, `work_item_types`, `states`, `state_mode`, `area_paths`, `iteration`, `tags`) plus `top` | A labelled `id \| type \| title \| state \| assignee \| area \| changed` table from a WIQL query; `top` defaults to 100, hard max 500. |
| `ado.sprint_rollup` | `area_path?`, `current_for_team?`, `stale_days?` (default 5), `terminal_states?`, `review_states?` | The current sprint's OPEN items: counts by state and type, plus at-risk (unchanged for `stale_days`), unassigned, and in-review lists. Built on the same query pipeline as `ado.query_work_items`. |
| `ado.get_work_item_links` | `max_chars?` (default 8000, hard cap 20000), `max_ancestor_depth?` (default 10), `max_group_rows?` (default 25), `pat_env_var?` (default `ADO_PAT`) | The subject's ancestors (root first, with descriptions), children and related items (compact rows), and attachment POINTERS (never content). The block is size-capped with visible truncation markers; an authenticated download hint is rendered only when `pat_env_var` is among the playbook's `env_requirements` names. |

> **Wiring status.** The ADO module is **registered at app boot** (`index.ts`
> constructs it via `createAdoModule`, registers it with the module registry, and
> replays its persisted config so producer triggers re-arm across restarts). The
> `/api/modules` endpoints list it, `PUT /api/modules/ado/config` accepts its
> config, and the `/api/modules/ado/discovery/*`, `/workitems/:id/materialize`,
> and `/identity/me` reads above are live (the `discovery/workitems` search and
> `materialize` both require the module enabled+configured). The producer only
> arms its interval trigger once `enabled`, `org`,
> and `project` are all set; until then it stays on a manual trigger.

## Module config reference: `datadog`

`PUT /api/modules/datadog/config` stores opaque JSON under `module_config` key
`datadog`. The config is **shape-validated on PUT** — every field is type-checked
and unknown keys are rejected with a `400`. The Datadog integration is
**READ-ONLY**: it only ever counts, samples, and reads monitor state.

| Field | Type | Notes |
|---|---|---|
| `enabled` | boolean | Master switch; only an enabled module arms its producers. |
| `site` | string | **Bare** Datadog site domain (e.g. `us5.datadoghq.com`, `datadoghq.eu`); defaults to `datadoghq.com`. The API base is derived as `https://api.<site>`. |
| `api_key_secret_ref` | string | Name of the secret holding the Datadog API key (sent as `DD-API-KEY`). |
| `app_key_secret_ref` | string | Name of the secret holding the Datadog Application key (sent as `DD-APPLICATION-KEY`). |
| `interval_seconds` | number | Poll cadence; defaults to `60`. |
| `monitors` | object | Monitor-state producer config (below). |
| `watches` | object[] | Statistical log watches (below). |

`monitors` configures the monitor-state producer (`GET /api/v1/monitor`):

| Field | Type | Notes |
|---|---|---|
| `enabled` | boolean | Master switch for the monitor producer. |
| `monitor_tags` | string[] | Restrict to monitors carrying ALL of these tags; empty/absent = all. |

Each `watches[]` entry aggregates logs (`POST /api/v2/logs/analytics/aggregate`)
and, on a statistical state change, samples them
(`POST /api/v2/logs/events/search`):

| Field | Type | Notes |
|---|---|---|
| `name` | string | **Required.** A stable, human-chosen name for the watch. |
| `query` | string | **Required.** The Datadog log search query the count is filtered by. |
| `group_by` | string | **Required.** The single facet the count is grouped by. |
| `window_seconds` | number | Window length; defaults to `interval_seconds`. |
| `detect` | object | Detectors (below); a watch with none never fires. |
| `sample_limit` | number | Sample lines to attach to an event; default `5`, max `25`. |

`detect` arms the statistical detectors — all optional and additive:

| Field | Type | Notes |
|---|---|---|
| `min_count` | number | Fire when a group's window count is at least this. |
| `spike_multiplier` | number | Fire when a group's count is at least this multiple of its trailing baseline. |
| `baseline_windows` | number | Trailing windows the spike baseline averages over; default `12`. |
| `novel_groups` | boolean | Fire when a group appears that was absent from the trailing baseline. |

The two producers turn Datadog's cheap aggregation APIs into a handful of
meaningful events — **never one event per log line**:

- **`datadog.logwatch`** runs each `watches[]` entry's grouped count query every
  tick and, per group, keeps an in-memory trailing baseline (a ring buffer of the
  last `baseline_windows` counts, mean-averaged). After the first (silent) seeding
  tick it evaluates the armed detectors per group and, on any trip, fetches a
  bounded sample and emits **one** `datadog.logs.alert` event listing every
  detector that fired. Detector labels: `threshold` (`min_count`), `spike`
  (`spike_multiplier` × baseline, baseline > 0 only), `novel` (`novel_groups`, a
  group key never seen for this watch). At most 50 groups are processed per watch
  per tick (a truncation is logged, never silent).
- **`datadog.monitor`** (armed only when `monitors.enabled`) reads monitor states
  each tick and emits a `datadog.monitor.transition` event whenever a monitor (or
  monitor group) changes state against a known prior state.

Both **seed silently** on their first tick (a restart or reconfigure never
replays the current state), keep their baselines / snapshot **in memory**, and
are **fail-quiet**: a tick that fails (auth, 429, network) logs a warning and
emits nothing. Their event payloads are documented under
[Event-driven automation](#event-driven-automation) below.

> **Wiring status.** The Datadog module is **registered at app boot** (`index.ts`
> constructs it via `createDatadogModule`, registers it with the module registry
> beside ADO, and replays its persisted config across restarts). `GET /api/modules`
> lists it and `PUT /api/modules/datadog/config` validates + accepts its config.
> The two producers above arm on the module's interval, and the two investigation
> capabilities below are listed by `GET /api/capabilities`.

### Datadog investigation capabilities

The module contributes two **READ-ONLY** capabilities a playbook may be granted
(`GET /api/capabilities`, `module_id` `datadog`) so an investigating agent gets
**fresh** Datadog context in its prompt at dispatch time. Like the ADO
capabilities they **degrade, never break**: a fetch failure contributes a short
`(... unavailable: ...)` note instead of failing the dispatch. A grant with no
config inherits the module's persisted connection settings (site + key refs); no
secret value ever appears in a rendered block.

| Capability | Config | Renders |
|---|---|---|
| `datadog.query_logs` | `{query?, window_seconds?, limit?}` | A header (query, window, count) plus one line per recent matching log (timestamp, status, service, truncated message). |
| `datadog.get_monitor` | `{monitor_id?}` | One monitor's name, type, query, thresholds, notable options, overall + per-group states, and URL. |

- **`datadog.query_logs`** — `limit` defaults to `20`, hard-capped at `50`
  regardless of config. When the triggering event is a `datadog.logs.alert`, the
  query (scoped to the tripped group) and the window default straight off the
  event payload, so a bare grant reproduces exactly the logs that fired. A
  configured `query` may reference the event via the same `{{...}}` template
  engine used for prompts/steps; a configured `window_seconds` is a "last N
  seconds" lookback (capped at 24h), otherwise the event's own window is used, or
  a 15-minute lookback as a last resort.
- **`datadog.get_monitor`** — the monitor id comes from `config.monitor_id` when
  set, else the event subject (a `datadog.monitor.transition` `subject_ref` **is**
  the monitor id), else a `monitor_id` on the event payload.

## Event-driven automation

The `ado` module turns Azure DevOps activity into generic **events**; **rules**
match those events and dispatch **playbooks** (agents) that react. The engine is
domain-neutral — nothing about any specific team, project, or organization lives
in the code. Your team-specific playbooks and rules are **your configuration**,
created in your running instance (via the Web UI or your own local setup script)
and **never committed** to this repo.

**Events the `ado` module emits** (read-only polling):

- Work items: `ado.workitem.created`, `.assigned` (+ `previous_assignee`),
  `.state_changed` (+ `previous_state`), `.area_changed` (+ `previous_area`),
  `.iteration_changed` (+ `previous_iteration`), `.tagged`, `.updated`. Each
  payload carries `work_item_type`, `state`, `assignee`, `area_path`,
  `iteration_path`, `tags`, and `url`.
- Pull requests: `ado.pullrequest.created` (+ `.updated`), payload including the
  repo clone URL, source/target branch, and creator.

**Events the `datadog` module emits** (read-only, aggregate-driven — never one
per log line):

- `datadog.logs.alert` (source `datadog`, `subject_kind` `log_group`,
  `subject_ref` `<watch>/<group>`, `dedupe_key` `datadog:<watch>:<group>`). One
  event per (watch, group) that trips a detector. Payload: `watch`, `query`,
  `group_by`, `group`, `detectors` (a subset of `["threshold","spike","novel"]`),
  `count`, `baseline` (the trailing mean), `window_start`/`window_end` (epoch ms),
  `samples[]` (`{timestamp, status, service, message}`), and `explorer_url` (a
  Logs Explorer deep link). Rules discriminate on the payload — e.g.
  `payload.count gte 100`, `payload.detectors contains "spike"` — so the single
  event type stays intent-free.
- `datadog.monitor.transition` (source `datadog`, `subject_kind` `monitor`,
  `subject_ref` `<id>`, `dedupe_key` `datadog:monitor:<id>:<group>`). Payload:
  `monitor_id`, `name`, `query`, `group` (`*` when the monitor is ungrouped),
  `from_state`, `to_state`, `url`. Match e.g. `payload.to_state eq "Alert"` for a
  new alert or `payload.to_state eq "OK"` for a recovery.

**Wiring a reaction:** create a rule whose `match` names an event type plus
optional payload `criteria` (dotted-path with operators like `=~`), and dispatch a
playbook. The shapes below are examples — fill in your own org/team values:

- New backlog item → a triage playbook: `ado.workitem.created` where
  `iteration_path =~ Backlog`.
- Your team's bugs/stories (created **or** moved into your area) → a review
  playbook: `ado.workitem.created` **and** `ado.workitem.area_changed` where
  `area_path =~ ^Your\\Team\\Area` and `work_item_type` is `Bug` / `User Story`.
- A teammate opens a PR → a build/test playbook: `ado.pullrequest.created`.

### Connection & watch config (set once)

Point the `ado` module at your org/project and store a PAT (Work Items Read, plus
Code Read if a playbook clones a repo) as a secret. Team-wide detection uses
`assignee_mode: "any"`; bound the poll with an explicit backlog iteration and/or
area paths so it isn't noisy. Enable the `pull_requests` producer and list the
creator identities to watch (empty = every active PR).

```bash
curl -X PUT http://127.0.0.1:3007/api/modules/ado/config \
  -H 'content-type: application/json' \
  -d '{
    "org":"<your-org>",
    "project":"<your-project>",
    "pat_secret_ref":"ADO_PAT",
    "enabled":true,
    "interval_seconds":60,
    "watched":{
      "assignee_mode":"any",
      "iteration":{"path":"<Your\\Backlog\\Iteration>"},
      "area_paths":["<Your\\Team\\Area>"]
    },
    "pull_requests":{ "enabled":true, "creators":[] }
  }'
```

- **First tick seeds silently** — turning the module on never replays the existing
  backlog or open PRs; only items that appear/change *after* seeding fire.
- JSON escapes backslashes, so an area path `Your\Team` is written `"Your\\Team"`.
- If `https://dev.azure.com/<your-org>` doesn't resolve, set `base_url` to your
  `visualstudio.com` host.

### Runner image

A playbook that clones and builds a repo runs in the lease image
(`default_lease_image`). The provided `runner/Dockerfile` (and
`runner/Dockerfile.windows` for a Windows-mode Docker host) bakes in Node, Go,
and the .NET SDK so mixed-stack repos build; rebuild it on the wispd host after
any change and allow-list it in wisp:

```bash
docker build -t orchestrator-runner ./runner   # on the wispd host
curl -X PUT http://127.0.0.1:3007/api/settings \
  -H 'content-type: application/json' \
  -d '{"key":"default_lease_image","value":"orchestrator-runner"}'
```

**Where the allow-list lives:** wisp's image policy belongs to the *host
machine* running wispd, not to this repo — a machine-level file the operator
points `WISP_CONFIG` at when starting wispd (e.g. `~/.wisp/config.json`).
`runner/wisp.config.example.json` here is only a reference snippet: the entries
a host needs to run orchestrator's runner images. Copy/merge it into the host's
config; wisp never reads this repo.

Store `CLAUDE_CODE_OAUTH_TOKEN` (see **Secrets**) so each lease can run the agent.
Everything is read-only — every result lands as a **finding** on the **Runs** page.

## Notifications

Alongside dispatching playbooks, a rule can **notify**: when it matches, it
delivers a rendered message through one or more **notifiers**. Notifiers are the
system's one deliberate **outbound sink** — the only place the code reaches *out*
rather than storing locally — and are exempt from the read-only rule that governs
integration modules (`src/services/notifications.ts`). A sink only delivers a
rendered template; it never fetches external data or emits back into the pipeline,
and its intent lives entirely in its name, `config`, and templates.

A **notifier** is `{name, config, title_template, body_template, enabled}`.
**Nothing in the code consumes `config` today**: it is a free-form blob the
core never branches on and delivery never reads. The exporter's leak scan only
catches values that match a currently STORED secret, so an unstored credential
pasted into `config` would slip through: never paste credentials into a
notifier's `config` at all. **A notification is JUST a notification**: there
are no delivery kinds. Every fired notifier ALWAYS:

- records **exactly one** row in the in-app notification log — the bell +
  Notifications page keep the full history; and
- makes a **best-effort** native OS desktop toast: `powershell.exe` (WinRT
  `ToastNotificationManager`) on Windows, `osascript display notification` on
  macOS, `notify-send` on Linux.

The toast is **display-only** — no click-through / launch URL. A desktop failure
never hides the notification: the log row stays `delivered` and the toast's error
(a missing tool, a non-zero exit, a timeout) is recorded in the row's `error`
column (null on success).

**Templates.** `title_template` and `body_template` render through the **same**
engine the executor uses for prompts — `{{event.*}}` roots into the event row
(`{{event.type}}`, `{{event.subject_ref}}`) and `{{payload.*}}` into its opaque
payload; any unresolved token renders to the empty string. Reused verbatim so
substitution never drifts from the executor's.

**Rule notify targets.** A rule's `notify` is an array of `{notifier_id}`,
independent of its `dispatch` targets — a rule may carry either, both, or neither.
On a match, each target's notifier is resolved and delivered; delivery is fully
isolated per target and **never** throws into event intake — a missing notifier is
skipped, a disabled one is skipped, and any other error is caught and logged.
Because a `run.*` callback is an ordinary event, notify targets fire on run
outcomes too.

**Endpoints.** `/api/notifiers` is CRUD over the sinks; `/api/notifications` reads
the append-only log (cursor-paginated, `unread=1` filter, `unread-count`) and
marks rows read (`:id/read`, `read-all`). `GET /api/notifications/stream` is a
Server-Sent Events feed that pushes one frame per newly written row, so the web
inbox and bell update live without polling (see the REST API table above).

**Web pages.** A **bell** in the app header shows the live unread count (seeded
from `unread-count`, kept current off the SSE stream) and each streamed row also
raises a Fluent **toast** (capped so a burst can't bury the UI). The
**Notifications** page is the inbox (list, mark read / mark all read — plain
entries with no click-through); the **Notifiers** page manages sinks (name,
title/body templates, enabled); and the **Rules** editor has a notify-targets
picker alongside the dispatch editor.

## Web UI

An app-wide system-status banner (fed by `GET /api/settings/system`) warns when
leasing is silently disabled — the `WISPER_API_KEY` secret missing in `v1` mode,
or `WISPER_HOST_ID` unset — naming the exact key to set and linking to Settings.
It is dismissable per session and clears live (no reload) once the missing value
is stored; the Settings page shows the same read-only host facts inline.

The SPA (`web/`, Fluent UI v9) is a thin editor over the REST API. Its data-entry
fields are **discovery-backed comboboxes** (`web/src/components/AsyncCombobox.tsx`):
each takes an injected async `load()`, fetches on mount, shows inline
loading/error/empty states, offers a `↻` button to re-run the loader, and stays
**freeform** — a typed value commits even if it isn't in the suggested list, so
wildcards, custom tool names, and not-yet-created secret names still save. The
data-layer hooks that back them live in `web/src/discovery.ts`.

### Discovery-backed pickers

| Field(s) | Page | Source |
|---|---|---|
| Events **Source** / **Type** filters | Events | `GET /api/events/facets` |
| Rule **Source** / **Type** | Rules | `GET /api/events/facets` (blank = match any; a trailing `.*` on type matches by prefix) |
| Playbook **Env requirements** (multi) | Playbooks | `GET /api/secrets` (names only) — each selected secret has a per-entry "Step-only (do not inject into lease env)" toggle; the API validates the `{name, inject: "step-only"}` shape at save time |
| Playbook **Image** | Playbooks | `GET /api/settings` `default_lease_image` + the `setting:default_lease_image` sentinel |
| Playbook **Runner** | Playbooks | `GET /api/runners` (`claude-code`, `script`) |
| Playbook **Model** | Playbooks | `GET /api/anthropic/models` (claude-code runner only) |
| Playbook **Host** | Playbooks | `GET /api/wisper/hosts` (blank = default host; option labels show each host's `os`) |
| Playbook **Isolation** | Playbooks | static `shared` / `sandboxed` / `vm` (blank = the wisper server default) |
| Playbook **Network** | Playbooks | static `["open", "none"]` (`web/src/tools.ts`) |
| Playbook **Allowed tools** (multi) | Playbooks | static `CLAUDE_CODE_TOOLS` list (`web/src/tools.ts`; claude-code runner only) |
| Playbook **Granted capabilities** (multi) | Playbooks | `GET /api/capabilities` (`[{id, module_id}]`) |
| ADO module **PAT secret name** | Modules | `GET /api/secrets` (names only) |
| ADO **Org / Project / Type / State / Area path / Iteration / People** | Modules | cascading `GET /api/modules/ado/discovery/*` |
| Settings **`identity_me`** | Settings | `GET /api/modules/ado/identity/me` (on demand) |

The secret-name pickers (playbook env requirements, ADO PAT) show a non-blocking
inline warning listing any referenced name not yet in the store, so a typo is
visible without stopping a save.

The **allowed-tools** list is a shipped static constant, `CLAUDE_CODE_TOOLS` in
`web/src/tools.ts` — `Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch,
NotebookEdit, TodoWrite, Task`. It is not discovered: the runner's built-in tool
set is fixed by the Claude Code version baked into the image, not advertised by
any endpoint, so there is nothing to fetch. Leaving the selection empty sends
`null` (no restriction — all tools). The **Model** picker commits a model `id`
and shows its `display_name`; leaving it blank uses the runner's default model.

### ADO cascading autofill

The Modules page walks the ADO hierarchy top-down: **org → project →
work-item-types → states / area-paths / iterations / identities**. Each dependent
picker is keyed on its parents' current selections, so changing a parent remounts
the child and re-runs its loader; a loader whose prerequisites are unset returns
`[]` rather than calling the backend (avoiding a `400`). **Autofill** kicks in
when a discovery read returns exactly one candidate and the field is still empty
— that lone value is selected automatically so the cascade advances without a
click (e.g. a PAT scoped to a single org auto-selects it). Discovered work-item
types are UI-only: they narrow which **States** are offered (the page unions the
states across the selected types, or across all discovered types when none is
picked) and are **not** persisted. Everything the page does save goes through
`PUT /api/modules/ado/config`.

### Settings `identity_me` prefill

The Settings page's `identity_me` field has a **Resolve from ADO** button that
calls `GET /api/modules/ado/identity/me` and fills the field with the PAT's
`uniqueName` (or `displayName`). It only runs on click, stays editable, and a
missing PAT/org surfaces inline without clobbering the current value. This is the
identity the literal `"@Me"` operand resolves to in rule criteria and in the
watched-query builder's `assignee_mode: "me"`.

### Theming (dark mode)

Theme is a three-way preference — **System / Light / Dark** — owned by
`web/src/theme.tsx` and persisted in `localStorage` under
`orchestrator.theme` (defaults to `System`). `System` tracks
`prefers-color-scheme` live via `matchMedia`, so flipping the OS theme updates the
app immediately. The toggle (bottom of the desktop nav rail, right of the mobile
top bar) cycles System → Light → Dark. Under the hood it swaps Fluent UI's
`webLightTheme` / `webDarkTheme` on the `FluentProvider`; all styling is
token-based, so dark mode is a pure theme swap (the resolved neutral background /
foreground are also mirrored onto `:root` so overscroll paints correctly).

### Mobile / responsive layout

The single breakpoint is **768px** (`web/src/useMediaQuery.ts`). Above it, a
persistent 220px left nav rail sits beside the content. At ≤768px the rail
collapses into a top app bar with a hamburger that opens an overlay drawer
holding the same nav links (selecting a route or the close button dismisses it).
The playbook create/edit editor is a centered dialog sized `min(900px, 92vw)`
by `90vh` (its form body scrolls internally); at or below the breakpoint it
fills the viewport, so it works on a phone. Wide tables (Playbooks,
Events, Settings/Secrets) and the Events payload blocks wrap in
horizontally-scrollable containers rather than overflowing a narrow viewport.

### Configuring a playbook and rule from the UI

A minimal end-to-end setup once the backend is up and the ADO module is
configured (Modules page or step 5 of the runbook below):

1. **Store the credentials as secrets** (Settings → Secrets, or `PUT
   /api/secrets`): at least `CLAUDE_CODE_OAUTH_TOKEN` and `ADO_PAT` (both
   used by the seeded first-launch smoke test — the PAT is delivered
   step-only, so it renders into the clone pre-step but never lands in the
   lease environment). Optionally add `ANTHROPIC_API_KEY` so the Model
   picker can list models (otherwise it falls back to `CLAUDE_CODE_OAUTH_TOKEN`).
2. **Set `default_lease_image`** on the Settings page to your allow-listed runner
   image, and click **Resolve from ADO** on `identity_me` so `@Me` rules resolve.
3. **Create a playbook** (Playbooks → *New*). The editor dialog groups the
   lease shape (Image, Host, Isolation, Network, TTL, resources), the runner
   config (Runner, then Model and Allowed tools for `claude-code` or a Command
   template for `script`), Env requirements, Granted capabilities, the ordered
   `pre`/`collect` steps, and the userdata source. Pick the **Image**
   from the suggestions (or the `setting:default_lease_image` sentinel), leave
   **Allowed tools** empty for no restriction, choose a **Model** (or leave blank
   for the runner default), and select the secret names the steps need under
   **Env requirements** — each entry has a **Step-only** checkbox to keep that
   secret out of the lease environment (rendered into step templates only).
4. **Create a rule** (Rules → *New*). Choose the **Source** and **Type** from the
   facet-backed comboboxes (blank = any; a trailing `.*` on type matches by
   prefix), add any `criteria`, and point its `dispatch` at the playbook you just
   created. Enable it.
5. When the ADO poller emits a matching event, the rule fires a dispatch; watch it
   on the **Queue** page and open its **Run** for the live log, collected output,
   and findings.

## Agent briefing

The **Agent Briefing** page (nav) renders a briefing a user pastes into any AI
coding agent running on this machine — Claude Code, Codex, Cursor, anything
that can make HTTP requests — so the agent can operate this app over its
loopback API: creating rules, playbooks, snippets, and notifiers, dispatching
runs, and reading results on the user's behalf. The same text is served raw at
`GET /api/agent-briefing` as `{briefing}`; the page fetches it from there and
offers one-click copy.

The briefing's single source of truth is `src/services/agentBriefing.ts`.

> **MAINTENANCE — keep the briefing in sync.** The briefing is the only thing a
> pasted-in agent knows about this app. Any change to how the app is operated —
> an endpoint added, renamed, or reshaped; a new or renamed settings key,
> runner, or secret convention; changed rule-matching or template semantics;
> new event types — MUST update `src/services/agentBriefing.ts` in the same
> change, or agents will confidently drive a stale API. The router test
> (`src/routers/agentBriefingRouter.test.ts`) spot-checks that the load-bearing
> sections are present, but accuracy is on the author of the change.

## Local bring-up runbook

This walks a fresh machine to a first dispatch. Everything runs locally and
trusted.

1. **Start the lease broker stack.** Run [wisp](https://github.com/benjaminfkile/wisp),
   [wisp-agent](https://github.com/benjaminfkile/wisp-agent), and
   [wisper-api](https://github.com/benjaminfkile/wisper-api) on this machine.
   In the default `WISPER_MODE=dev`, wisper-api **must** have the dev endpoints
   enabled (in `v1` mode the authenticated `/v1` surface is used instead and
   only `/healthz` needs to answer):

   ```sh
   Tunnel__EnableDevEndpoints=true   # so /dev/leases and /healthz are live
   ```

   Verify: `curl http://localhost:8080/healthz` returns OK, and note the
   **hostId** whose wisp-agent tunnel the leases should run through.

2. **Build and allow-list a runner image.** Leases run the `claude` CLI, so the
   image needs `node`, `git`, and the `claude` CLI on `PATH` (the seeded smoke
   test installs git and the `claude` CLI itself when they are missing, so a
   bare Debian/Ubuntu image also works for it). Build an image, then allow-list
   it in the wisp host's image policy (see **Runner image**; only allow-listed
   images may be leased). Its reference (e.g. `ghcr.io/acme/agent:latest`) is
   what you'll store as `default_lease_image` in step 6.

3. **Configure and start orchestrator.**

   ```sh
   cp .env.example .env
   # set WISPER_HOST_ID=<the hostId from step 1>; leave the rest at defaults.
   npm install                # add --ignore-scripts in a container (see below)
   npm run build
   npm run dev                # tsc-watch + node dist/index.js, on 127.0.0.1:3007
   ```

   Confirm health: `curl http://127.0.0.1:3007/api/health` →
   `{"status":"ok","db":true,"wisper":true}`.

4. **Mint the Claude OAuth token and store it as a secret.** On a machine with the
   `claude` CLI:

   ```sh
   claude setup-token          # prints a CLAUDE_CODE_OAUTH_TOKEN
   ```

   Store it plus an ADO PAT (Work Items Read + Code Read — the seeded smoke
   test uses the PAT to list a project's repos and clone the first one):

   ```sh
   curl -X PUT http://127.0.0.1:3007/api/secrets \
     -H 'content-type: application/json' \
     -d '{"key":"CLAUDE_CODE_OAUTH_TOKEN","value":"<token>"}'
   curl -X PUT http://127.0.0.1:3007/api/secrets \
     -H 'content-type: application/json' \
     -d '{"key":"ADO_PAT","value":"<ado-pat>"}'
   ```

   In `v1` wisper mode you also need `WISPER_API_KEY` (the `wck_live_*`
   consumer key from wisper-api) stored the same way, or leasing stays idle.

5. **Configure the ado module** (see the wiring-status note above), pointing
   the module at the same PAT you just stored:

   ```sh
   curl -X PUT http://127.0.0.1:3007/api/modules/ado/config \
     -H 'content-type: application/json' \
     -d '{"org":"acme","project":"platform","pat_secret_ref":"ADO_PAT",
          "enabled":true,"interval_seconds":60,
          "watched":{"assignee_mode":"me","states":["Active"]}}'
   ```

6. **Set the default lease image** to the reference from step 2. The seeded
   `smoke-test-clone-and-claude-linux` playbook resolves its image through
   `setting:default_lease_image` at dispatch time; a dispatch fails if the
   setting is missing.

   ```sh
   curl -X PUT http://127.0.0.1:3007/api/settings \
     -H 'content-type: application/json' \
     -d '{"key":"default_lease_image","value":"ghcr.io/acme/agent:latest"}'
   ```

7. **Fire the first-launch smoke test.** The seeded `smoke test:
   ado.workitem.*` rules already dispatch the seeded playbook the instant
   any observed work item carries the `smoke-test-clone-and-claude-linux`
   tag, and the seeded `Smoke test started` / `Smoke test finished` /
   `Smoke test failed` notify rules push a desktop toast on start, success,
   and failure. So the trigger is:

   ```
   Tag any work item the ADO module watches with the string
   smoke-test-clone-and-claude-linux and save it. The next touch of that
   item (an edit, a state change, an assignment) will match a seeded rule
   and dispatch the smoke test.
   ```

   The playbook installs the Azure CLI, uses `ADO_PAT` to list the project's
   repositories, clones the first one into `./work`, scrubs the credential
   from the git remote (and clears `~/.azure`), then runs a **fatal
   credential-leak hunt** — re-checking the process env, `~/.azure`, the git
   remote/config, and the disk for any trace of the PAT; any hit fails the
   dispatch loudly — then installs the `claude` CLI,
   and asks the agent to explore the cloned repository and report findings.
   If it drives all the way to a `done` run with findings you know
   auth / lease / installs / network / claude / notifications all work.

   Two shell-behavior facts the live test on 2026-08-16 confirmed, worth
   knowing if you author your own steps: `az repos list` auto-installs the
   `azure-devops` extension on first use (so no separate `az extension add`
   step is needed), and each wisp exec is a **fresh non-login `/bin/sh`
   process** with no shared env, cwd, or profile — so nothing exported in
   one step survives to the next, and the install-claude step therefore
   `ln -sf`s the native-installer binary into `/usr/local/bin` rather than
   relying on a `PATH` export. Root-refusal in the agent step is handled by
   the runner, which prefixes the linux `claude` invocation with
   `IS_SANDBOX=1` (the CLI's documented container escape hatch); no playbook
   config is required for it.

8. **Watch a dispatch run.** When the poller emits a matching event, a dispatch is
   enqueued and the dispatcher drains it. Follow it:

   ```sh
   curl http://127.0.0.1:3007/api/dispatches            # find the id + status
   curl http://127.0.0.1:3007/api/dispatches/<id>/log   # tail the live log
   curl http://127.0.0.1:3007/api/runs/<runId>          # collected output + findings
   ```

   The dispatch walks `queued → leasing → running → collecting → done`, and the
   lease is released regardless of outcome. The web UI (`npm --prefix web run
   dev` serves it at `http://127.0.0.1:4400` and proxies `/api` to the backend
   on 3007; the backend itself does not serve `web/dist`) shows the same via
   the Queue, Events, and Runs pages.

## Layout

- `index.ts`, `src/` — Express + better-sqlite3/knex backend (loopback only, no
  auth — the OS user is the security boundary).
- `web/`: React + Vite SPA (Queue, Events, Rules, Playbooks, Snippets, Runs,
  Modules, Notifications, Notifiers, Agent Briefing, and Settings pages on a
  Fluent UI baseline).
- `runner/`: the `orchestrator-runner` lease image definitions (Linux and
  Windows) plus a reference wisp allow-list snippet.
- `scripts/local/`: gitignored; a private team-automation install script lives
  here on a developer machine, never in the repo.

## Develop

Backend:

```sh
npm install
npm run build     # rimraf dist && tsc
npm test          # jest --runInBand --detectOpenHandles (single worker, on purpose)
npm run dev       # tsc-watch + node dist/index.js
```

Web:

```sh
npm --prefix web install
npm --prefix web run build
npm --prefix web test     # vitest run (one-shot, never watch mode)
npm --prefix web run dev  # Vite on 127.0.0.1:4400, proxying /api to the backend on 3007
```

The root `package.json` also offers `npm run start` (build then run),
`npm run coverage`, and the `install:web` / `build:web` / `dev:web` /
`test:web` aliases for the commands above.

Configuration: copy `.env.example` to `.env`. Assumes wisper-api is running
locally with dev endpoints enabled (`Tunnel__EnableDevEndpoints=true`).

In a task container, install with `npm install --ignore-scripts`: the runner
image has no Python/gcc, so better-sqlite3's native rebuild fails, but its
prebuilt binary loads fine.

## Build verification

<!-- Automated build results are appended below this line. -->

### 2026-07-13 — node v20.20.2

| Command | Result |
|---|---|
| `npm run build` (backend) | PASS |
| `npm test` (backend) | PASS — 1 test suite, 1 test |
| `npm --prefix web run build` (web) | PASS |
| `npm --prefix web test` (web) | PASS — 1 test file, 1 test |

Note: `npm install` requires `--ignore-scripts` in this container (no Python/gcc for better-sqlite3 native rebuild); the prebuilt binary loads correctly and all four verification commands exit 0.

### 2026-07-13 — node v20.20.2

| Command | Result |
|---|---|
| `npm run build` (backend) | PASS |
| `npm test` (backend) | PASS — 1 test suite, 1 test |
| `npm --prefix web run build` (web) | PASS |
| `npm --prefix web test` (web) | PASS — 1 test file, 1 test |

Note: `npm install` again required `--ignore-scripts` (no Python for the better-sqlite3 native rebuild); the prebuilt binary loads fine and all four verification commands exit 0.
