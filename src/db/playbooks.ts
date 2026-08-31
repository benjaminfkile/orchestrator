import type { Knex } from "knex";

import type {
  EnvRequirement,
  GrantedCapability,
  LeaseIsolation,
  NewPlaybook,
  PlaybookRecord,
  PlaybookResources,
  PlaybookUpdate,
} from "../interfaces";

import { getDb } from "./db";

/** Raw row shape as stored on disk: JSON columns are TEXT (or null). */
interface PlaybookRow {
  id: number;
  name: string;
  image: string;
  host: string | null;
  isolation: string | null;
  ttl_seconds: number;
  resources: string;
  network: string;
  userdata_template: string;
  prompt_template: string;
  runner: string;
  runner_config: string;
  env_requirements: string;
  steps: string;
  granted_capabilities: string;
  output_kind: string;
  created_at: number;
  updated_at: number;
}

/** Decode an on-disk row into a typed {@link PlaybookRecord}. */
function fromRow(row: PlaybookRow): PlaybookRecord {
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    host: row.host ?? null,
    isolation: (row.isolation as LeaseIsolation | null) ?? null,
    ttl_seconds: row.ttl_seconds,
    resources: JSON.parse(row.resources) as PlaybookResources,
    network: row.network,
    userdata_template: row.userdata_template,
    prompt_template: row.prompt_template,
    runner: row.runner,
    runner_config: JSON.parse(row.runner_config) as Record<string, unknown>,
    env_requirements: JSON.parse(row.env_requirements) as EnvRequirement[],
    steps: JSON.parse(row.steps) as unknown[],
    granted_capabilities: JSON.parse(
      row.granted_capabilities
    ) as GrantedCapability[],
    output_kind: row.output_kind,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Insert a new playbook and return the stored record. Optional fields fall back
 * to their table defaults (`network` = "open", `output_kind` = "findings",
 * empty JSON columns); timestamps are set to the current time.
 */
export async function createPlaybook(
  playbook: NewPlaybook,
  db: Knex = getDb()
): Promise<PlaybookRecord> {
  const now = Date.now();
  // Enforce the unique name explicitly before inserting. The DB has a
  // UNIQUE(name) constraint, but the better-sqlite3 driver can intermittently
  // FAIL to surface a constraint violation under GC pressure (the same class of
  // bug that made us drop the `INSERT ... RETURNING` read-back below): a plain
  // insert then resolves instead of throwing, so a duplicate name would silently
  // succeed. A pre-check makes the rejection deterministic; the DB constraint
  // stays as the backstop. This app is single-writer, so there is no TOCTOU race.
  const clash = await db<PlaybookRow>("playbooks")
    .where({ name: playbook.name })
    .first();
  if (clash) {
    throw new Error(`playbook name "${playbook.name}" already exists`);
  }
  // Insert without a RETURNING clause and read the row back by its id. The
  // better-sqlite3 driver runs `INSERT ... RETURNING` through `statement.all()`,
  // which under GC pressure can intermittently return the conflicting row
  // instead of raising the UNIQUE(name) violation. Reading back keeps the return
  // value identical to a RETURNING insert.
  const [id] = await db<PlaybookRow>("playbooks").insert({
    name: playbook.name,
    image: playbook.image,
    host: playbook.host ?? null,
    isolation: playbook.isolation ?? null,
    ttl_seconds: playbook.ttl_seconds,
    resources: JSON.stringify(playbook.resources ?? {}),
    network: playbook.network ?? "open",
    userdata_template: playbook.userdata_template ?? "",
    prompt_template: playbook.prompt_template ?? "",
    runner: playbook.runner ?? "claude-code",
    runner_config: JSON.stringify(playbook.runner_config ?? {}),
    env_requirements: JSON.stringify(playbook.env_requirements ?? []),
    steps: JSON.stringify(playbook.steps ?? []),
    granted_capabilities: JSON.stringify(playbook.granted_capabilities ?? []),
    output_kind: playbook.output_kind ?? "findings",
    created_at: now,
    updated_at: now,
  });
  const created = await getPlaybook(Number(id), db);
  if (!created) throw new Error("failed to read back inserted playbook");
  return created;
}

/** Fetch a single playbook by id, or `undefined` if none exists. */
export async function getPlaybook(
  id: number,
  db: Knex = getDb()
): Promise<PlaybookRecord | undefined> {
  const row = await db<PlaybookRow>("playbooks").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/** List all playbooks newest-first (`created_at` DESC, `id` DESC to break ties). */
export async function listPlaybooks(
  db: Knex = getDb()
): Promise<PlaybookRecord[]> {
  const rows = await db<PlaybookRow>("playbooks")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc");
  return rows.map(fromRow);
}

/**
 * Apply a partial update to a playbook, bumping `updated_at`. Returns the
 * updated record, or `undefined` if no playbook with `id` exists.
 */
export async function updatePlaybook(
  id: number,
  patch: PlaybookUpdate,
  db: Knex = getDb()
): Promise<PlaybookRecord | undefined> {
  const changes: Partial<PlaybookRow> = { updated_at: Date.now() };
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.image !== undefined) changes.image = patch.image;
  // `null` explicitly clears the host to the configured default; `undefined`
  // leaves it unchanged.
  if (patch.host !== undefined) changes.host = patch.host;
  // `null` explicitly clears isolation to the server default; `undefined` leaves
  // it unchanged.
  if (patch.isolation !== undefined) changes.isolation = patch.isolation;
  if (patch.ttl_seconds !== undefined) changes.ttl_seconds = patch.ttl_seconds;
  if (patch.resources !== undefined) {
    changes.resources = JSON.stringify(patch.resources);
  }
  if (patch.network !== undefined) changes.network = patch.network;
  if (patch.userdata_template !== undefined) {
    changes.userdata_template = patch.userdata_template;
  }
  if (patch.prompt_template !== undefined) {
    changes.prompt_template = patch.prompt_template;
  }
  if (patch.runner !== undefined) changes.runner = patch.runner;
  if (patch.runner_config !== undefined) {
    changes.runner_config = JSON.stringify(patch.runner_config);
  }
  if (patch.env_requirements !== undefined) {
    changes.env_requirements = JSON.stringify(patch.env_requirements);
  }
  if (patch.steps !== undefined) changes.steps = JSON.stringify(patch.steps);
  if (patch.granted_capabilities !== undefined) {
    changes.granted_capabilities = JSON.stringify(patch.granted_capabilities);
  }
  if (patch.output_kind !== undefined) changes.output_kind = patch.output_kind;
  const count = await db<PlaybookRow>("playbooks").where({ id }).update(changes);
  if (count === 0) return undefined;
  return getPlaybook(id, db);
}

/** Delete a playbook by id. Returns true when a row was removed. */
export async function deletePlaybook(
  id: number,
  db: Knex = getDb()
): Promise<boolean> {
  const count = await db<PlaybookRow>("playbooks").where({ id }).delete();
  return count > 0;
}

/** The non-terminal dispatch lifecycle states — a run still queued or in flight. */
const IN_FLIGHT_DISPATCH_STATUSES = [
  "queued",
  "leasing",
  "running",
  "collecting",
] as const;

/** The terminal dispatch statuses; a completed, failed, or cancelled run's history. */
const TERMINAL_DISPATCH_STATUSES = ["done", "failed", "cancelled"] as const;

/** Counts of the run history a playbook owns, used to warn before a delete cascade. */
export interface PlaybookHistoryCounts {
  /** All of the playbook's dispatch rows, terminal or not. */
  dispatches: number;
  /** All runs across those dispatches. */
  runs: number;
  /** All findings across those runs. */
  findings: number;
  /** How many of the dispatches are NON-terminal (queued/leasing/running/collecting). */
  in_flight: number;
}

/** Read a `count(*)` result knex returns as a string-or-number into a number. */
function toCount(row: { n?: number | string } | undefined): number {
  return Number(row?.n ?? 0);
}

/**
 * Count the run history a playbook owns: its dispatches (all statuses), the runs
 * beneath them, the findings beneath those runs, and how many dispatches are
 * still in flight. Used both by the `/usage` endpoint and by the delete path to
 * decide whether a cascade is safe (0 in-flight) or must be refused.
 */
export async function getPlaybookHistoryCounts(
  playbookId: number,
  db: Knex = getDb()
): Promise<PlaybookHistoryCounts> {
  const dispatches = toCount(
    await db("dispatches")
      .where({ playbook_id: playbookId })
      .count<{ n: number | string }>({ n: "*" })
      .first()
  );
  const in_flight = toCount(
    await db("dispatches")
      .where({ playbook_id: playbookId })
      .whereIn("status", [...IN_FLIGHT_DISPATCH_STATUSES])
      .count<{ n: number | string }>({ n: "*" })
      .first()
  );
  const runs = toCount(
    await db("runs")
      .join("dispatches", "runs.dispatch_id", "dispatches.id")
      .where("dispatches.playbook_id", playbookId)
      .count<{ n: number | string }>({ n: "*" })
      .first()
  );
  const findings = toCount(
    await db("findings")
      .join("runs", "findings.run_id", "runs.id")
      .join("dispatches", "runs.dispatch_id", "dispatches.id")
      .where("dispatches.playbook_id", playbookId)
      .count<{ n: number | string }>({ n: "*" })
      .first()
  );
  return { dispatches, runs, findings, in_flight };
}

/**
 * The ids of a playbook's TERMINAL (done/failed) dispatches — exactly the rows a
 * delete cascade removes. Non-terminal dispatches are excluded: a delete is only
 * allowed when there are none of those.
 */
export async function terminalDispatchIdsForPlaybook(
  playbookId: number,
  db: Knex = getDb()
): Promise<number[]> {
  const rows = await db("dispatches")
    .where({ playbook_id: playbookId })
    .whereIn("status", [...TERMINAL_DISPATCH_STATUSES])
    .select<{ id: number }[]>("id");
  return rows.map((r) => r.id);
}
