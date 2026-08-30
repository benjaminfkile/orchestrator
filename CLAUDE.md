# CLAUDE.md — orchestrator house rules

## Overview

orchestrator is a single-user desktop app (Express + better-sqlite3/knex backend,
React + Vite SPA in `web/`) that watches external systems, matches events against
user-configured rules, and runs data-driven playbooks inside container leases
rented from a wisper-api — either a locally running dev harness (`/dev/leases`,
`WISPER_MODE=dev`, the default) or the authenticated `/v1/leases` consumer
surface (`WISPER_MODE=v1`, bearer `WISPER_API_KEY` secret, https enforced for
non-loopback hosts). It binds `127.0.0.1` with no auth layer — the OS user is
the security boundary.

## ARCHITECTURE PRINCIPLE (load-bearing)

**The code must never know what it is running.** The core AND every integration
module must be domain-neutral. No code identifier, type, or branch may be named
around an intent — no `PR`, `work_item`, `bug`, `review`, or `anomaly` in code
names. Behavior is defined ENTIRELY by data: a playbook's prompt, its granted
capabilities' config, and event payloads.

Integration modules contribute only two generic things:

1. **capabilities** — bounded, read-only, domain-neutral data operations granted
   to playbooks and parameterized by config.
2. **producers** — configured pollers/listeners (a query + a trigger) that emit
   generic events.

Those intent words may appear ONLY in user config, prompts, and user-chosen event
type strings — never in a code path. External-service modules are READ-ONLY by
construction; all output is stored locally in SQLite.

**Notification sinks (carve-out).** Notifiers (`src/services/notifications.ts`)
are a deliberate core OUTBOUND delivery mechanism and are exempt from the
integration-module READ-ONLY rule. A notification is JUST a notification — there
are no delivery kinds: every fired notifier always records one in-app log row and
best-effort raises a desktop toast (on Windows a click opens the run page or the
inbox in the web UI). A sink only delivers a rendered template — it emits nothing back into the pipeline and never
fetches external data — so it does not reintroduce the coupling that rule guards
against. Sinks stay domain-neutral all the same: intent lives entirely in a
notifier's name, `config`, and title/body templates, never in a code branch.
Integration modules remain strictly read-only.

## LEASE PRINCIPLE (load-bearing)

Lease lifecycle is owned by orchestrator code, never by the agent inside the
lease. Provisioning happens in lease `userdata`; each pipeline step is an exec
authored by the executor; the agent step's exit code (delivered by the streaming
exec's terminal `exit` event) is the completion signal; the executor ALWAYS
releases the lease (`DELETE /dev/leases/:id`, or `/v1/leases/:id` in v1 mode) —
the lease TTL is only a crash failsafe, never the termination mechanism. A
failed release is never abandoned: the executor retries inline, then flags
`release_pending` for the release sweep (one-shot at boot, periodic while the
dispatcher runs, emergency pass on fatal process errors), which retries only
TERMINAL dispatches — an in-flight dispatch's lease is owned by its own
pipeline. A dispatch is never requeued (dispatcher retry or manual
`/retry`) while it still holds an unreleased lease. Never prompt an agent to
release, extend, or manage its own lease.

## Dev commands (must all pass before any task is done)

- Backend build: `npm run build`
- Backend tests: `npm test`
- Web build: `npm --prefix web run build`
- Web tests: `npm --prefix web test`

Never run Jest or Vitest in watch mode. `npm test` already runs Jest with
`--runInBand --detectOpenHandles` and `npm --prefix web test` already runs
`vitest run` — use them as-is; do not add workers, watch flags, or coverage
unless the task asks for it.

Install with `npm install --ignore-scripts` in task containers: the runner image
has no Python/gcc, so better-sqlite3's native rebuild script fails, but its
prebuilt binary loads fine.

## Conventions

- Keep changes scoped and match surrounding style.
- Add tests for new logic; place backend tests next to the source as
  `<name>.test.ts`.
- External-service integrations are READ-ONLY and store output locally in SQLite.
- Secrets never go in code or logs; they are injected into the lease `env`
  (dev and v1 alike) and referenced by name in playbook `env_requirements`. An
  entry may be `{name, inject: "step-only"}` to keep the value out of the lease
  env entirely — rendered into step command templates server-side only, and
  masked in logs like every resolved secret.
- If a change alters how the app is OPERATED (endpoints, request/response
  shapes, settings keys, runners, template or rule-matching semantics), update
  the agent briefing in `src/services/agentBriefing.ts` in the same change —
  it is served at `GET /api/agent-briefing` and must never go stale. See the
  README's "Agent briefing" section.
