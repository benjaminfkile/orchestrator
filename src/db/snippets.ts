import type { Knex } from "knex";

import type {
  NewSnippet,
  SnippetKind,
  SnippetRecord,
  SnippetUpdate,
} from "../interfaces";

import { getDb } from "./db";

/** Raw row shape as stored on disk (all columns are plain scalars). */
interface SnippetRow {
  id: number;
  kind: SnippetKind;
  name: string;
  description: string;
  content: string;
  created_at: number;
  updated_at: number;
}

/** Decode an on-disk row into a typed {@link SnippetRecord}. */
function fromRow(row: SnippetRow): SnippetRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Insert a new snippet and return the stored record. `description` defaults to
 * `""`; timestamps are set to the current time.
 *
 * Enforce the UNIQUE(kind, name) constraint explicitly before inserting, exactly
 * like {@link createPlaybook}: the better-sqlite3 driver can intermittently fail
 * to surface a constraint violation under GC pressure, so a pre-check makes the
 * rejection deterministic while the DB constraint stays the backstop. This app
 * is single-writer, so there is no TOCTOU race.
 */
export async function createSnippet(
  snippet: NewSnippet,
  db: Knex = getDb()
): Promise<SnippetRecord> {
  const now = Date.now();
  const clash = await db<SnippetRow>("snippets")
    .where({ kind: snippet.kind, name: snippet.name })
    .first();
  if (clash) {
    throw new Error(
      `snippet "${snippet.name}" of kind "${snippet.kind}" already exists`
    );
  }
  const [id] = await db<SnippetRow>("snippets").insert({
    kind: snippet.kind,
    name: snippet.name,
    description: snippet.description ?? "",
    content: snippet.content,
    created_at: now,
    updated_at: now,
  });
  const created = await getSnippet(Number(id), db);
  if (!created) throw new Error("failed to read back inserted snippet");
  return created;
}

/** Fetch a single snippet by id, or `undefined` if none exists. */
export async function getSnippet(
  id: number,
  db: Knex = getDb()
): Promise<SnippetRecord | undefined> {
  const row = await db<SnippetRow>("snippets").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/**
 * Fetch a single snippet by its (kind, name) pair — the shape the executor
 * resolves references with — or `undefined` when none matches. A name that
 * exists only under a DIFFERENT kind returns `undefined` here, which is how a
 * kind mismatch surfaces as a loud dispatch failure.
 */
export async function getSnippetByName(
  kind: SnippetKind,
  name: string,
  db: Knex = getDb()
): Promise<SnippetRecord | undefined> {
  const row = await db<SnippetRow>("snippets").where({ kind, name }).first();
  return row ? fromRow(row) : undefined;
}

/**
 * List snippets newest-first (`created_at` DESC, `id` DESC to break ties),
 * optionally filtered to a single `kind`.
 */
export async function listSnippets(
  kind?: SnippetKind,
  db: Knex = getDb()
): Promise<SnippetRecord[]> {
  let query = db<SnippetRow>("snippets");
  if (kind !== undefined) query = query.where({ kind });
  const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc");
  return rows.map(fromRow);
}

/**
 * Apply a partial update to a snippet, bumping `updated_at`. Returns the updated
 * record, or `undefined` if no snippet with `id` exists. Renaming (or changing
 * kind) is allowed and deliberately breaks any reference by name.
 */
export async function updateSnippet(
  id: number,
  patch: SnippetUpdate,
  db: Knex = getDb()
): Promise<SnippetRecord | undefined> {
  const changes: Partial<SnippetRow> = { updated_at: Date.now() };
  if (patch.kind !== undefined) changes.kind = patch.kind;
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.description !== undefined) changes.description = patch.description;
  if (patch.content !== undefined) changes.content = patch.content;
  const count = await db<SnippetRow>("snippets").where({ id }).update(changes);
  if (count === 0) return undefined;
  return getSnippet(id, db);
}

/** Delete a snippet by id. Returns true when a row was removed. */
export async function deleteSnippet(
  id: number,
  db: Knex = getDb()
): Promise<boolean> {
  const count = await db<SnippetRow>("snippets").where({ id }).delete();
  return count > 0;
}
