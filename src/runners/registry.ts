/**
 * The runner registry: the single lookup from a runner id to its {@link Runner}.
 *
 * `claude-code` is currently the sole registered runner and the default. The
 * executor resolves its runner through {@link getDefaultRunner} (hardcoded to the
 * default for now); a later task lets a playbook name its runner, at which point
 * lookups go through {@link getRunner}.
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
