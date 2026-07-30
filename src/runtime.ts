/**
 * Process-wide handles to the long-lived services the REST API needs to reach
 * but that the routers themselves do not own: the running dispatcher (so a retry
 * can wake it), and the module registry + trigger scheduler (so the modules API
 * can list producer statuses and reconcile a config change).
 *
 * Wired once at boot from `index.ts` via {@link setRuntime}; tests inject their
 * own fakes the same way. Every field is optional so a router degrades to a
 * sensible no-op / empty response when a service is not wired (e.g. the
 * dispatcher is absent when leasing is unconfigured), mirroring the
 * {@link import("./db/db").setDb} singleton-injection pattern used elsewhere.
 */

import type { ModuleRegistry } from "./modules/registry";
import type { AdoRouterDeps } from "./routers/adoDiscoveryRouter";
import type { AnthropicModelsDeps } from "./services/anthropicModels";
import type { TriggerScheduler } from "./services/triggerScheduler";
import type { WisperHostsDeps } from "./services/wisperHosts";

/** The one dispatcher affordance the API uses: nudge it to drain the queue. */
export interface DispatcherHandle {
  kick(): void;
}

/** The app-level services the routers reach through this module. */
export interface Runtime {
  /** The running dispatcher, or `undefined` when leasing is unconfigured. */
  dispatcher?: DispatcherHandle;
  /** The module registry, or `undefined` when no modules are wired. */
  registry?: ModuleRegistry;
  /** The trigger scheduler backing producer statuses/reconcile. */
  scheduler?: TriggerScheduler;
  /**
   * Overrides for the ADO discovery/identity endpoints' upstream clients. Left
   * unset in production (the router constructs real read-only clients from the
   * module config); tests inject a mocked ADO client here so no real HTTP is
   * issued.
   */
  ado?: AdoRouterDeps;
  /**
   * Overrides for the Anthropic model-list endpoint's upstream call. Left unset
   * in production (real host, global fetch, process secret store); tests inject
   * a mock server + in-memory secrets so no real HTTP or credential is touched.
   */
  anthropic?: AnthropicModelsDeps;
  /**
   * Overrides for the wisper host-catalog endpoint's upstream call. Left unset in
   * production (boot config, real host, process secret store); tests inject a
   * fake catalog + explicit mode so no real HTTP or credential is touched.
   */
  wisperHosts?: WisperHostsDeps;
  /**
   * Tuning for the dispatch-log tailing endpoint. Every field is optional and
   * defaults to production values (log dir under the OS user-data base, 500ms
   * append poll, 2s terminal-status poll); tests inject a temp `baseDir` and
   * small intervals so a tail runs fast and deterministically.
   */
  logTail?: {
    /** Base dir the per-dispatch log files live under; default `userDataDir()`. */
    baseDir?: string;
    /** How often to poll the file for appended bytes; default 500ms. */
    pollIntervalMs?: number;
    /** How often to re-check the dispatch for a terminal status; default 2000ms. */
    statusIntervalMs?: number;
  };
}

let runtime: Runtime = {};

/** The current runtime handles. Returns an empty object before boot wiring. */
export function getRuntime(): Runtime {
  return runtime;
}

/** Replace the runtime handles. Called at boot and by tests. */
export function setRuntime(next: Runtime): void {
  runtime = next;
}

/** Clear all runtime handles — used by tests to isolate cases. */
export function resetRuntime(): void {
  runtime = {};
}
