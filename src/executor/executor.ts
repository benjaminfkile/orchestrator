/**
 * The dispatch pipeline state machine.
 *
 * {@link runDispatch} drives ONE dispatch end-to-end against a
 * {@link WisperClient}: it rents a lease, runs the playbook's `pre` steps,
 * authors and streams the agent exec, runs its `collect` steps and captures the
 * run's output on success, and advances the dispatch through its lifecycle
 * states (`leasing` → `running` → `collecting` → `done`/`failed`).
 *
 * Playbook steps are shell commands rendered through the same template engine as
 * the prompt (with an added `env` root). A `pre` step's non-zero exit fails the
 * dispatch and short-circuits the rest; a `collect` step's non-zero exit is only
 * logged. Secret hygiene: only a MASKED form of each rendered command — every
 * resolved env value over 3 chars replaced with `***` — is ever written to a log.
 *
 * Each dispatch also runs under a hard deadline —
 * `min(playbook.ttl_seconds - 60, dispatch_timeout_seconds)` — armed before any
 * lease is created; on expiry an internal {@link AbortController} tears down the
 * in-flight stream, the dispatch is failed with error `timeout`, and its lease
 * is released. {@link reconcileOrphanedDispatches} is the boot-time complement:
 * it fails any dispatch left mid-pipeline by an unclean shutdown and releases its
 * lease.
 *
 * LEASE PRINCIPLE (load-bearing): lease lifecycle is owned here, never by the
 * agent inside the lease. Whenever a lease was actually created, it is ALWAYS
 * released in the `finally` block — on success, failure, a thrown error, a
 * timeout, or an abort — best-effort, with release errors logged and never
 * rethrown. The exit event's `exit_code` is the SOLE success signal.
 *
 * Per the architecture principle this module is domain-neutral: it shapes only
 * generic fields (a playbook's templates/config, an event's payload) and never
 * branches on intent. All meaning lives in the playbook and event data.
 */

import type { Knex } from "knex";

import { getDb } from "../db/db";
import {
  getDispatch,
  listDispatches,
  listDispatchesWithPendingRelease,
  updateDispatch,
} from "../db/dispatches";
import { getEventById } from "../db/events";
import { createFinding } from "../db/findings";
import { getModuleConfig } from "../db/moduleConfig";
import { getPlaybook } from "../db/playbooks";
import { createRun } from "../db/runs";
import { getSetting } from "../db/settings";
import type {
  DispatchRecord,
  DispatchStatus,
  EnvRequirement,
  EventRecord,
  GrantedCapability,
  PlaybookStep,
} from "../interfaces";
import { log, type Logger } from "../log";
import type { ModuleRegistry } from "../modules/registry";
import { getRuntime } from "../runtime";
import { openDispatchLog, type DispatchLog } from "../services/dispatchLog";
import {
  MAX_FILES_TOTAL_BYTES,
  WisperApiError,
  type LeaseFileSpec,
  type WisperClient,
} from "../wisper/client";

import { getSnippetByName } from "../db/snippets";
import type { SnippetKind } from "../interfaces";

import { getRunner } from "../runners/registry";
import type { Runner } from "../runners/runner";

import { parseNotes } from "./notes";
import {
  buildPrompt,
  renderTemplate,
  scanSnippetRefs,
  type CapabilityContextEntry,
  type PromptEvent,
} from "./prompt";

/**
 * Resolve one required secret by name, or `undefined` when the requirement is
 * unmet. A single unmet requirement fails the dispatch BEFORE any lease is
 * created (see {@link runDispatch}).
 */
export type EnvResolver = (
  name: string
) => string | undefined | Promise<string | undefined>;

/** Injected collaborators for {@link runDispatch}. */
export interface RunDispatchDeps {
  /** Wisper client whose lease this dispatch runs in. */
  wisper: WisperClient;
  /** Resolver for the playbook's `env_requirements`. */
  resolveEnv: EnvResolver;
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /**
   * Module registry used to resolve a playbook's `granted_capabilities` at
   * dispatch time. Defaults to the process runtime's registry
   * ({@link getRuntime}); tests inject a fake. When absent (no module system
   * wired) every granted capability is simply skipped.
   */
  registry?: ModuleRegistry;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /**
   * Explicit operator override for the per-call exec/release timeout in ms
   * (and the inter-chunk idle window for the streaming agent exec; NOT a
   * wall-clock cap on total run time). The dispatcher threads
   * `WISPER_EXEC_TIMEOUT_MS` here. When UNSET the executor computes a per-call
   * default from the lease's REMAINING TTL plus
   * {@link EXEC_TIMEOUT_MARGIN_MS}, capped at {@link EXEC_TIMEOUT_CAP_MS};
   * see {@link resolveExecTimeoutMs}. The create-lease timeout is carried by
   * the {@link WisperClient} itself (its construction-time timeout), not here.
   */
  execTimeoutMs?: number;
  /**
   * Explicit operator override for the per-call lease-release timeout in ms.
   * The dispatcher threads `WISPER_RELEASE_TIMEOUT_MS` here. When UNSET the
   * executor's finally block uses {@link DEFAULT_RELEASE_TIMEOUT_MS}. Release
   * is a quick control-plane DELETE and MUST NOT share the exec timeout's
   * multi-hour default, so a hung socket cannot block dispatcher shutdown or
   * the release sweep for hours.
   */
  releaseTimeoutMs?: number;
  /**
   * Base directory for the per-dispatch log file. Defaults to the OS user-data
   * dir; tests point this at a temp directory.
   */
  logBaseDir?: string;
  /**
   * Body of the prompt's "## Working environment" section. Defaults to
   * {@link DEFAULT_WORKING_ENVIRONMENT}.
   */
  workingEnvironment?: string;
  /**
   * Optional caller abort signal. It is merged with the internal per-dispatch
   * timeout controller and the union drives the lease-create and exec calls, so
   * an external abort tears down the in-flight stream just like a timeout does.
   * Neither signal is forwarded to the final release: the lease must be released
   * even when the run was aborted or timed out.
   */
  signal?: AbortSignal;
  /**
   * Wall clock stamped as the run's `started_at`, injectable for deterministic
   * tests; defaults to `Date.now`. The dispatcher shares its own clock here so
   * the run-budget gate's trailing-window count stays consistent with the run
   * timestamps it counts against.
   */
  now?: () => number;
}

/**
 * Default body for the prompt's "## Working environment" section. Describes the
 * ephemeral, single-dispatch container without asserting any domain intent.
 */
export const DEFAULT_WORKING_ENVIRONMENT = [
  "The working directory is an ephemeral container leased for this dispatch",
  "alone; it is destroyed when the run ends. Anything you need to persist must",
  "be emitted as a finding via the NOTES_TO_SAVE protocol described below.",
].join(" ");

/** Surface only the generic fields the prompt/userdata engines consume. */
function toPromptEvent(event: EventRecord): PromptEvent {
  return {
    id: event.id,
    source: event.source,
    type: event.type,
    subject_ref: event.subject_ref,
    payload: event.payload,
  };
}

/**
 * Resolve a playbook's granted capabilities into labelled prompt context.
 *
 * Each grant is resolved from the module registry by its `capability_id` and its
 * `fetch` is called with the grant's own `config` — or, when the grant carries
 * none, the owning module's persisted config — plus the event's `subject_ref`.
 * The returned {@link CapabilityContextEntry} blocks are what `buildPrompt`
 * consumes.
 *
 * DEGRADE, NEVER BREAK: a capability that is unknown, or whose `fetch` throws, is
 * SKIPPED with a logged warning — capabilities are enrichment, not correctness,
 * so a broken one must never fail the dispatch. Stays domain-neutral: grants are
 * opaque `{id, config}` and are never branched on.
 */
