/**
 * The module registry: the single place integration modules plug into the core.
 *
 * Per the architecture principle (see CLAUDE.md) a module contributes only two
 * generic, domain-neutral things and the core never learns what either one is
 * *for*:
 *
 *   1. **producers** — a configured poller/listener: an id, an async `tick`
 *      that does the polling, and a `defaultTrigger` describing how often the
 *      scheduler should run it. The registry stores producers; the
 *      {@link TriggerScheduler} arms them.
 *   2. **capabilities** — a bounded, READ-ONLY data operation a playbook may be
 *      granted. Given opaque `config` and a `subjectRef` string it returns a
 *      labelled blob of content. "Read-only by contract" is exactly that — a
 *      contract: the type surface offers no mutation, and modules must honour it
 *      (external-service integrations are read-only by construction).
 *
 * Intent words (PR, work item, bug, …) may appear only inside the string ids,
 * the `config` values, and the returned content — never in a code branch here.
 */

import { getModuleConfig } from "../db/moduleConfig";
import type { Trigger } from "../services/triggerScheduler";

/** The labelled blob a capability returns; both fields are plain data. */
export interface CapabilityResult {
  /** A short human-readable label for the fetched content. */
  label: string;
  /** The fetched content itself, already rendered to a string. */
  content: string;
}

/**
 * The generic fields of the triggering event a capability may read to default
 * its own parameters (e.g. a query template, or a subject id). Only the plain,
 * domain-neutral event fields the core already surfaces to the prompt — never a
 * modelled concept. A capability may pull defaults out of `payload`, but the core
 * never branches on any of these here.
 */
export interface CapabilityEvent {
  /** The event source (e.g. the emitting module id). */
  source: string;
  /** The event type string. */
  type: string;
  /** The subject the event is about. */
  subject_ref: string;
  /** The opaque event payload, exactly as the producer emitted it. */
  payload: unknown;
}

/**
 * Domain-neutral context about the dispatch a capability is being fetched for.
 * It carries only plain data the core already holds — never anything a module
 * would branch on for *meaning*. Optional so existing callers/implementers need
 * not supply or read it.
 */
export interface CapabilityInvocationContext {
  /**
   * The names the dispatch's lease will carry in its environment (the playbook's
   * `env_requirements`). Just names — a capability may use them to decide whether
   * to render, say, a fetch hint that references one, but the core never inspects
   * them here.
   */
  envNames?: string[];
  /**
   * The triggering event, surfaced so a capability can default its parameters
   * from the event that dispatched the playbook (e.g. a Datadog log capability
   * seeding its query/window from a log-alert payload). Optional; absent for
   * callers that do not supply it.
   */
  event?: CapabilityEvent;
}

/**
 * A read-only data operation a playbook may be granted. `fetch` takes the
 * capability's opaque `config` (as stored in per-module config), the
 * `subjectRef` of the event being acted on, and an optional domain-neutral
 * {@link CapabilityInvocationContext}, and returns a {@link CapabilityResult}.
 * It must never mutate the external system — read-only by contract.
 */
export interface Capability {
  /** Stable id, unique across all registered modules. */
  id: string;
  fetch(
    config: unknown,
    subjectRef: string,
    context?: CapabilityInvocationContext
  ): Promise<CapabilityResult>;
}

/**
 * Options for a producer {@link Producer.backfill}. `dryRun` is required so a
 * caller must state its intent explicitly; `limit`, when given, caps how many
 * candidates are emitted.
 */
export interface BackfillOptions {
  /** Emit at most this many events; unset means emit them all. */
  limit?: number;
  /** When true, count candidates only and make no changes (side-effect free). */
  dryRun: boolean;
}

/**
 * The outcome of a {@link Producer.backfill}: how many items the producer's
 * watched query matched, and how many events it actually emitted (0 for a
 * dry run). Both are plain counts — the core never inspects what was emitted.
 */
export interface BackfillResult {
  /** Total items the producer's watched query matched. */
  candidates: number;
  /** Events actually emitted through the normal intake (0 on a dry run). */
  emitted: number;
}

/**
 * A configured poller/listener. `tick` performs one poll (typically emitting
 * generic events as a side effect); it takes no arguments and the scheduler
 * catches whatever it throws. `defaultTrigger` is the cadence a module suggests
 * for the producer — a user may override it, but it seeds first-run scheduling.
 */
