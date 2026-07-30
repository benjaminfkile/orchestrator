/**
 * The runner seam.
 *
 * A {@link Runner} is a registered unit that owns the two engine-specific parts
 * of a dispatch the executor must otherwise not know about:
 *
 *   1. building the agent-step exec command from a rendered prompt and an opaque
 *      per-runner config, for the lease's OS family, and
 *   2. parsing that command's raw captured output back into a result string and
 *      usage totals.
 *
 * Everything else about a dispatch — lease lifecycle, pre/collect steps,
 * exit-code success, the deadline, secret hygiene, and NOTES_TO_SAVE findings —
 * stays in the executor and is engine-neutral. This interface is the ONLY place
 * an engine's specifics (its CLI flags, its output envelope shape, its auth-error
 * strings, how it receives the prompt) may live; the executor resolves a runner
 * from the registry and delegates through this surface.
 */

import type { PromptEvent } from "../executor/prompt";
import type { LeaseOs } from "../wisper/client";

/**
 * Everything a runner may need to render its agent-step command beyond the
 * prompt and its own config. The executor assembles this before building the
 * command; a runner that carries no templates (the `claude-code` runner) simply
 * ignores it, while a template-driven runner (the `script` runner) renders its
 * `command_template` against `event`/`payload` and the resolved secrets.
 */
export interface RunnerCommandContext {
  /** The dispatch's event — the source of `{{event.*}}`/`{{payload.*}}`. */
  event: PromptEvent;
  /** Resolved playbook secrets, keyed by name — the source of `{{env.*}}`. */
  env: Record<string, string>;
}

/** A runner's parsed output: the agent's result text plus opaque usage data. */
export interface RunnerOutput {
  /** The agent's final result text — the input to NOTES_TO_SAVE parsing. */
  resultText: string;
  /** Opaque, runner-defined usage metrics persisted verbatim on the run. */
  usage: unknown;
}

/**
 * A registered engine behind which all agent-command and output-parsing
 * specifics live. Kept deliberately minimal: the executor consumes only this
 * surface, so nothing engine-specific leaks into the pipeline.
 */
export interface Runner {
  /** Stable identifier used to register and resolve the runner. */
  readonly id: string;

  /**
   * Build the agent-step exec command for a lease of OS family `os`, from the
   * fully rendered `prompt`, the runner's opaque `config`, and the shared
   * {@link RunnerCommandContext}. `os` comes from the create-lease response; a
   * runner may shape the command differently per OS (e.g. delivering the prompt
   * via {@link promptEnvVar} rather than the command line). `null`/unrecognized
   * values are the runner's own fallback case. `ctx` supplies the event and
   * resolved secrets for a runner whose command is itself a rendered template;
   * a prompt-driven runner ignores it.
   */
  buildCommand(
    prompt: string,
    config: unknown,
    os: LeaseOs | null,
    ctx: RunnerCommandContext
  ): string;

  /**
   * Resolve any dispatch-time indirection in the runner's opaque `config` BEFORE
   * any lease is created, returning the rewritten config {@link buildCommand}
   * will later consume. The executor passes `resolveStepRef`, which inlines a
   * whole-value `snippet:<name>` reference (a saved `step`-kind command) — and
   * FAILS the dispatch loudly when the name is missing or of the wrong kind, so
   * a broken reference never reaches a lease. A runner whose command is itself a
   * step-like command (the `script` runner's `command_template`) uses it; a
   * runner with no such indirection omits this hook and its config passes
   * through unchanged. Called right after {@link validateConfig}'s subject is
   * chosen; see the executor.
   */
  resolveConfig?(
    config: unknown,
    resolveStepRef: (value: string) => Promise<string>
  ): Promise<unknown>;

  /**
   * Validate the runner's opaque `config` BEFORE any lease is created, throwing
   * a descriptive error when it cannot yield a runnable command (e.g. a `script`
   * runner with no `command_template`). Optional: a runner with no up-front
   * config requirements omits it. The executor calls it right after resolving the
   * runner, so a misconfiguration fails the dispatch without paying for a lease.
   */
  validateConfig?(config: unknown): void;

  /**
   * Parse the raw captured agent output into a {@link RunnerOutput}, or `null`
   * when the engine did not actually run / produced no valid result. A `null`
   * return fails the dispatch with {@link missingResultError} — even on a zero
   * exit — so a bogus "done" run is never recorded.
   */
  parseOutput(raw: string): RunnerOutput | null;

  /**
   * The failure message the executor records when {@link parseOutput} returns
   * `null`. Owned by the runner so the executor never names an engine specific.
   */
  readonly missingResultError: string;

  /**
   * Scan raw output for the engine's auth-failure signatures and return the
   * matched substring, or `null` when none match. Used only to enrich a failure
   * message; optional because not every engine has an auth surface.
   */
  detectAuthFailure?(raw: string): string | null;

  /**
   * When set, the environment variable the executor delivers the rendered prompt
   * in (instead of on the command line). Some OS command shapes read the prompt
   * from here; a runner that always carries the prompt on the command line omits
   * it.
   */
  readonly promptEnvVar?: string;

  /**
   * When set, the maximum prompt length (in chars) a windows lease can carry via
   * {@link promptEnvVar}. A longer prompt fails a windows dispatch rather than
   * being silently truncated by the OS. Omitted when the runner has no such
   * bound.
   */
  readonly maxWindowsPromptChars?: number;
}