async function resolveCapabilityContext(
  granted: GrantedCapability[],
  event: PromptEvent,
  envNames: string[],
  registry: ModuleRegistry | undefined,
  db: Knex,
  logger: Logger
): Promise<CapabilityContextEntry[]> {
  const subjectRef = event.subject_ref;
  // The generic event fields a capability may read to default its parameters —
  // domain-neutral, exactly as surfaced to the prompt.
  const capabilityEvent = {
    source: event.source,
    type: event.type,
    subject_ref: event.subject_ref,
    payload: event.payload,
  };
  const context: CapabilityContextEntry[] = [];
  for (const grant of granted) {
    const capabilityId = grant?.capability_id;
    if (typeof capabilityId !== "string" || capabilityId.length === 0) {
      logger.warn("skipping malformed granted capability", { grant });
      continue;
    }
    const capability = registry?.getCapability(capabilityId);
    if (!capability) {
      logger.warn("skipping unknown granted capability", { capabilityId });
      continue;
    }
    try {
      // An explicit per-grant config wins; otherwise fall back to the owning
      // module's persisted config so a grant can inherit the module's connection
      // settings without restating them.
      let config: unknown = grant.config;
      if (config === undefined) {
        const ownerId = registry?.getCapabilityOwner(capabilityId);
        config = ownerId ? await getModuleConfig(ownerId, db) : undefined;
      }
      const result = await capability.fetch(config, subjectRef, {
        envNames,
        event: capabilityEvent,
      });
      context.push({ label: result.label, content: result.content });
    } catch (err) {
      logger.warn("skipping granted capability that failed to fetch", {
        capabilityId,
        error: errorMessage(err),
      });
    }
  }
  return context;
}

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a playbook's `env_requirements` array into typed {@link EnvRequirement}s,
 * preserving order. Two shapes per entry are accepted:
 *   - a plain string — the legacy shape; the resolved secret is injected into
 *     the lease environment AND available to server-side `{{env.NAME}}`
 *     template rendering in step commands, `userdata_template`,
 *     `prompt_template`, prompt-kind snippet content, and the script runner's
 *     command template.
 *   - `{name: string, inject: "step-only"}` — the resolved secret is available
 *     to server-side `{{env.NAME}}` template rendering ONLY in step commands
 *     and the script runner's command template. It is NOT placed in the lease
 *     env, and it is NOT surfaced to `prompt_template`, `userdata_template`, or
 *     prompt-kind snippet content; the executor renders those against the
 *     lease-injectable env only, so a step-only value can never reach the lease
 *     (via userdata) or the prompt the agent sees. See {@link EnvRequirement}.
 * Any entry that is neither shape (an object with a missing/bad `name`, an
 * unknown `inject` value, a null, an array, etc.) is SKIPPED rather than fatal
 * — the core stays tolerant of malformed config, like {@link parseSteps} and
 * the rest of the template pipeline. Plain strings are passed through unchanged
 * for full backward compatibility with every existing playbook row.
 */
export function parseEnvRequirements(raw: unknown[]): EnvRequirement[] {
  const out: EnvRequirement[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    const { name, inject } = item;
    if (typeof name !== "string" || name.length === 0) continue;
    if (inject === "step-only") {
      out.push({ name, inject: "step-only" });
    }
    // Any other `inject` value (or a missing one on the object form) is skipped
    // rather than defaulting silently — an unknown mode is a misconfiguration.
  }
  return out;
}

/**
 * The name of a required secret, regardless of the entry shape. Used wherever
 * the core needs just the NAMES of a playbook's `env_requirements` (e.g. the
 * capability-context resolver's `envNames`, the missing-secret error message).
 */
export function envRequirementName(req: EnvRequirement): string {
  return typeof req === "string" ? req : req.name;
}

/**
 * True when a resolved secret for this requirement should be forwarded into the
 * lease environment. The plain-string form (the legacy shape) always is; the
 * object form with `inject: "step-only"` is not. A missing/unknown mode never
 * reaches here — `parseEnvRequirements` skips those.
 */
export function envRequirementInLeaseEnv(req: EnvRequirement): boolean {
  return typeof req === "string" || req.inject !== "step-only";
}

/**
 * Parse a playbook's opaque `steps` array into typed {@link PlaybookStep}s,
 * preserving order. Any entry that is not a well-formed step (bad phase or a
 * non-string `command_template`/`label`) is skipped rather than fatal — the core
 * stays tolerant of malformed config, like the rest of the template pipeline.
 */
export function parseSteps(raw: unknown[]): PlaybookStep[] {
  const steps: PlaybookStep[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { phase, command_template, label } = item;
    if (
      (phase === "pre" || phase === "collect") &&
      typeof command_template === "string" &&
      typeof label === "string"
    ) {
      steps.push({ phase, command_template, label });
    }
  }
  return steps;
}

/**
 * Redact secrets from a string before it is logged: every resolved env VALUE
 * longer than 3 chars is replaced with `***`. Longer values are masked first so
 * a secret that contains another as a substring is fully redacted. Values of 3
 * chars or fewer are left as-is — too short to be a meaningful secret and prone
 * to over-masking ordinary text.
 */
