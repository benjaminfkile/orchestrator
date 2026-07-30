import fs from "fs";
import os from "os";
import path from "path";

import knex, { Knex } from "knex";

import { migrationSource } from "./migrations";

/**
 * Default on-disk location for the SQLite database when ORCH_DB_PATH is unset:
 * <OS user-data dir>/orchestrator/orchestrator.sqlite.
 */
function defaultDbPath(): string {
  const home = os.homedir();
  let base: string;
  switch (process.platform) {
    case "win32":
      base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      break;
    case "darwin":
      base = path.join(home, "Library", "Application Support");
      break;
    default:
      base = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
      break;
  }
  return path.join(base, "orchestrator", "orchestrator.sqlite");
}

/** Resolve the database file path: ORCH_DB_PATH when set, else the default. */
export function resolveDbPath(): string {
  const fromEnv = process.env.ORCH_DB_PATH?.trim();
  return fromEnv ? fromEnv : defaultDbPath();
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
