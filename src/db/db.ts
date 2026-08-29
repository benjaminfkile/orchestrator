import fs from "fs";
import path from "path";

import knex, { Knex } from "knex";

import { userDataDir } from "../config";
import { migrationSource } from "./migrations";

/**
 * Resolve the database file path.
 *
 * Precedence:
 * 1. ORCH_DB_PATH (verbatim) when set, so a launcher can still redirect just
 *    the DB file.
 * 2. Otherwise `<userDataDir()>/orchestrator.sqlite`. The base is ORCH_DATA_DIR
 *    when set, else the OS user-data dir with an "orchestrator" subdirectory
 *    (see {@link userDataDir}), so a launcher setting ORCH_DATA_DIR keeps the
 *    DB, per-dispatch logs, and the secret store all under one folder.
 */
export function resolveDbPath(): string {
  const fromEnv = process.env.ORCH_DB_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(userDataDir(), "orchestrator.sqlite");
}

/** Build a knex instance bound to `filename`, creating parent dirs as needed. */
export function createDb(filename: string): Knex {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return knex({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
    migrations: { migrationSource },
  });
}

let instance: Knex | undefined;

/**
 * The process-wide singleton knex instance, created lazily on first use so that
 * importing this module never touches the real user-data directory.
 */
export function getDb(): Knex {
  if (!instance) {
    instance = createDb(resolveDbPath());
  }
  return instance;
}

/**
 * Override the process-wide singleton knex instance. Used by the app bootstrap
 * to bind an already-migrated connection and by tests to point the repo layer
 * (which defaults to {@link getDb}) at a temporary database.
 */
export function setDb(db: Knex): void {
  instance = db;
}