export function maskSecrets(text: string, env: Record<string, string>): string {
  const values = Object.values(env)
    .filter((v) => v.length > 3)
    .sort((a, b) => b.length - a.length);
  let masked = text;
  for (const value of values) {
    masked = masked.split(value).join("***");
  }
  return masked;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Prefix marking a playbook `image` as an indirect reference to an
 * `app_settings` key resolved at dispatch time, rather than a literal image
 * reference. The optional smoke-test seed (installed with `npm run
 * seed:smoke-test`) uses `setting:default_lease_image` so the concrete image
 * can be reconfigured without editing the playbook.
 */
export const IMAGE_SETTING_PREFIX = "setting:";

/**
 * Resolve a playbook's `image` field. A literal reference is returned as-is; a
 * `setting:<key>` reference is looked up in `app_settings` at dispatch time. An
 * unset or empty setting throws — a dispatch must not be leased against an
 * unresolved image.
 */
async function resolveImage(image: string, db: Knex): Promise<string> {
  if (!image.startsWith(IMAGE_SETTING_PREFIX)) return image;
  const key = image.slice(IMAGE_SETTING_PREFIX.length);
  const value = await getSetting(key, undefined, db);
  if (value === undefined || value === "") {
    throw new Error(`playbook image setting "${key}" is not configured`);
  }
  return value;
}

/**
 * Prefix marking a `userdata_template` or step `command_template` (and the
 * script runner's `command_template`) as a WHOLE-VALUE reference to a saved
 * snippet resolved at dispatch time — mirroring the image field's `setting:`
 * indirection. The entire template value must be exactly `snippet:<name>`; there
 * is no inline mixing (that stacking model is EXCLUSIVE to prompt snippets). The
 * resolved content is then rendered by the normal template engine as usual.
 */
export const SNIPPET_REF_PREFIX = "snippet:";

/**
 * Max depth of nested `{{snippet.*}}` prompt expansion before the dispatch fails.
 * A cycle is caught first by the chain check; this bounds legitimate but runaway
 * nesting so a deeply chained set of snippets can never balloon a prompt.
 */
export const MAX_SNIPPET_DEPTH = 5;

/**
 * Resolve a whole-value `snippet:<name>` reference against snippets of `kind`,
 * returning the referenced snippet's raw content. A value without the prefix is
 * inline text and is returned unchanged. A missing name — or a name that exists
 * only under a DIFFERENT kind — FAILS with a clear error, so a broken reference
 * fails the dispatch loudly (before any lease is created; see {@link runDispatch}),
 * exactly like a missing secret. Used for userdata, step commands, and the script
 * runner's command_template; the caller renders the result normally afterwards.
 */
export async function resolveSnippetReference(
  value: string,
  kind: SnippetKind,
  db: Knex
): Promise<string> {
  if (!value.startsWith(SNIPPET_REF_PREFIX)) return value;
  const name = value.slice(SNIPPET_REF_PREFIX.length);
  const row = await getSnippetByName(kind, name, db);
  if (!row) {
    throw new Error(`unknown ${kind} snippet "${name}"`);
  }
  return row.content;
}

/**
 * Resolve every `{{snippet.<name>}}` token reachable from `template` into a map
 * of name → fully-expanded content, for {@link buildPrompt} to splice into the
 * prompt. Runs in the executor BEFORE any lease is created so a bad reference
 * fails without paying for a lease; {@link renderTemplate} itself stays pure/sync.
 *
 * Each referenced name must exist under kind='prompt': an UNKNOWN name FAILS the
 * dispatch — a deliberate deviation from the engine's unknown-token-renders-empty
 * rule, since silently dropping prompt text is unacceptable. A snippet's content
 * is itself rendered with the full template context (event/payload/env AND
 * further `{{snippet.*}}` tokens), so prompt snippets stack. Expansion is bounded
 * by {@link MAX_SNIPPET_DEPTH} and guarded against cycles; exceeding either fails
 * the dispatch with an error naming the offending chain.
 */
export async function resolvePromptSnippets(
  template: string,
  event: PromptEvent,
  env: Record<string, string>,
  db: Knex
): Promise<Map<string, string>> {
  // Expand one snippet by name into its fully-rendered content. `chain` is the
  // ancestry that led here (excluding `name`); it drives both cycle detection and
  // the depth cap and is named in every failure so the offending path is legible.
  const expand = async (name: string, chain: string[]): Promise<string> => {
    if (chain.includes(name)) {
      throw new Error(
        `prompt snippet cycle detected: ${[...chain, name].join(" -> ")}`
      );
    }
    if (chain.length >= MAX_SNIPPET_DEPTH) {
      throw new Error(
        `prompt snippet nesting exceeds depth ${MAX_SNIPPET_DEPTH}: ${[
          ...chain,
          name,
        ].join(" -> ")}`
      );
    }
    const row = await getSnippetByName("prompt", name, db);
    if (!row) {
      const via =
        chain.length > 0 ? ` (via ${[...chain, name].join(" -> ")})` : "";
      throw new Error(`unknown prompt snippet "${name}"${via}`);
    }
    // Expand this content's own nested references first, then render the content
    // with them (plus event/payload/env) spliced in — bottom-up, so the returned
    // string is fully expanded.
    const nested = new Map<string, string>();
    for (const ref of scanSnippetRefs(row.content)) {
      nested.set(ref, await expand(ref, [...chain, name]));
    }
    return renderTemplate(row.content, event, { env, snippets: nested });
  };

  const resolved = new Map<string, string>();
  for (const name of scanSnippetRefs(template)) {
    resolved.set(name, await expand(name, []));
  }
  return resolved;
}

/**
 * Safety margin subtracted from a playbook's `ttl_seconds` to derive the default
 * per-dispatch deadline. The executor must abort and release BEFORE the lease TTL
 * failsafe fires, so the timeout is always at least this many seconds inside the
 * TTL — the lease self-destruct stays a crash backstop, never the mechanism.
 */
export const DEADLINE_TTL_MARGIN_SECONDS = 60;

/**
 * Absolute ceiling (ms) on the per-call exec/release timeout derived from a
 * lease's remaining TTL. Wisper permits very long-lived leases (the local
 * launcher sets `Tunnel:RelayRequestTimeoutMs` to 50 minutes and above), so a
 * naive `remaining_ttl + margin` could grow into a runaway HTTP timeout on a
 * lease with a many-hour TTL. Bounding the derived default here keeps that
 * safe. An explicit WISPER_EXEC_TIMEOUT_MS override wins ABOVE this cap: the
 * operator has stated the value they want, so it is honored verbatim.
 */
export const EXEC_TIMEOUT_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * Small buffer added to the lease's remaining TTL when deriving the default
 * exec timeout, so an exec near the tail of a lease still has a moment to
 * hear the server's own termination before the client's own timer fires. Kept
 * short: it is NOT meant to run past the lease TTL, only to avoid racing it
 * on the exact millisecond.
 */
export const EXEC_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Floor (ms) for the derived default so an exec near the very tail of a lease
 * still has room to at least attempt the release. If the caller ends up
 * calling an exec on an already-expired lease, wisper returns quickly anyway;
 * this just keeps the timer from being tiny or negative.
 */
export const EXEC_TIMEOUT_FLOOR_MS = 5_000;

/**
 * Resolve the per-call exec/release timeout in ms.
 *
 * Precedence (most specific wins):
 *   1. An explicit operator override (`configured`): this is
 *      WISPER_EXEC_TIMEOUT_MS threaded from config; when set, it is used
 *      verbatim regardless of the lease's remaining TTL or the cap.
 *   2. The computed default: `remaining_ttl_ms + {@link EXEC_TIMEOUT_MARGIN_MS}`,
 *      floored at {@link EXEC_TIMEOUT_FLOOR_MS} and capped at
 *      {@link EXEC_TIMEOUT_CAP_MS}. `remaining_ttl_ms` is
 *      `ttlSeconds * 1000 - (nowMs - leaseStartedAtMs)`, so it shrinks as the
 *      lease ages: a step that starts near the end of the lease gets a
 *      shorter timeout than one that starts immediately after leasing.
 *
 * A `null` `leaseStartedAtMs` (no lease pinned yet; the release-sweep path)
 * falls back to the cap when `configured` is unset, since there is no
 * remaining TTL to compute against.
 */
export function resolveExecTimeoutMs(
  configured: number | undefined,
  ttlSeconds: number,
  leaseStartedAtMs: number,
  nowMs: number
): number {
  if (configured !== undefined) return configured;
  const remainingMs = ttlSeconds * 1000 - Math.max(0, nowMs - leaseStartedAtMs);
  const derived = remainingMs + EXEC_TIMEOUT_MARGIN_MS;
  return Math.min(EXEC_TIMEOUT_CAP_MS, Math.max(EXEC_TIMEOUT_FLOOR_MS, derived));
}

/**
 * Classify how the per-call exec/release timeout in
 * {@link resolveExecTimeoutMs} was arrived at, so a log line can spell the
 * derivation out for an operator:
 *   - `override`: an explicit {@link RunDispatchDeps.execTimeoutMs} was set
 *     (WISPER_EXEC_TIMEOUT_MS), and that value wins verbatim.
 *   - `cap`: the remaining-TTL derivation exceeded
 *     {@link EXEC_TIMEOUT_CAP_MS} and was clamped down to it.
 *   - `ttl-derived`: `remaining_ttl + margin` fell inside the cap and was
 *     used as-is (this is the common case).
 */
export function classifyExecTimeoutDerivation(
  configured: number | undefined,
  ttlSeconds: number,
  leaseStartedAtMs: number,
  nowMs: number
): "override" | "ttl-derived" | "cap" {
  if (configured !== undefined) return "override";
  const remainingMs = ttlSeconds * 1000 - Math.max(0, nowMs - leaseStartedAtMs);
  const derived = remainingMs + EXEC_TIMEOUT_MARGIN_MS;
  if (derived > EXEC_TIMEOUT_CAP_MS) return "cap";
  return "ttl-derived";
}

/**
 * Default per-call timeout (ms) for wisper lease-release requests. Release
 * is a quick control-plane call that must not block boot's orphan reconcile
 * or a whole sweep pass while a hung socket sits open. Kept short so a stuck
 * DELETE fails fast and the sweep retries again on its next tick.
 * Overridable via WISPER_RELEASE_TIMEOUT_MS; see
 * {@link import("../config").Config.wisperReleaseTimeoutMs}.
 */
export const DEFAULT_RELEASE_TIMEOUT_MS = 60_000;

/** The `app_settings` key for the optional per-dispatch timeout override. */
export const DISPATCH_TIMEOUT_SETTING = "dispatch_timeout_seconds";

/**
 * The `app_settings` key a playbook `image` of `setting:default_lease_image`
 * resolves against (see {@link resolveImage}). Exposed so the settings API can
 * whitelist it for editing.
 */
export const DEFAULT_LEASE_IMAGE_SETTING = "default_lease_image";

/**
 * Wire an optional caller signal into the internal {@link AbortController} so an
 * external abort propagates to every in-flight wisper call. Returns a detach
 * function (a no-op when there was no signal or it had already fired) that the
 * caller invokes in its `finally` to drop the listener.
 */
function attachExternalSignal(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Resolve a dispatch's hard deadline in seconds:
 * `min(ttl_seconds - {@link DEADLINE_TTL_MARGIN_SECONDS}, dispatch_timeout_seconds)`,
 * where the `dispatch_timeout_seconds` setting only tightens the deadline when it
 * is present and a positive finite number. A non-positive result (a `ttl_seconds`
 * at or below the margin) means no deadline can be armed and the lease TTL is the
 * only failsafe.
 */
async function resolveDeadlineSeconds(
  ttlSeconds: number,
  db: Knex
): Promise<number> {
  let deadline = ttlSeconds - DEADLINE_TTL_MARGIN_SECONDS;
  const raw = await getSetting(DISPATCH_TIMEOUT_SETTING, undefined, db);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      deadline = Math.min(deadline, parsed);
    }
  }
  return deadline;
}

