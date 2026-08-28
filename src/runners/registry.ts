/**
 * The runner registry: the single lookup from a runner id to its {@link Runner}.
 *
 * Two runners are registered: `claude-code` (the default; runs the Claude Code
 * CLI in the lease against the rendered `prompt_template`) and `script` (runs a
 * rendered `runner_config.command_template` as the agent step with no LLM). The
 * executor resolves its runner through {@link getRunner} keyed on the
 * playbook's `runner` field; {@link getDefaultRunner} returns
 * {@link DEFAULT_RUNNER_ID}'s runner as the fallback when a caller has no id.
 */

import { claudeCodeRunner } from "./claudeCode";
import type { Runner } from "./runner";
import { scriptRunner } from "./script";

/** The id of the runner used when a playbook does not (yet) name one. */
export const DEFAULT_RUNNER_ID = claudeCodeRunner.id;

/** All registered runners, keyed by id. */
const RUNNERS: ReadonlyMap<string, Runner> = new Map([
  [claudeCodeRunner.id, claudeCodeRunner],
  [scriptRunner.id, scriptRunner],
]);

/** Resolve a runner by id, or `undefined` when none is registered under it. */
export function getRunner(id: string): Runner | undefined {
  return RUNNERS.get(id);
}

/** The ids of every registered runner. */
export function runnerIds(): string[] {
  return [...RUNNERS.keys()];
}

/**
 * The default runner the executor delegates to. Throws if the default id is not
 * registered — a programming error, since the default is a registered runner's
 * own id.
 */
export function getDefaultRunner(): Runner {
  const runner = getRunner(DEFAULT_RUNNER_ID);
  if (!runner) {
    throw new Error(`default runner "${DEFAULT_RUNNER_ID}" is not registered`);
  }
  return runner;
}