export interface Producer {
  /** Stable id, unique across all registered modules. */
  id: string;
  tick(): Promise<void>;
  defaultTrigger: Trigger;
  /**
   * OPTIONAL, domain-neutral hook: deliberately replay the items the producer
   * already watches through the SAME event intake `tick` uses, so an operator
   * can run the rules engine over an existing backlog. A producer that does not
   * implement it simply omits it (the modules API then reports "not supported").
   *
   * It MUST NOT disturb the producer's own change-tracking state (snapshot /
   * cursor): the next `tick` must behave exactly as if the backfill never ran.
   * With `dryRun` it makes no changes and returns only the candidate count.
   */
  backfill?(options: BackfillOptions): Promise<BackfillResult>;
}

/**
 * A registered integration module. `id` names the module; the two arrays carry
 * whatever producers and capabilities it contributes (either may be omitted).
 */
export interface OrchestratorModule {
  id: string;
  producers?: Producer[];
  capabilities?: Capability[];
  /**
   * The event `type` strings this module's producers may emit. These are the
   * only place a domain word is allowed (they are user-facing event names, not
   * code branches — see the architecture principle). Advertised here purely so
   * the facets endpoint can seed suggestions on a brand-new install whose events
   * table is still empty; the core never branches on them.
   */
  eventTypes?: string[];
  /**
   * Optional hook the registry invokes (via {@link ModuleRegistry.onConfigChanged})
   * whenever this module's persisted config changes. `config` is the freshly
   * loaded value (opaque to the core, `undefined` when no config is stored). A
   * module typically uses it to re-derive its producer triggers.
   */
  applyConfig?(config: unknown): void | Promise<void>;
  /**
   * Optional pre-persist validation hook. Given a candidate config (the raw
   * value a client is trying to store), it throws to reject it — the modules
   * API translates that throw into a 400 and never persists the value. A module
   * with no hook accepts any JSON object. Kept separate from
   * {@link OrchestratorModule.applyConfig} so validation runs BEFORE the write,
   * not as a side effect of reconciling an already-stored value.
   */
  validateConfig?(config: unknown): void | Promise<void>;
}

/** Loads a module's persisted config by id; injectable so the registry stays testable. */
export type ModuleConfigLoader = (moduleId: string) => Promise<unknown | undefined>;

/** Injected collaborators for a {@link ModuleRegistry}. */
export interface ModuleRegistryDeps {
  /**
   * Resolve a module id to its persisted config; used by
   * {@link ModuleRegistry.onConfigChanged}. Defaults to reading the
   * `module_config` table.
   */
  loadConfig?: ModuleConfigLoader;
}

/**
 * An in-memory index of the modules wired into this process. Construct one at
 * startup, {@link ModuleRegistry.register} each module, then look producers and
 * capabilities up by id. Ids are global: registering two producers (or two
 * capabilities, or two modules) that share an id is a programming error and
 * throws, so a collision surfaces at boot rather than silently shadowing.
 */
export class ModuleRegistry {
  private readonly modules = new Map<string, OrchestratorModule>();
  private readonly producers = new Map<string, Producer>();
  private readonly capabilities = new Map<string, Capability>();
  /** Reverse index: capability id → the id of the module that contributed it. */
  private readonly capabilityOwners = new Map<string, string>();
  /** Reverse index: producer id → the id of the module that contributed it. */
  private readonly producerOwners = new Map<string, string>();
  private readonly loadConfig: ModuleConfigLoader;

  constructor(deps: ModuleRegistryDeps = {}) {
    this.loadConfig = deps.loadConfig ?? getModuleConfig;
  }