/**
 * Backoff (ms) between the in-line release retries the executor's `finally`
 * runs before flipping the dispatch to `release_pending`. Small and bounded —
 * the pipeline holds the dispatch open here, so it must NOT wait long: a real
 * outage is left to the periodic sweep. Growth is exponential.
 */
export const RELEASE_RETRY_BACKOFFS_MS: readonly number[] = [200, 500];

/**
 * Best-effort release with retries. Treats wisper's `not_found` response
 * (HTTP 404 — the server no longer knows this lease, or it was already
 * released) as SUCCESS, since the desired state is achieved. A retryable
 * {@link WisperApiError} (`host_offline`, `upstream_timeout`, client-side
 * timeout — see {@link RETRYABLE_CODES}) triggers a bounded backoff-retry;
 * a non-retryable error returns immediately. Never throws — the caller
 * inspects `.ok` and either records success or flags for the sweep.
 */
export async function attemptLeaseRelease(
  wisper: WisperClient,
  leaseId: string,
  timeoutMs: number,
  backoffsMs: readonly number[] = RELEASE_RETRY_BACKOFFS_MS
): Promise<{ ok: true } | { ok: false; error: string }> {
  const totalAttempts = backoffsMs.length + 1;
  let lastError = "";
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      await wisper.releaseLease(leaseId, { timeoutMs });
      return { ok: true };
    } catch (err) {
      // A `not_found` reply means wisper has no record of this lease anymore
      // — either it was already released, or its TTL failsafe reaped it — so
      // the desired end state is reached and the caller should stop retrying.
      if (err instanceof WisperApiError && err.code === "not_found") {
        return { ok: true };
      }
      lastError = errorMessage(err);
      const retryable = err instanceof WisperApiError && err.retryable;
      if (!retryable) break;
      // Backoff before the next try; the last attempt has no trailing wait.
      if (attempt < backoffsMs.length) {
        await new Promise((resolve) => setTimeout(resolve, backoffsMs[attempt]));
      }
    }
  }
  return { ok: false, error: lastError };
}

/**
 * The terminal outcome of a {@link runDispatch} call: the dispatch record in its
 * `done`/`failed` state, plus whether a failure is worth retrying.
 */
export interface RunDispatchResult extends DispatchRecord {
  /**
   * True only when a `failed` outcome is retryable — the run hit the per-dispatch
   * timeout, or a retryable {@link WisperApiError} (a transiently offline host or
   * an upstream timeout) tore it down. Always false for a `done` dispatch and for
   * every terminal failure: a non-zero agent exit, a missing secret, an auth
   * failure, or a non-retryable wisper error. The dispatcher owns what to do with
   * it; the pipeline only classifies.
   */
  retryable: boolean;
}

/**
 * Drive a single dispatch through its pipeline. Returns the dispatch record in
 * its terminal (`done` or `failed`) state, tagged with whether a failure is
 * `retryable`. Never throws for an ordinary run failure — a non-zero exit, an
 * unmet secret, a lease error, or an aborted stream all resolve to a `failed`
 * dispatch with the reason recorded in its `error` column. It only rejects if the
 * dispatch id is unknown or a bookkeeping DB write itself fails.
 */
