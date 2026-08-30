/**
 * The `script` runner: run a configured command as the agent step instead of an
 * LLM agent, so a playbook can be a deterministic job (build, scrape, report)
 * flowing through the exact same event → rule → dispatch → findings →
 * notification pipeline. It proves the runner seam with a second, non-LLM engine.
 *
 * COMMAND: the runner's `command_template` is rendered with the SAME template
 * engine used for prompts and step commands ({@link renderTemplate}) — supporting
 * `{{event.*}}`, `{{payload.*}}`, and `{{env.*}}` (the resolved playbook secrets)
 * and returned verbatim as the agent-step exec. There is no `promptFilePath`
 * on this runner: a script playbook's `prompt_template` may be empty and the
 * executor stages no prompt file for it. Whatever command the template renders
 * is run through the wisper client's existing per-OS exec wrapping; this
 * runner adds no OS branching of its own.
 *
 * OUTPUT: the raw captured stdout is the result text as-is, with no envelope
 * requirement — exit code 0 is the sole success signal (enforced by the
 * executor). `usage` is null (a script reports no token metrics). The executor's
 * NOTES_TO_SAVE parsing still applies to the result text, so a script that prints
 * a NOTES_TO_SAVE block produces findings and one that prints nothing produces
 * none — both are valid runs.
 *
 * Per the architecture principle this runner is domain-neutral: it renders an
 * opaque, user-authored command and reads its raw output. Any intent lives in the
 * `command_template` and event data, never in a code branch here.
 */

import { renderTemplate } from "../executor/prompt";
import type { LeaseOs } from "../wisper/client";

import type { Runner, RunnerCommandContext, RunnerOutput } from "./runner";

/**
 * The `script` runner's config: the required `command_template` rendered into the
 * agent-step command. Read out of the playbook's opaque `runner_config` blob and
 * narrowed here — this runner is the only code that knows this key.
 */
export interface ScriptConfig {
  command_template: string;
}

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error recorded when a `script` playbook has no usable `command_template`. */
export const MISSING_COMMAND_TEMPLATE_ERROR =
  'script runner requires a non-empty "command_template" in runner_config';

/**
 * Narrow the executor's opaque config to the required `command_template`, or
 * `null` when it is missing/empty/not a string. A `null` here is a
 * misconfiguration the runner reports up front (see {@link validateConfig}) so
 * the dispatch fails before any lease is created.
 */
function narrowConfig(config: unknown): ScriptConfig | null {
  if (!isRecord(config)) return null;
  const template = config.command_template;
  if (typeof template !== "string" || template.length === 0) return null;
  return { command_template: template };
}

/**
 * Render the `command_template` into the agent-step command against the event and
 * resolved secrets. Throws {@link MISSING_COMMAND_TEMPLATE_ERROR} on a
 * missing/empty template — reached only if the executor did not gate on
 * {@link validateConfig} first.
 */
export function buildScriptCommand(
  config: unknown,
  ctx: RunnerCommandContext
): string {
  const narrowed = narrowConfig(config);
  if (!narrowed) throw new Error(MISSING_COMMAND_TEMPLATE_ERROR);
  return renderTemplate(narrowed.command_template, ctx.event, { env: ctx.env });
}

/**
 * The `script` runner. Builds its command by rendering `command_template`
 * (ignoring the prompt and the lease OS, since the wisper client wraps the
 * command per OS on its own) and passes raw output straight through with null
 * usage.
 */
export const scriptRunner: Runner = {
  id: "script",

  validateConfig(config: unknown): void {
    if (!narrowConfig(config)) throw new Error(MISSING_COMMAND_TEMPLATE_ERROR);
  },

  async resolveConfig(
    config: unknown,
    resolveStepRef: (value: string) => Promise<string>
  ): Promise<unknown> {
    // The command_template is a command like any step, so a whole-value
    // `snippet:<name>` reference is resolved here against `step`-kind snippets
    // BEFORE leasing (resolveStepRef fails loudly on a missing/mismatched name).
    // Inline plain text is returned untouched. {{snippet.*}} token stacking is
    // deliberately NOT supported here — that mechanic is exclusive to prompts.
    if (!isRecord(config)) return config;
    const template = config.command_template;
    if (typeof template !== "string") return config;
    const resolved = await resolveStepRef(template);
    return resolved === template
      ? config
      : { ...config, command_template: resolved };
  },

  buildCommand(
    config: unknown,
    _os: LeaseOs | null,
    ctx: RunnerCommandContext
  ): string {
    return buildScriptCommand(config, ctx);
  },

  parseOutput(raw: string): RunnerOutput | null {
    // No envelope requirement: the raw captured output IS the result text, and a
    // script reports no token usage. Exit code 0 (enforced by the executor) is the
    // success signal — even empty output is a valid run, so this never returns null.
    return { resultText: raw, usage: null };
  },

  // Never surfaced: parseOutput never returns null, so the executor never records
  // this. Present because the seam requires it.
  missingResultError:
    "script runner produced no output — unreachable (parseOutput always succeeds)",
};