  /**
   * Register a module and index its producers and capabilities. Throws on any
   * duplicate id (module, producer, or capability) without partially applying —
   * the registry is validated fully before anything is committed.
   */
  register(module: OrchestratorModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`duplicate module id: ${module.id}`);
    }
    const producers = module.producers ?? [];
    const capabilities = module.capabilities ?? [];

    // Validate every id before mutating any map, so a mid-list collision never
    // leaves the registry half-populated.
    for (const producer of producers) {
      if (this.producers.has(producer.id)) {
        throw new Error(`duplicate producer id: ${producer.id}`);
      }
    }
    for (const capability of capabilities) {
      if (this.capabilities.has(capability.id)) {
        throw new Error(`duplicate capability id: ${capability.id}`);
      }
    }

    this.modules.set(module.id, module);
    for (const producer of producers) {
      this.producers.set(producer.id, producer);
      this.producerOwners.set(producer.id, module.id);
    }
    for (const capability of capabilities) {
      this.capabilities.set(capability.id, capability);
      this.capabilityOwners.set(capability.id, module.id);
    }
  }

  /**
   * Add a producer to an already-registered module AFTER registration, indexing
   * it and appending it to the owning module's `producers` array so the modules
   * API reflects it. This is the dynamic counterpart to {@link register}: a
   * module whose producer set is defined by its config (rather than fixed at
   * construction) reconciles that set through this method and
   * {@link unregisterProducer}. Throws when `moduleId` is unknown or the
   * producer id collides with an existing one.
   */
  registerProducer(moduleId: string, producer: Producer): void {
    const module = this.modules.get(moduleId);
    if (!module) {
      throw new Error(`unknown module id: ${moduleId}`);
    }
    if (this.producers.has(producer.id)) {
      throw new Error(`duplicate producer id: ${producer.id}`);
    }
    this.producers.set(producer.id, producer);
    this.producerOwners.set(producer.id, moduleId);
    (module.producers ??= []).push(producer);
  }

  /**
   * Remove a dynamically-registered producer by id: drop it from the index and
   * from its owning module's `producers` array. Idempotent — removing an unknown
   * producer id is a no-op. The scheduler timer is owned separately (clear it via
   * {@link import("../services/triggerScheduler").TriggerScheduler.clear}).
   */
  unregisterProducer(producerId: string): void {
    const moduleId = this.producerOwners.get(producerId);
    if (moduleId === undefined) return;
    this.producers.delete(producerId);
    this.producerOwners.delete(producerId);
    const module = this.modules.get(moduleId);
    if (module?.producers) {
      const idx = module.producers.findIndex((p) => p.id === producerId);
      if (idx >= 0) module.producers.splice(idx, 1);
    }
  }

  /** The module registered under `id`, or `undefined`. */
  getModule(id: string): OrchestratorModule | undefined {
    return this.modules.get(id);
  }

  /** Every registered module, in registration order. */
  listModules(): OrchestratorModule[] {
    return [...this.modules.values()];
  }

  /** The producer registered under `id`, or `undefined`. */
  getProducer(id: string): Producer | undefined {
    return this.producers.get(id);
  }

  /** Every registered producer, in registration order. */
  listProducers(): Producer[] {
    return [...this.producers.values()];
  }

  /** The capability registered under `id`, or `undefined`. */
  getCapability(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  /**
   * The id of the module that contributed the capability `id`, or `undefined`
   * when no such capability is registered. Lets the executor fall back to a
   * capability's owning-module config when a grant carries no explicit config.
   */
  getCapabilityOwner(id: string): string | undefined {
    return this.capabilityOwners.get(id);
  }

  /** Every registered capability, in registration order. */
  listCapabilities(): Capability[] {
    return [...this.capabilities.values()];
  }

  /**
   * Every registered capability id paired with the id of the module that
   * contributed it, in registration order. Backs the `/api/capabilities`
   * endpoint so the UI can offer a grant picker.
   */
  listCapabilityDescriptors(): { id: string; module_id: string }[] {
    return [...this.capabilities.keys()].map((id) => ({
      id,
      module_id: this.capabilityOwners.get(id) ?? "",
    }));
  }

  /**
   * The distinct event `type` strings advertised across all registered modules
   * (via {@link OrchestratorModule.eventTypes}), sorted ascending. Lets the
   * facets endpoint suggest a module's event types before any such event has
   * actually been recorded. Empty when no module declares any.
   */
  listEventTypes(): string[] {
    const types = new Set<string>();
    for (const module of this.modules.values()) {
      for (const type of module.eventTypes ?? []) {
        types.add(type);
      }
    }
    return [...types].sort();
  }

  /**
   * Notify the module that its persisted config changed: load the current config
   * and hand it to the module's optional {@link OrchestratorModule.applyConfig}
   * hook so it can re-derive its producer triggers. A no-op when the module is
   * unknown or declares no hook. Whatever the hook throws propagates to the
   * caller.
   */
  async onConfigChanged(moduleId: string): Promise<void> {
    const module = this.modules.get(moduleId);
    if (!module?.applyConfig) return;
    const config = await this.loadConfig(moduleId);
    await module.applyConfig(config);
  }
}