export async function runDispatch(
  dispatchId: number,
  deps: RunDispatchDeps
): Promise<RunDispatchResult> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now;
  const configuredExecTimeoutMs = deps.execTimeoutMs;
  const releaseTimeoutMs =
    deps.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  const logger = (deps.logger ?? log).child({ dispatchId });

  const dispatch = await getDispatch(dispatchId, db);
  if (!dispatch) {
    throw new Error(`runDispatch: dispatch ${dispatchId} not found`);
  }

  // One-shot header line for the dispatch. Includes the configured exec
  // timeout so an operator can see the ceiling that bounds every exec at a
  // glance; when UNSET the value is derived per call from the lease's
  // remaining TTL (see resolveExecTimeoutMs) and each step start line below
  // still logs the resolved value it actually used.
  logger.info("dispatch started", {
    playbookId: dispatch.playbook_id,
    eventId: dispatch.event_id,
    configuredExecTimeoutMs,
    releaseTimeoutMs,
  });

  // The engine behind the agent step: it owns building the agent command and
  // parsing its output. Resolved from the registry against the playbook's chosen
  // runner id, inside the try below (an unknown id fails the dispatch before any
  // lease is created). Declared here so recordFailure can reach its auth-failure
  // detector; it stays undefined until resolution, and until then no output has
  // been captured to scan anyway. Everything else in this pipeline is
  // engine-neutral.
  let runner: Runner | undefined;

  // Accumulated raw agent output, fed to the runner's parser after the stream ends.
  let output = "";
  // Set once a lease is actually created; gates the finally-block release.
  let leaseId: string | null = null;
  // Wall-clock timestamp at which the createLease succeeded. Used by
  // {@link resolveExecTimeoutMs} to derive the per-call default timeout as
  // `remaining_ttl + margin`. Stays 0 until a lease is created; the release
  // path guards on `leaseId` so the value is never consulted before it is set.
  let leaseStartedAtMs = 0;
  // The TTL (seconds) requested when leasing, captured for the same reason.
  let leaseTtlSeconds = 0;
  // The per-call exec/release timeout used most recently, exposed to log lines
  // (in particular the `timeout` failure message asked for by task 213).
  let lastExecTimeoutMs: number | undefined = configuredExecTimeoutMs;

  const perCallTimeout = (): number => {
    // Before a lease exists (this call only runs after createLease succeeds in
    // practice) the derived default has no `remaining_ttl` to lean on, so it
    // falls back to the cap. In that pre-lease window the executor issues no
    // execs today; the guard here just keeps the helper safe to call.
    const value =
      leaseStartedAtMs === 0 && configuredExecTimeoutMs === undefined
        ? EXEC_TIMEOUT_CAP_MS
        : resolveExecTimeoutMs(
            configuredExecTimeoutMs,
            leaseTtlSeconds,
            leaseStartedAtMs,
            now()
          );
    lastExecTimeoutMs = value;
    return value;
  };

  // The per-dispatch append-only trace log. Opened INSIDE the try below once
  // the playbook is known so the file's first line can carry a header with the
  // resolved exec/release timeouts and the playbook id, the operational bounds
  // an operator wants when reading the log via GET /api/dispatches/:id/log.
  // Left null on the pre-open path; the finally block closes it only if opened.
  let dispatchLog: DispatchLog | null = null;

  // Internal controller whose signal drives every wisper call. It is aborted by
  // the per-dispatch timeout timer or, when present, by the caller's signal. The
  // final release deliberately does NOT receive it, so an aborted/timed-out run
  // still frees its lease.
  const controller = new AbortController();
  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const detachExternalSignal = attachExternalSignal(deps.signal, controller);
  // Set by recordFailure; surfaced to the caller so the dispatcher can decide
  // whether to retry. Stays false on success and on a terminal failure.
  let retryable = false;

  /**
   * Record a terminal failure on the dispatch. A timeout wins over any other
   * message — the whole run failed because it ran too long — so it is reported as
   * a bare `timeout`; otherwise the thrown message folds in any auth signal. A
   * timeout, or a thrown {@link WisperApiError} the client flagged retryable,
   * marks the failure retryable.
   */
  const recordFailure = async (err: unknown): Promise<void> => {
    let message: string;
    if (timedOut) {
      message = "timeout";
      retryable = true;
    } else {
      message = errorMessage(err);
      const authMatch = runner?.detectAuthFailure?.(output) ?? null;
      if (authMatch && !message.includes(authMatch)) {
        message += ` (auth failure: ${authMatch})`;
      }
      retryable = err instanceof WisperApiError && err.retryable;
    }
    // A wisper client-side timeout on an exec surfaces the ms value in its own
    // message, but the request could time out for reasons OTHER than the exec
    // (per-dispatch deadline, transport drop). Log the resolved per-call
    // execTimeoutMs alongside the error either way so an operator can tell
    // whether to raise WISPER_EXEC_TIMEOUT_MS. Task 213: retry semantics are
    // unchanged; only the log line carries the new detail.
    logger.error("dispatch failed", {
      error: message,
      retryable,
      execTimeoutMs: lastExecTimeoutMs,
    });
    await updateDispatch(dispatchId, { status: "failed", error: message }, db);
  };

  try {
    const playbook = await getPlaybook(dispatch.playbook_id, db);
    if (!playbook) {
      throw new Error(`playbook ${dispatch.playbook_id} not found`);
    }

    // Open the per-dispatch trace log with a one-line header naming the
    // dispatch, its playbook, and the resolved exec/release timeouts. The
    // resolved exec timeout is computed against the playbook's TTL with a
    // fresh clock (no lease yet, so remaining_ttl equals the full TTL), which
    // matches the value the first exec will use once the lease is created.
    // The precise per-exec resolution (which shrinks as the lease ages) is
    // still logged on every step start line below.
    const headerResolvedExecTimeoutMs = resolveExecTimeoutMs(
      configuredExecTimeoutMs,
      playbook.ttl_seconds,
      now(),
      now()
    );
    const openedLog = openDispatchLog(dispatchId, {
      baseDir: deps.logBaseDir,
      header:
        `# dispatch ${dispatchId} playbook ${playbook.id} ` +
        `exec_timeout_ms=${headerResolvedExecTimeoutMs} ` +
        `release_timeout_ms=${releaseTimeoutMs}`,
    });
    dispatchLog = openedLog;

    // Resolve the playbook's runner from the registry BEFORE any lease is
    // created. An unknown runner id is a misconfiguration that must fail the
    // dispatch up front — just like a missing image setting — rather than after
    // paying for a lease.
    runner = getRunner(playbook.runner);
    if (!runner) {
      throw new Error(`unknown runner "${playbook.runner}"`);
    }
    // Resolve any dispatch-time indirection in the runner's opaque config — the
    // script runner's `command_template` may be a whole-value `snippet:<name>`
    // reference — BEFORE any lease is created, so a missing/kind-mismatched
    // reference fails up front. A runner without such indirection returns its
    // config unchanged. Then validate the RESOLVED config so a misconfiguration
    // (e.g. a `script` runner with no command_template) also fails before leasing.
    const runnerConfig = runner.resolveConfig
      ? await runner.resolveConfig(playbook.runner_config, (value) =>
          resolveSnippetReference(value, "step", db)
        )
      : playbook.runner_config;
    runner.validateConfig?.(runnerConfig);
    const event = await getEventById(dispatch.event_id, db);
    if (!event) {
      throw new Error(`event ${dispatch.event_id} not found`);
    }
    const promptEvent = toPromptEvent(event);
    // Resolve any whole-value `snippet:<name>` step references (kind='step')
    // BEFORE leasing, so a missing/kind-mismatched reference fails without paying
    // for a lease. The resolved command content is still rendered per-step
    // ({{env.*}}/{{event.*}}) at run time. Applies to both pre and collect steps.
    const steps: PlaybookStep[] = [];
    for (const step of parseSteps(playbook.steps)) {
      steps.push({
        ...step,
        command_template: await resolveSnippetReference(
          step.command_template,
          "step",
          db
        ),
      });
    }

    // Arm the hard per-dispatch deadline BEFORE any lease is created, so the
    // timeout covers secret resolution, lease creation, and every exec. On
    // expiry it aborts the shared controller — tearing down the in-flight
    // stream — and the catch/finally mark the dispatch failed and release the
    // lease. A non-positive deadline (ttl at or below the margin) arms nothing.
    const deadlineSeconds = await resolveDeadlineSeconds(
      playbook.ttl_seconds,
      db
    );
    if (deadlineSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        logger.warn("dispatch timed out", { deadlineSeconds });
        controller.abort(new Error("timeout"));
      }, deadlineSeconds * 1000);
    }

    // --- leasing -----------------------------------------------------------
    await updateDispatch(dispatchId, { status: "leasing", error: null }, db);

    // Resolve every required secret BEFORE renting a lease: an unmet
    // requirement must fail the dispatch without ever creating a lease. All
    // missing names are collected and reported together, and the error carries
    // only the NAMES — never a resolved value. Both entry shapes resolve the
    // same way; the only difference is delivery (see below): a step-only entry
    // is EXCLUDED from `leaseInjectableEnv` so its value never lands in the
    // lease process environment.
    const requirements = parseEnvRequirements(playbook.env_requirements);
    const env: Record<string, string> = {};
    const leaseInjectableEnv: Record<string, string> = {};
    const missing: string[] = [];
    for (const req of requirements) {
      const name = envRequirementName(req);
      const value = await deps.resolveEnv(name);
      if (value === undefined) {
        missing.push(name);
        continue;
      }
      // `env` is the map templates render against and the redaction set masks —
      // it carries EVERY resolved value regardless of delivery mode, so a
      // step-only secret spliced into a rendered command still gets masked in
      // logs even though the lease env below never sees it.
      env[name] = value;
      if (envRequirementInLeaseEnv(req)) {
        leaseInjectableEnv[name] = value;
      }
    }
    if (missing.length > 0) {
      throw new Error(`missing required secrets: ${missing.join(", ")}`);
    }

    // Resolve the image (a `setting:<key>` reference is looked up now) before
    // any lease is created, so a misconfigured image fails without leasing.
    const image = await resolveImage(playbook.image, db);
    // userdata may be a whole-value `snippet:<name>` reference (kind='userdata'),
    // resolved BEFORE leasing; the resolved content is then rendered by the normal
    // engine as today. There is no {{snippet.*}} stacking inside userdata content —
    // that composition model is exclusive to prompt snippets.
    const userdataTemplate = await resolveSnippetReference(
      playbook.userdata_template,
      "userdata",
      db
    );
    // userdata_template is rendered with the LEASE env root only (the same map
    // handed to createLease below, with step-only secrets excluded), so a
    // step-only value can never reach the container via userdata even though
    // the entry is resolvable elsewhere by name.
    const userdata = renderTemplate(userdataTemplate, promptEvent, {
      env: leaseInjectableEnv,
    });

    // Render the prompt BEFORE the lease is created. Its inputs — the event, the
    // playbook templates, and the granted capabilities (which fetch from external
    // services keyed only by the event's subject_ref) — none depend on the lease,
    // so nothing about the rendered output changes by moving it earlier. Doing it
    // here lets a windows lease carry the prompt in its environment at create time
    // (below), keeping it off the command line where `cmd /c` would reject it.
    const capabilityContext = await resolveCapabilityContext(
      playbook.granted_capabilities,
      promptEvent,
      requirements.map(envRequirementName),
      deps.registry ?? getRuntime().registry,
      db,
      logger
    );
    // Resolve the prompt's {{snippet.<name>}} tokens (kind='prompt') into a
    // fully-expanded map BEFORE leasing: an unknown name, a cycle, or nesting past
    // MAX_SNIPPET_DEPTH fails the dispatch here rather than silently dropping
    // prompt text. A snippet's content may itself reference event/payload/env and
    // further snippets. renderTemplate stays pure; buildPrompt only splices the map.
    // The env root handed to snippet expansion is the LEASE env only (step-only
    // secrets excluded), because a prompt snippet's content is spliced into the
    // prompt the agent sees. A step-only value must not be reachable through
    // this path any more than through prompt_template itself.
    const promptSnippets = await resolvePromptSnippets(
      playbook.prompt_template,
      promptEvent,
      leaseInjectableEnv,
      db
    );
    const prompt = buildPrompt({
      event: promptEvent,
      playbook,
      workingEnvironment: deps.workingEnvironment ?? DEFAULT_WORKING_ENVIRONMENT,
      capabilityContext,
      promptSnippets,
      // prompt_template's `env` root is the LEASE env only (step-only secrets
      // excluded), so a step-only value never reaches the prompt handed to the
      // agent. The value is already delivered to the container through
      // leaseInjectableEnv, so naming it in the prompt only tells the agent it
      // exists; it does not leak a secret the agent could not otherwise see.
      env: leaseInjectableEnv,
    });

    // Prompt-driven runners (the `claude-code` runner) stage the fully
    // rendered prompt into the lease as a file at create time (the wisper
    // contract's `files` array), and the built agent command reads it on
    // stdin. No rendered prompt content ever appears in any exec command, so
    // neither the windows argv/env caps nor the cmd 8191-char ceiling ever
    // come into play regardless of prompt length. A runner without a
    // `promptFilePath` (the `script` runner) stages no prompt file.
    //
    // The wisper contract caps the summed decoded byte size of every staged
    // file at 1 MiB (MAX_FILES_TOTAL_BYTES). The rendered prompt is the only
    // file the executor stages today, so an oversize prompt fails the
    // dispatch HERE, BEFORE any lease is created, exactly like a missing
    // secret. A larger overall budget will only ever add files (never
    // subtract the prompt's own headroom), so this bound is tight enough.
    const leaseFiles: LeaseFileSpec[] = [];
    if (runner.promptFilePath) {
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > MAX_FILES_TOTAL_BYTES) {
        throw new Error(
          `rendered prompt is ${promptBytes} bytes, exceeds the ${MAX_FILES_TOTAL_BYTES}-byte lease file budget`
        );
      }
      leaseFiles.push({
        path: runner.promptFilePath,
        content_base64: Buffer.from(prompt, "utf8").toString("base64"),
      });
    }

    // The lease env is the resolved secrets — EXCLUDING any marked
    // `inject: "step-only"` (see `parseEnvRequirements`), so a one-shot secret
    // used in a `pre` step's command_template never persists in the container
    // environment for the agent step to read. The rendered prompt is
    // deliberately NOT in this map: it travels as a lease FILE (see
    // `leaseFiles` above), not as an env variable, so the windows per-variable
    // ceiling and cmd argv ceiling are unreachable here. `env` (the map
    // templates render against and maskSecrets redacts) is a separate concern
    // and stays keyed only on resolved secrets.
    const leaseEnv: Record<string, string> = { ...leaseInjectableEnv };

    // Capture the (server-requested) TTL now so the exec-timeout resolver has
    // a `remaining_ttl` to derive the per-call default from once the lease
    // exists. Set BEFORE createLease so we do not race with any exec on an
    // already-known TTL.
    leaseTtlSeconds = playbook.ttl_seconds;

    const lease = await deps.wisper.createLease({
      image,
      // The playbook's optional host selector, threaded verbatim. `null` (the
      // default) falls back to the client's configured host id; in v1 mode the
      // client resolves the (host, image) NAMES against the catalog before
      // leasing, so an unknown host or unoffered image fails here — pre-lease,
      // exactly like a missing secret or snippet.
      host: playbook.host ?? undefined,
      // The playbook's optional isolation level, threaded verbatim. `null` (the
      // default) lets the wisper server apply its own default ("shared"); in v1
      // mode a non-null value that the selected host cannot provide fails here —
      // pre-lease, exactly like an unknown host or unoffered image.
      isolation: playbook.isolation ?? undefined,
      network: playbook.network,
      resources: playbook.resources,
      ttl_seconds: playbook.ttl_seconds,
      userdata,
      env: Object.keys(leaseEnv).length > 0 ? leaseEnv : undefined,
      files: leaseFiles.length > 0 ? leaseFiles : undefined,
      signal: controller.signal,
    });
    leaseId = lease.leaseId;
    // Stamp the lease-start clock right after the server acknowledges the
    // lease. From here on every per-call exec timeout is computed against
    // this moment via {@link resolveExecTimeoutMs}, so a step that starts near
    // the tail of a long-lived lease gets a shorter budget than one that
    // starts immediately after.
    leaseStartedAtMs = now();
    await updateDispatch(
      dispatchId,
      { lease_id: lease.leaseId, wisp_contract_id: lease.wispContractId },
      db
    );
    logger.info("lease created", { leaseId: lease.leaseId });
    // Emit the RESOLVED per-call exec timeout right after the lease exists;
    // it is the same number the first exec below will use. `derivation` names
    // WHY that number was chosen (override | ttl-derived | cap) so an operator
    // reading the log can tell at a glance whether WISPER_EXEC_TIMEOUT_MS was
    // honored, whether the lease's remaining TTL drove it, or whether the
    // multi-hour cap clamped a very long TTL. Every step start line below
    // still carries its own resolved value, which may shrink as the lease ages.
    // Value AND derivation are computed against the lease-start clock
    // (`nowMs === leaseStartedAtMs`) so `remaining_ttl` is exactly the full
    // TTL and the two never disagree due to sub-millisecond drift between
    // two now() calls; the per-step start lines below re-resolve against
    // the current clock, which is where any shrinkage shows up.
    logger.info("exec timeout resolved", {
      execTimeoutMs: resolveExecTimeoutMs(
        configuredExecTimeoutMs,
        leaseTtlSeconds,
        leaseStartedAtMs,
        leaseStartedAtMs
      ),
      derivation: classifyExecTimeoutDerivation(
        configuredExecTimeoutMs,
        leaseTtlSeconds,
        leaseStartedAtMs,
        leaseStartedAtMs
      ),
    });

    // --- pre steps (after lease creation, before the agent exec) -----------
    // Each is rendered with the same template engine as the prompt, with an
    // added `env` root. Only the MASKED command is ever logged. A non-zero exit
    // fails the dispatch (the finally block still releases the lease) and the
    // throw short-circuits every remaining step.
    for (const step of steps) {
      if (step.phase !== "pre") continue;
      const command = renderTemplate(step.command_template, promptEvent, {
        env,
      });
      const masked = maskSecrets(command, env);
      openedLog.append(`$ pre[${step.label}]: ${masked}`);
      const preStepTimeoutMs = perCallTimeout();
      logger.info("pre step", {
        label: step.label,
        command: masked,
        execTimeoutMs: preStepTimeoutMs,
      });
      const stepResult = await deps.wisper.execSync(lease.leaseId, command, {
        timeoutMs: preStepTimeoutMs,
        signal: controller.signal,
      });
      // Persist the step's (masked) output so a failure is diagnosable from the
      // dispatch log rather than reduced to a bare exit code.
      if (stepResult.stdout.trim()) {
        openedLog.append(maskSecrets(stepResult.stdout, env));
      }
      if (stepResult.stderr.trim()) {
        openedLog.append(maskSecrets(stepResult.stderr, env));
      }
      if (stepResult.exitCode !== 0) {
        const stderrTail = maskSecrets(stepResult.stderr, env)
          .trim()
          .split("\n")
          .slice(-3)
          .join(" | ");
        throw new Error(
          `pre step "${step.label}" exited with non-zero code ${stepResult.exitCode}` +
            (stderrTail ? ` — ${stderrTail}` : "")
        );
      }
    }

    // --- running -----------------------------------------------------------
    await updateDispatch(dispatchId, { status: "running" }, db);
    // The runner shapes the agent command from its opaque runner_config and
    // the lease OS. A prompt-driven runner (the `claude-code` runner) reads
    // the rendered prompt from its `promptFilePath` on stdin; the prompt was
    // staged into the lease as a file at create time (above), so no rendered
    // prompt content appears in the built command. The command context
    // carries the event and resolved secrets a template-driven runner renders
    // its command against (e.g. the `script` runner's command_template); a
    // prompt-driven runner ignores it.
    const command = runner.buildCommand(runnerConfig, lease.os, {
      event: promptEvent,
      env,
    });

    // Only a MASKED form of the command is ever logged: a runner may render
    // resolved secret values into it (the `script` runner's `{{env.*}}`), so it
    // must pass through maskSecrets before touching any log, exactly like the
    // pre/collect step commands above.
    const maskedCommand = maskSecrets(command, env);
    openedLog.append(`$ agent: ${maskedCommand}`);
    const agentTimeoutMs = perCallTimeout();
    logger.info("agent step", {
      command: maskedCommand,
      execTimeoutMs: agentTimeoutMs,
    });

    const runStartedAt = now();
    const result = await deps.wisper.execStream(lease.leaseId, command, {
      // Inter-chunk idle timeout for the stream (not a wall-clock cap): the
      // per-dispatch deadline armed above bounds total run time. Derived
      // per-call from the lease's remaining TTL so a long-running agent that
      // pauses between chunks is not killed by a fixed 60s idle window; see
      // resolveExecTimeoutMs.
      timeoutMs: agentTimeoutMs,
      signal: controller.signal,
      onChunk: (chunk) => {
        output += chunk.data;
        // Best-effort masking of the live stream: a secret split across two
        // chunks can slip through here (per-chunk masking cannot see the
        // boundary), so this is only a defense-in-depth layer. The persisted
        // result_text below masks the fully-assembled text and is the real
        // guarantee. We deliberately avoid cross-chunk buffering so streaming
        // stays live.
        openedLog.append(maskSecrets(chunk.data, env));
      },
    });
    logger.info("agent exec complete", { exitCode: result.exitCode });

    // The exit code is the SOLE success signal. Any non-zero code is a failure.
    if (result.exitCode !== 0) {
      throw new Error(`agent exited with non-zero code ${result.exitCode}`);
    }

    // A zero exit is necessary but NOT sufficient. The runner parses the raw
    // output; a `null` return means the engine did not actually produce a valid
    // result — e.g. a shell echoed the invocation text (quoting bug) and exited 0.
    // Treat that as a failure so a bogus "done" run is never recorded, and so the
    // echoed prompt (which carries the protocol's own example NOTES_TO_SAVE
    // block) can never be mistaken for real output.
    const parsed = runner.parseOutput(output);
    if (parsed === null) {
      throw new Error(runner.missingResultError);
    }
    const resultText = parsed.resultText;
    // Guaranteed masking of the persisted result: the agent may echo an injected
    // secret (Anthropic token, git token, ...) into its own stdout, which would
    // otherwise land on disk in cleartext. Mask the fully-assembled text with the
    // same resolved secret values used for step output before it is stored. This
    // is not subject to the per-chunk boundary hazard above.
    const maskedResultText = maskSecrets(resultText, env);

    // --- collecting (success only) -----------------------------------------
    await updateDispatch(dispatchId, { status: "collecting" }, db);
    // Collect steps run ONLY after the agent exits 0. Each step's stdout is
    // captured on the run keyed by its label; a non-zero collect exit is logged
    // but never fatal, so every collect step always runs.
    const collected: Record<string, string> = {};
    for (const step of steps) {
      if (step.phase !== "collect") continue;
      const command = renderTemplate(step.command_template, promptEvent, {
        env,
      });
      const masked = maskSecrets(command, env);
      openedLog.append(`$ collect[${step.label}]: ${masked}`);
      const collectStepTimeoutMs = perCallTimeout();
      logger.info("collect step", {
        label: step.label,
        command: masked,
        execTimeoutMs: collectStepTimeoutMs,
      });
      const stepResult = await deps.wisper.execSync(lease.leaseId, command, {
        timeoutMs: collectStepTimeoutMs,
        signal: controller.signal,
      });
      collected[step.label] = stepResult.stdout;
      if (stepResult.exitCode !== 0) {
        logger.warn("collect step non-zero exit", {
          label: step.label,
          exitCode: stepResult.exitCode,
        });
      }
    }

    const run = await createRun(
      {
        dispatch_id: dispatchId,
        exit_code: result.exitCode,
        result_text: maskedResultText,
        usage: parsed.usage,
        collected: Object.keys(collected).length > 0 ? collected : null,
        log_path: openedLog.path,
        started_at: runStartedAt,
        ended_at: Date.now(),
      },
      db
    );
    // NOTES_TO_SAVE blocks are honored ONLY from inside the DECODED result
    // envelope text (`resultText`, isolated by parseResultText above) — never
    // scraped from raw stdout. The prompt itself embeds an example block, so a
    // shell that merely echoed the prompt would otherwise let that placeholder be
    // harvested as a bogus finding. Parsing solely from the envelope closes that
    // hole; a missing envelope has already failed the dispatch above.
    const { notes, warnings } = parseNotes(resultText);
    if (warnings.length > 0) {
      logger.warn("skipped malformed findings", { warnings });
    }
    for (const note of notes) {
      await createFinding(
        {
          run_id: run.id,
          content: note.content,
          tags: note.tags,
          visibility: note.visibility,
        },
        db
      );
    }

    // --- done --------------------------------------------------------------
    await updateDispatch(dispatchId, { status: "done", error: null }, db);
    logger.info("dispatch done", { runId: run.id, findings: notes.length });
  } catch (err) {
    // --- failed ------------------------------------------------------------
    await recordFailure(err);
  } finally {
    // Disarm the deadline timer and drop the external-signal listener so neither
    // outlives the run (and no timer keeps the process alive).
    if (timeoutTimer) clearTimeout(timeoutTimer);
    detachExternalSignal();
    dispatchLog?.close();
    // HARD RULE: whenever a lease was created it is released on EVERY path.
    // In-line: try the DELETE, retry a couple of times on retryable errors
    // (host_offline/upstream_timeout/client-side timeout), then either mark
    // released_at on success OR flip release_pending so the periodic sweep
    // keeps retrying. A `not_found` response is treated as success (the lease
    // is gone by the desired definition). Never rethrows — the release path
    // is intentionally decoupled from the run's success/failure outcome, and
    // does NOT carry the caller's signal so an aborted run still frees its
    // lease. Release uses its OWN short per-call timeout
    // (WISPER_RELEASE_TIMEOUT_MS, default DEFAULT_RELEASE_TIMEOUT_MS), NOT the
    // exec-timeout window: release is a quick control-plane DELETE and a hung
    // socket must not block dispatcher shutdown or the sweep for hours the
    // way the exec-timeout cap would.
    if (leaseId !== null) {
      const outcome = await attemptLeaseRelease(
        deps.wisper,
        leaseId,
        releaseTimeoutMs
      );
      if (outcome.ok) {
        await updateDispatch(
          dispatchId,
          { released_at: Date.now(), release_pending: false },
          db
        );
        logger.info("lease released", { leaseId, releaseTimeoutMs });
      } else {
        await updateDispatch(dispatchId, { release_pending: true }, db);
        logger.error("lease release failed; marked release_pending", {
          leaseId,
          error: outcome.error,
        });
      }
    }
  }

  const finalDispatch = await getDispatch(dispatchId, db);
  if (!finalDispatch) {
    throw new Error(`runDispatch: dispatch ${dispatchId} vanished mid-run`);
  }
  return { ...finalDispatch, retryable };
}

