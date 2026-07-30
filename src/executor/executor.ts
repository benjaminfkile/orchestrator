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
import { getDispatch, listDispatches, updateDispatch } from "../db/dispatches";
import { getEventById } from "../db/events";
import { createFinding } from "../db/findings";
import { getModuleConfig } from "../db/moduleConfig";
import { getPlaybook } from "../db/playbooks";
import { createRun } from "../db/runs";
import { getSetting } from "../db/settings";
import type {
  DispatchRecord,
  DispatchStatus,
  EventRecord,
  GrantedCapability,
  PlaybookStep,
} from "../interfaces";
import { log, type Logger } from "../log";
import type { ModuleRegistry } from "../modules/registry";
import { getRuntime } from "../runtime";
import { openDispatchLog } from "../services/dispatchLog";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  WisperApiError,
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
   * Per-call timeout in ms for exec and release operations, and the inter-chunk
   * idle window for the streaming agent exec (NOT a wall-clock cap on total run
   * time). Defaults to {@link DEFAULT_EXEC_TIMEOUT_MS}; the dispatcher threads
   * the configured `WISPER_EXEC_TIMEOUT_MS`. The create-lease timeout is carried
   * by the {@link WisperClient} itself (its construction-time timeout), not here.
   */
  execTimeoutMs?: number;
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
 * reference. The seed `researcher` playbook stores `setting:default_lease_image`
 * so the image can be reconfigured without editing the playbook.
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
  const execTimeoutMs = deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const logger = (deps.logger ?? log).child({ dispatchId });

  const dispatch = await getDispatch(dispatchId, db);
  if (!dispatch) {
    throw new Error(`runDispatch: dispatch ${dispatchId} not found`);
  }

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

  const dispatchLog = openDispatchLog(dispatchId, { baseDir: deps.logBaseDir });

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
    logger.error("dispatch failed", { error: message, retryable });
    await updateDispatch(dispatchId, { status: "failed", error: message }, db);
  };

  try {
    const playbook = await getPlaybook(dispatch.playbook_id, db);
    if (!playbook) {
      throw new Error(`playbook ${dispatch.playbook_id} not found`);
    }

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
    // only the NAMES — never a resolved value.
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of playbook.env_requirements) {
      const value = await deps.resolveEnv(name);
      if (value === undefined) {
        missing.push(name);
      } else {
        env[name] = value;
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
    const userdata = renderTemplate(userdataTemplate, promptEvent);

    // Render the prompt BEFORE the lease is created. Its inputs — the event, the
    // playbook templates, and the granted capabilities (which fetch from external
    // services keyed only by the event's subject_ref) — none depend on the lease,
    // so nothing about the rendered output changes by moving it earlier. Doing it
    // here lets a windows lease carry the prompt in its environment at create time
    // (below), keeping it off the command line where `cmd /c` would reject it.
    const capabilityContext = await resolveCapabilityContext(
      playbook.granted_capabilities,
      promptEvent,
      playbook.env_requirements,
      deps.registry ?? getRuntime().registry,
      db,
      logger
    );
    // Resolve the prompt's {{snippet.<name>}} tokens (kind='prompt') into a
    // fully-expanded map BEFORE leasing: an unknown name, a cycle, or nesting past
    // MAX_SNIPPET_DEPTH fails the dispatch here rather than silently dropping
    // prompt text. A snippet's content may itself reference event/payload/env and
    // further snippets. renderTemplate stays pure; buildPrompt only splices the map.
    const promptSnippets = await resolvePromptSnippets(
      playbook.prompt_template,
      promptEvent,
      env,
      db
    );
    const prompt = buildPrompt({
      event: promptEvent,
      playbook,
      workingEnvironment: deps.workingEnvironment ?? DEFAULT_WORKING_ENVIRONMENT,
      capabilityContext,
      promptSnippets,
    });

    // A runner may deliver the prompt through the lease environment (the windows
    // command shape does; see the runner), where a single variable is capped at
    // 32767 chars. A prompt past the runner's headroom bound would be silently
    // truncated by the OS into a corrupt prompt, so it must fail the dispatch
    // instead — but only on a windows lease, whose OS family is not known until
    // createLease returns. So the oversized prompt is kept OUT of the lease env
    // here (nothing would ever read it), and the dispatch is failed once the
    // lease's OS is known, below. A runner without a bound never fails this way.
    const promptTooLargeForWindows =
      runner.maxWindowsPromptChars !== undefined &&
      prompt.length > runner.maxWindowsPromptChars;

    // The lease env is the resolved secrets PLUS, unless oversized, the rendered
    // prompt under the runner's prompt env var. This map is deliberately distinct
    // from `env` (the secrets used for masking and step rendering): the prompt is
    // not a secret, so it must never enter maskSecrets — masking it would redact
    // the whole log. A command shape that ignores this variable (the linux shape
    // passes the prompt as an argv argument) makes carrying it there harmless.
    const leaseEnv: Record<string, string> = { ...env };
    if (runner.promptEnvVar && !promptTooLargeForWindows) {
      leaseEnv[runner.promptEnvVar] = prompt;
    }

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
      signal: controller.signal,
    });
    leaseId = lease.leaseId;
    await updateDispatch(
      dispatchId,
      { lease_id: lease.leaseId, wisp_contract_id: lease.wispContractId },
      db
    );
    logger.info("lease created", { leaseId: lease.leaseId });

    // Now the lease's OS is known: a windows lease with an over-limit prompt is
    // failed with a clear error before any exec runs (the finally block still
    // releases the lease), rather than letting the truncated env value reach the
    // agent. A linux lease is unaffected — it carries the prompt as an argv
    // argument, which has no such per-variable ceiling.
    if (lease.os === "windows" && promptTooLargeForWindows) {
      throw new Error(
        `prompt too large for windows lease: ${prompt.length} chars exceeds the ${runner.maxWindowsPromptChars}-char limit`
      );
    }

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
      dispatchLog.append(`$ pre[${step.label}]: ${masked}`);
      logger.info("pre step", { label: step.label, command: masked });
      const stepResult = await deps.wisper.execSync(lease.leaseId, command, {
        timeoutMs: execTimeoutMs,
        signal: controller.signal,
      });
      // Persist the step's (masked) output so a failure is diagnosable from the
      // dispatch log rather than reduced to a bare exit code.
      if (stepResult.stdout.trim()) {
        dispatchLog.append(maskSecrets(stepResult.stdout, env));
      }
      if (stepResult.stderr.trim()) {
        dispatchLog.append(maskSecrets(stepResult.stderr, env));
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
    // The prompt was rendered before the lease was created (above); the runner
    // shapes the agent command from it and the lease OS. The playbook's opaque
    // runner_config is passed through verbatim — only the runner interprets it.
    // The command context carries the event and resolved secrets a template-driven
    // runner renders its command against (e.g. the `script` runner's
    // command_template); a prompt-driven runner ignores it.
    const command = runner.buildCommand(prompt, runnerConfig, lease.os, {
      event: promptEvent,
      env,
    });

    // Only a MASKED form of the command is ever logged: a runner may render
    // resolved secret values into it (the `script` runner's `{{env.*}}`), so it
    // must pass through maskSecrets before touching any log, exactly like the
    // pre/collect step commands above.
    const maskedCommand = maskSecrets(command, env);
    dispatchLog.append(`$ agent: ${maskedCommand}`);
    logger.info("agent step", { command: maskedCommand });

    const runStartedAt = now();
    const result = await deps.wisper.execStream(lease.leaseId, command, {
      // Inter-chunk idle timeout for the stream (not a wall-clock cap): the
      // per-dispatch deadline armed above bounds total run time.
      timeoutMs: execTimeoutMs,
      signal: controller.signal,
      onChunk: (chunk) => {
        output += chunk.data;
        // Best-effort masking of the live stream: a secret split across two
        // chunks can slip through here (per-chunk masking cannot see the
        // boundary), so this is only a defense-in-depth layer. The persisted
        // result_text below masks the fully-assembled text and is the real
        // guarantee. We deliberately avoid cross-chunk buffering so streaming
        // stays live.
        dispatchLog.append(maskSecrets(chunk.data, env));
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
      dispatchLog.append(`$ collect[${step.label}]: ${masked}`);
      logger.info("collect step", { label: step.label, command: masked });
      const stepResult = await deps.wisper.execSync(lease.leaseId, command, {
        timeoutMs: execTimeoutMs,
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
        log_path: dispatchLog.path,
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
    dispatchLog.close();
    // HARD RULE: whenever a lease was created it is released on EVERY path.
    // Best-effort — release errors are logged, never rethrown — and without the
    // caller's signal so an aborted run still frees its lease.
    if (leaseId !== null) {
      try {
        // Release shares the exec timeout window (see WisperClient defaults); it
        // is passed explicitly because the client's construction-time timeout is
        // the longer create-lease ceiling.
        await deps.wisper.releaseLease(leaseId, { timeoutMs: execTimeoutMs });
        logger.info("lease released", { leaseId });
      } catch (releaseErr) {
        logger.error("lease release failed", {
          leaseId,
          error: errorMessage(releaseErr),
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
   * Per-call timeout in ms for the orphaned-lease releases. Defaults to
   * {@link DEFAULT_EXEC_TIMEOUT_MS}; boot threads the configured
   * `WISPER_EXEC_TIMEOUT_MS` so release matches the running pipeline.
   */
  execTimeoutMs?: number;
}

/**
 * Recover from an unclean shutdown. Every dispatch left in an in-flight state
 * ({@link ORPHANED_ON_RESTART}) is marked `failed` with error
 * `orphaned_by_restart`, and any lease it still held is released best-effort — a
 * release error is logged and never rethrown, matching the pipeline's lease
 * hygiene. Call this ONCE on boot, after migrations and before the dispatcher
 * loop starts, so no half-run dispatch is ever picked back up mid-pipeline.
 *
 * Returns the number of dispatches reconciled and logs a one-line summary.
 */
export async function reconcileOrphanedDispatches(
  deps: ReconcileDeps = {}
): Promise<number> {
  const db = deps.db ?? getDb();
  const logger = deps.logger ?? log;
  const execTimeoutMs = deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

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
    if (!dispatch.lease_id) continue;
    if (!deps.wisper) {
      logger.warn("orphaned lease left to TTL failsafe (wisper unconfigured)", {
        dispatchId: dispatch.id,
        leaseId: dispatch.lease_id,
      });
      continue;
    }
    try {
      await deps.wisper.releaseLease(dispatch.lease_id, {
        timeoutMs: execTimeoutMs,
      });
      leasesReleased += 1;
    } catch (releaseErr) {
      logger.error("orphaned lease release failed", {
        dispatchId: dispatch.id,
        leaseId: dispatch.lease_id,
        error: errorMessage(releaseErr),
      });
    }
  }

  logger.info("startup reconciliation complete", {
    orphaned: orphans.length,
    leasesReleased,
  });
  return orphans.length;
}
