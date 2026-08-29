import dotenv from "dotenv";
dotenv.config();

import app from "./src/app";
import { getConfig, userDataDir } from "./src/config";
import { resolveDbPath } from "./src/db/db";
import { getModuleConfig } from "./src/db/moduleConfig";
import { runMigrations } from "./src/db/migrate";
import { createSecretEnvResolver } from "./src/executor/envResolver";
import {
  reconcileOrphanedDispatches,
  sweepPendingReleases,
} from "./src/executor/executor";
import { log } from "./src/log";
import { ADO_MODULE_ID, createAdoModule } from "./src/modules/ado/poller";
import {
  DATADOG_MODULE_ID,
  createDatadogModule,
} from "./src/modules/datadog";
import { ModuleRegistry } from "./src/modules/registry";
import { setRuntime } from "./src/runtime";
import { getSecret, initSecrets } from "./src/secrets";
import { Dispatcher } from "./src/services/dispatcher";
import { dispatchLogDir } from "./src/services/dispatchLog";
import { pruneRunRetention } from "./src/services/runRetention";
import { TriggerScheduler } from "./src/services/triggerScheduler";
import { wisperClientFromConfig } from "./src/wisper/client";

async function main() {
  // Parse and validate configuration first; a malformed value fails fast here
  // with a clear message rather than surfacing as a confusing runtime error.
  const config = getConfig();

  // Log the resolved on-disk paths up front so an operator can see where the
  // DB file, per-dispatch logs, and secret store landed (an ORCH_DATA_DIR
  // override moves all three; ORCH_DB_PATH only moves the DB file).
  log.info("orchestrator data paths", {
    dbPath: resolveDbPath(),
    logsDir: dispatchLogDir(),
    secretsDir: userDataDir(),
  });

  // Resolve the master key and load the encrypted secret store. Doing this at
  // boot surfaces a misconfigured key source (no keychain and no
  // ORCH_MASTER_KEY) immediately rather than on the first secret access.
  initSecrets();

  // Bring the SQLite schema up to date before accepting requests.
  await runMigrations();

  // Recover from an unclean shutdown BEFORE any dispatcher loop starts: fail
  // every dispatch left mid-pipeline and release the leases they still hold.
  // Leasing may be unconfigured (no WISPER_HOST_ID) — reconciliation still runs,
  // marking dispatches failed and leaving any leases to their TTL failsafe.
  const wisper = config.isWisperConfigured() ? wisperClientFromConfig(config) : null;
  await reconcileOrphanedDispatches({
    wisper,
    releaseTimeoutMs: config.wisperReleaseTimeoutMs,
  });

  // Also sweep for any TERMINAL (done/failed) dispatch whose lease was never
  // released: e.g. a done row whose finally-block DELETE lost the race with a
  // process crash, or a release_pending row left by a prior boot. (In-flight
  // rows are excluded by the sweep's status filter — their lease is owned by
  // the running pipeline, and reconcileOrphanedDispatches has already failed
  // any rows stranded by the previous process by this point.) The
  // dispatcher will keep running this sweep on a timer once it starts; this
  // one-shot at boot catches leaks BEFORE any new dispatch runs. Best-effort:
  // a sweep failure must not block startup.
  if (wisper) {
    try {
      await sweepPendingReleases({
        wisper,
        releaseTimeoutMs: config.wisperReleaseTimeoutMs,
      });
    } catch (err) {
      log.error("boot-time release sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Trim terminal run history down to the `run_retention_max` cap once at boot,
  // so a lowered cap takes effect immediately rather than only after the next
  // dispatch completes. Best-effort: retention is housekeeping and must never
  // block startup.
  try {
    await pruneRunRetention();
  } catch (err) {
    log.error("boot-time run retention prune failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start the single-flight dispatcher loop that drains the queue. With no
  // wisper client it stays idle (see Dispatcher.start).
  const dispatcher = new Dispatcher({
    wisper,
    resolveEnv: createSecretEnvResolver(),
    execTimeoutMs: config.wisperExecTimeoutMs,
    releaseTimeoutMs: config.wisperReleaseTimeoutMs,
  });
  await dispatcher.start();

  // The module system: a registry of integration modules and the scheduler that
  // arms their producers. They are exposed to the REST API (along with the
  // dispatcher) so the modules endpoints can list producer statuses and a retry
  // can wake the dispatcher.
  const registry = new ModuleRegistry();
  const scheduler = new TriggerScheduler({
    resolveTick: (producerId) => registry.getProducer(producerId)?.tick,
  });

  // Wire in the integration modules, then replay each module's persisted config
  // so its producer triggers re-arm across restarts (a fresh install has no
  // stored config, which applyConfig treats as "stay on a manual trigger").
  const ado = createAdoModule({
    scheduler,
    resolveSecret: async (ref) => getSecret(ref),
  });
  registry.register(ado.module);
  ado.module.applyConfig?.((await getModuleConfig(ADO_MODULE_ID)) ?? {});

  const datadog = createDatadogModule({
    scheduler,
    resolveSecret: async (ref) => getSecret(ref),
  });
  registry.register(datadog.module);
  datadog.module.applyConfig?.((await getModuleConfig(DATADOG_MODULE_ID)) ?? {});

  setRuntime({ dispatcher, registry, scheduler });

  // Loopback only — orchestrator is a single-user desktop app; the OS user is
  // the security boundary.
  const server = app.listen(config.port, "127.0.0.1", () => {
    log.info("orchestrator listening", {
      url: `http://127.0.0.1:${config.port}`,
      wisperConfigured: config.isWisperConfigured(),
    });
  });

  // Graceful shutdown: stop accepting requests and drain the in-flight dispatch
  // before exiting, so no dispatch is abandoned mid-pipeline on a clean stop.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("orchestrator shutting down", { signal });
    scheduler.stop();
    await dispatcher.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Process-level fatal-error guards. A crash on an unhandled rejection or an
  // uncaught exception would otherwise skip the executor's finally block and
  // strand any lease it was holding. Best-effort: run the release sweep so any
  // pending release is attempted one last time, then exit so a supervisor can
  // restart cleanly (Node's default behavior on these events, made explicit).
  const emergencySweepAndExit = (kind: string, err: unknown): void => {
    log.error(kind, { error: err instanceof Error ? err.message : String(err) });
    const bail = () => process.exit(1);
    // Guard against never returning: hard-exit after a short budget even if
    // the sweep itself hangs on the network.
    const bailTimer = setTimeout(bail, 5000);
    bailTimer.unref?.();
    void (async () => {
      try {
        if (wisper) {
          await sweepPendingReleases({
            wisper,
            releaseTimeoutMs: config.wisperReleaseTimeoutMs,
          });
        }
      } catch (sweepErr) {
        log.error("emergency release sweep failed", {
          error:
            sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
        });
      } finally {
        clearTimeout(bailTimer);
        bail();
      }
    })();
  };
  process.on("unhandledRejection", (reason) =>
    emergencySweepAndExit("unhandledRejection", reason)
  );
  process.on("uncaughtException", (err) =>
    emergencySweepAndExit("uncaughtException", err)
  );
}

main().catch((err) => {
  console.error("Failed to start orchestrator:", err);
  process.exit(1);
});