/**
 * The in-flight dispatch states a process restart orphans. A dispatch in any of
 * these had a `runDispatch` call in progress when the process died, so its
 * in-memory pipeline (and any lease it held) is gone; nothing will ever advance
 * it. Terminal states (`done`, `failed`) and the not-yet-started `queued` are
 * untouched — `queued` is still perfectly claimable after a restart.
 */
const ORPHANED_ON_RESTART: DispatchStatus[] = [
  "leasing",
  "running",
  "collecting",
];

/** Injected collaborators for {@link reconcileOrphanedDispatches}. */
export interface ReconcileDeps {
  /**
   * Wisper client used to release orphaned leases. Pass `null`/omit when leasing
   * is unconfigured: dispatches are still failed, but their leases can only be
   * left to the lease TTL failsafe (a warning is logged for each).
   */
  wisper?: WisperClient | null;
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /**
   * Per-call timeout in ms for the orphaned-lease releases. When unset falls
   * back to {@link DEFAULT_RELEASE_TIMEOUT_MS}. Release is a quick
   * control-plane DELETE, so this MUST NOT reuse the multi-hour exec-timeout
   * cap: boot awaits this reconcile sequentially before the dispatcher
   * starts, and a hung socket per orphan would otherwise stall startup by
   * hours per row. Boot threads the configured `WISPER_RELEASE_TIMEOUT_MS`.
   */
  releaseTimeoutMs?: number;
}

