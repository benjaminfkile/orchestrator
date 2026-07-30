import type { Knex } from "knex";

import type { FindingRecord, NewFinding } from "../interfaces";
import { publish as publishChange } from "../services/changeBus";

import { getDb } from "./db";

/** Raw row shape as stored on disk: tags is a JSON-encoded TEXT column. */
interface FindingRow {
  id: number;
  run_id: number;
  content: string;
  tags: string;
  visibility: string;
}

/** Decode an on-disk row into a typed {@link FindingRecord} with parsed tags. */
function fromRow(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    visibility: row.visibility,
  };
}

/**
 * Insert a finding and return the stored record. `tags` defaults to `[]` and
 * `visibility` to `"all"`.
 */
export async function createFinding(
  finding: NewFinding,
  db: Knex = getDb()
): Promise<FindingRecord> {
  const [row] = await db<FindingRow>("findings")
    .insert({
      run_id: finding.run_id,
      content: finding.content,
      tags: JSON.stringify(finding.tags ?? []),
      visibility: finding.visibility ?? "all",
    })
    .returning("*");
  // A finding belongs to a run; signal the SPA to refetch run detail. Coalesced.
  publishChange("runs");
  return fromRow(row);
}

/** Fetch a single finding by id, or `undefined` if none exists. */
export async function getFinding(
  id: number,
  db: Knex = getDb()
): Promise<FindingRecord | undefined> {
  const row = await db<FindingRow>("findings").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/**
 * List findings newest-first. The findings table has no creation-time column,
 * so `id` DESC (monotonic with insertion) is the newest-first order. Pass
 * `runId` to filter to a single run's findings.
 */
export async function listFindings(
  runId?: number,
  db: Knex = getDb()
): Promise<FindingRecord[]> {
  let query = db<FindingRow>("findings").orderBy("id", "desc");
  if (runId !== undefined) query = query.where({ run_id: runId });
  const rows = await query;
  return rows.map(fromRow);
}
