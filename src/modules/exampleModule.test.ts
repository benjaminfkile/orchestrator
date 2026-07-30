import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { getModuleConfig, setModuleConfig } from "../db/moduleConfig";
import { createLogger } from "../log";
import { TriggerScheduler } from "../services/triggerScheduler";

import { createExampleModule } from "./exampleModule";
import { ModuleRegistry } from "./registry";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-examplemod-"));
  return path.join(dir, "test.sqlite");
}

/**
 * Exercises the full module lifecycle: register a module, arm its producer,
 * persist config, and confirm the config change reconciles the producer's
 * trigger through registry.onConfigChanged → module.applyConfig → scheduler.
 */
describe("example module: register → configure → trigger", () => {
  let file: string;
  let db: Knex;
  let scheduler: TriggerScheduler;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    scheduler.stop();
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  function wire() {
    const registry = new ModuleRegistry({
      loadConfig: (moduleId) => getModuleConfig(moduleId, db),
    });
    scheduler = new TriggerScheduler({
      resolveTick: (id) => registry.getProducer(id)?.tick,
      logger: createLogger({ sink: () => {} }),
    });
    const example = createExampleModule(scheduler);
    registry.register(example.module);
    // Arm on the module's default trigger, as a bootstrap would.
    scheduler.applyTrigger(example.producerId, example.module.producers![0].defaultTrigger);
    return { registry, example };
  }

  it("starts manual, then re-derives an interval trigger from config", async () => {
    const { registry, example } = wire();

    expect(scheduler.getProducerStatus(example.producerId)?.trigger).toEqual({
      kind: "manual",
    });

    await setModuleConfig(example.module.id, { intervalSeconds: 30 }, db, registry);

    const status = scheduler.getProducerStatus(example.producerId);
    expect(status?.trigger).toEqual({ kind: "interval", seconds: 30 });
    expect(status?.nextFireAt).not.toBeNull();
  });

  it("re-derives a cron trigger and reconciles again on a later change", async () => {
    const { registry, example } = wire();

    await setModuleConfig(example.module.id, { cron: "*/15 * * * *" }, db, registry);
    expect(scheduler.getProducerStatus(example.producerId)?.trigger).toEqual({
      kind: "cron",
      expr: "*/15 * * * *",
    });

    // A second config write reconciles the trigger idempotently to the new value.
    await setModuleConfig(example.module.id, { intervalSeconds: 5 }, db, registry);
    expect(scheduler.getProducerStatus(example.producerId)?.trigger).toEqual({
      kind: "interval",
      seconds: 5,
    });

    // Clearing the config falls back to manual.
    await setModuleConfig(example.module.id, {}, db, registry);
    expect(scheduler.getProducerStatus(example.producerId)?.trigger).toEqual({
      kind: "manual",
    });
  });

  it("actually ticks the producer when fired", async () => {
    const { registry, example } = wire();
    await setModuleConfig(example.module.id, { intervalSeconds: 30 }, db, registry);

    expect(example.tickCount()).toBe(0);
    await scheduler.fireNow(example.producerId);
    expect(example.tickCount()).toBe(1);
    const status = scheduler.getProducerStatus(example.producerId);
    expect(status?.lastError).toBeNull();
    expect(status?.lastTickAt).not.toBeNull();
  });

  it("persists config that a fresh registry reads back and applies", async () => {
    const first = wire();
    await setModuleConfig(first.example.module.id, { intervalSeconds: 42 }, db, first.registry);

    // A brand-new registry/scheduler pair (simulating a restart) reconciles from
    // the persisted config alone.
    const registry = new ModuleRegistry({
      loadConfig: (moduleId) => getModuleConfig(moduleId, db),
    });
    const scheduler2 = new TriggerScheduler({
      resolveTick: (id) => registry.getProducer(id)?.tick,
      logger: createLogger({ sink: () => {} }),
    });
    const example = createExampleModule(scheduler2);
    registry.register(example.module);
    await registry.onConfigChanged(example.module.id);

    expect(scheduler2.getProducerStatus(example.producerId)?.trigger).toEqual({
      kind: "interval",
      seconds: 42,
    });
    scheduler2.stop();
  });
});
