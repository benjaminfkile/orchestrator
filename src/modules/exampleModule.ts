/**
 * An example, deliberately domain-neutral integration module used to exercise
 * the full module lifecycle end-to-end: register the module, persist its config,
 * and have the config change re-derive the producer's trigger on a scheduler.
 *
 * It contributes one producer whose `tick` just counts invocations, and an
 * {@link OrchestratorModule.applyConfig} hook that maps opaque config to a
 * {@link Trigger} and re-arms the producer via the injected
 * {@link TriggerScheduler}. Per the architecture principle nothing here knows
 * what the producer is *for* — the config only ever says how often to poll.
 */

import type { TriggerScheduler, Trigger } from "../services/triggerScheduler";

import type { OrchestratorModule, Producer } from "./registry";

/** The config shape this example understands; every field is optional. */
export interface ExampleModuleConfig {
  /** Poll every N seconds. Wins over `cron` when both are present. */
  intervalSeconds?: number;
  /** A 5-field cron expression to poll on. */
  cron?: string;
}

/** A handle to a constructed example module and its observable tick counter. */
export interface ExampleModule {
  module: OrchestratorModule;
  /** The stable producer id, exposed so tests can drive/inspect it. */
  producerId: string;
  /** How many times the producer has ticked so far. */
  tickCount(): number;
}

/** Derive a generic {@link Trigger} from opaque config; absent config → manual. */
function triggerFromConfig(config: unknown): Trigger {
  const c = (config ?? {}) as ExampleModuleConfig;
  if (typeof c.intervalSeconds === "number") {
    return { kind: "interval", seconds: c.intervalSeconds };
  }
  if (typeof c.cron === "string") {
    return { kind: "cron", expr: c.cron };
  }
  return { kind: "manual" };
}

/**
 * Build the example module, wiring its `applyConfig` hook to re-arm the given
 * `scheduler`. Register the returned `module` with a {@link
 * import("./registry").ModuleRegistry} and arm the producer on its
 * `defaultTrigger`; thereafter `onConfigChanged` will re-derive the trigger.
 */
export function createExampleModule(
  scheduler: TriggerScheduler,
  id = "example"
): ExampleModule {
  const producerId = `${id}.poll`;
  let ticks = 0;

  const producer: Producer = {
    id: producerId,
    tick: async () => {
      ticks += 1;
    },
    defaultTrigger: { kind: "manual" },
  };

  const module: OrchestratorModule = {
    id,
    producers: [producer],
    applyConfig(config: unknown) {
      scheduler.applyTrigger(producerId, triggerFromConfig(config));
    },
  };

  return { module, producerId, tickCount: () => ticks };
}