/**
 * Recover from an unclean shutdown. Every dispatch left in an in-flight state
 * ({@link ORPHANED_ON_RESTART}) is marked `failed` with error
 * `orphaned_by_restart`, and any lease it still held is released best-effort — a
 * release error flips `release_pending` so the periodic sweep keeps retrying,
 * matching the pipeline's lease hygiene. Call this ONCE on boot, after
 * migrations and before the dispatcher loop starts, so no half-run dispatch is
 * ever picked back up mid-pipeline.
 *
 * A dispatch left in `leasing` with NO lease_id means the process died between
 * flipping to `leasing` and the createLease response landing: a lease may exist
 * server-side that we no longer have a handle for, and the only backstop is the
 * lease TTL. That is a loud warning here, not a silent skip.
 *
 * Returns the number of dispatches reconciled and logs a one-line summary.
 */
export async function reconcileOrphanedDispatches(
  deps: ReconcileDeps = {}
): Promise<number> {
  const db = deps.db ?? getDb();
  const logger = deps.logger ?? log;
  const releaseTimeoutMs =
    deps.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;

  const orphans: DispatchRecord[] = [];
  for (const status of ORPHANED_ON_RESTART) {
    orphans.push(...(await listDispatches(status, db)));
  }

  let leasesReleased = 0;
  for (const dispatch of orphans) {
    await updateDispatch(
      dispatch.id,
      { status: "failed", error: "orphaned_by_restart" },
      db
    );
    if (!dispatch.lease_id) {
      // A `leasing` orphan with NO lease_id is a crash mid-createLease: the
      // server may have provisioned a lease we never saw the id of. Warn
      // loudly — only the lease TTL can catch this — so the operator can
      // notice and cross-check the wisper host.
      if (dispatch.status === "leasing") {
        logger.warn(
          "orphaned dispatch in 'leasing' with no lease_id; a server-side lease may exist that only the TTL failsafe will reap",
          { dispatchId: dispatch.id }
        );
      }
      continue;
    }
    if (!deps.wisper) {
      logger.warn("orphaned lease left to TTL failsafe (wisper unconfigured)", {
        dispatchId: dispatch.id,
        leaseId: dispatch.lease_id,
      });
      // No wisper client → we cannot succeed OR set released_at. Leave it flagged
      // so the sweep tries once leasing is configured.
      await updateDispatch(dispatch.id, { release_pending: true }, db);
      continue;
    }
    const outcome = await attemptLeaseRelease(
      deps.wisper,
      dispatch.lease_id,
      releaseTimeoutMs
    );
    if (outcome.ok) {
      await updateDispatch(
        dispatch.id,
        { released_at: Date.now(), release_pending: false },
        db
      );
      leasesReleased += 1;
    } else {
      await updateDispatch(dispatch.id, { release_pending: true }, db);
      logger.error("orphaned lease release failed; marked release_pending", {
        dispatchId: dispatch.id,
        leaseId: dispatch.lease_id,
        error: outcome.error,
      });
    }
  }

  logger.info("startup reconciliation complete", {
    orphaned: orphans.length,
    leasesReleased,
  });
  return orphans.length;
}

/** Injected collaborators for {@link sweepPendingReleases}. */
export interface SweepDeps {
  /** Wisper client used to release stranded leases. Required — the sweep is a no-op without one. */
  wisper: WisperClient;
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /**
   * Per-call timeout in ms for the release attempts. Defaults to
   * {@link DEFAULT_RELEASE_TIMEOUT_MS} when unset; boot threads the
   * configured `WISPER_RELEASE_TIMEOUT_MS`. Release is a quick control-plane
   * DELETE, so this MUST NOT reuse the multi-hour exec-timeout cap: a hung
   * socket per stranded lease would otherwise stall a whole sweep pass for
   * hours per row.
   */
  releaseTimeoutMs?: number;
  /**
   * Wall clock, injectable for deterministic tests; defaults to `Date.now`.
   * Used to compute the per-lease backoff window against
   * {@link SweepDeps.backoffMs}.
   */
  now?: () => number;
  /**
   * Minimum interval, in ms, between sweep attempts for the SAME lease. A
   * dead host must not hot-loop: after a failed release the sweep waits at
   * least this long before trying that lease again. Judged against the row's
   * `updated_at` (which the failing update above bumps). Defaults to 60_000.
   */
  backoffMs?: number;
}

/**
 * Default per-lease backoff between sweep attempts: a stranded lease is retried
 * no more often than every {@link DEFAULT_SWEEP_BACKOFF_MS}ms while wisper keeps
 * failing, so a persistently offline host does not hot-loop.
 */
export const DEFAULT_SWEEP_BACKOFF_MS = 60_000;

/**
 * Sweep for dispatches whose lease is still owed to wisper and whose dispatch
 * is already in a terminal state (`done`/`failed`) — see
 * {@link listDispatchesWithPendingRelease} for the exact predicate. A per-lease
 * cooldown ({@link SweepDeps.backoffMs}, default
 * {@link DEFAULT_SWEEP_BACKOFF_MS}) throttles retries against a dead host so
 * the sweep never hot-loops. Returns the number of leases released this pass.
 *
 * Safe to run alongside the executor precisely BECAUSE of the terminal-status
 * filter: an in-flight dispatch's lease is owned by `runDispatch`'s own
 * release path (which writes `released_at` in its finally block), and the
 * sweep is prohibited from touching it. Terminal rows are the sweep's
 * exclusive domain — either a successful run whose in-line release DELETE
 * failed, or a `failed` row left behind by {@link reconcileOrphanedDispatches}
 * (which flips crashed in-flight rows to `failed` before the periodic sweep
 * ever runs).
 */
export async function sweepPendingReleases(
  deps: SweepDeps
): Promise<number> {
  const db = deps.db ?? getDb();
  const logger = deps.logger ?? log;
  const releaseTimeoutMs =
    deps.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const backoffMs = deps.backoffMs ?? DEFAULT_SWEEP_BACKOFF_MS;

  const pending = await listDispatchesWithPendingRelease(db);
  let released = 0;
  const nowMs = now();
  for (const dispatch of pending) {
    if (dispatch.lease_id === null) continue; // narrows for the type checker
    // Per-lease backoff: if the last attempt was within `backoffMs`, skip this
    // pass. `updated_at` is bumped by the failing update above, so it doubles
    // as a "last tried at" clock for the pending-release cohort.
    if (dispatch.release_pending && nowMs - dispatch.updated_at < backoffMs) {
      continue;
    }
    const outcome = await attemptLeaseRelease(
      deps.wisper,
      dispatch.lease_id,
      releaseTimeoutMs
    );
    if (outcome.ok) {
      await updateDispatch(
        dispatch.id,
        { released_at: now(), release_pending: false },
        db
      );
      released += 1;
      logger.info("sweep released stranded lease", {
        dispatchId: dispatch.id,
        leaseId: dispatch.lease_id,
      });
    } else {
      await updateDispatch(dispatch.id, { release_pending: true }, db);
      logger.warn("sweep release still failing; keeping release_pending", {
        dispatchId: dispatch.id,
        leaseId: dispatch.lease_id,
        error: outcome.error,
      });
    }
  }
  return released;
}
