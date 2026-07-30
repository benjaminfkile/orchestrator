import type { Knex } from "knex";

import {
  isWorkItemApiUrl,
  toWorkItemWebUrl,
} from "../../modules/ado/workItemUrl";

/**
 * Data migration: rewrite the `url` field of EXISTING `ado` events whose payload
 * carries a work-item REST API url so it points at the human web-UI url instead
 * (`_apis/wit/workItems/{id}` → `_workitems/edit/{id}`), matching what the poller
 * now emits for new events. The original API url is preserved as `api_url`.
 *
 * SCOPING. Only rows with `source = 'ado'` whose `payload.url` matches the
 * documented work-item API pattern are touched. Payloads of any other shape —
 * pull requests, events with no url, or urls that already point at the web UI —
 * are left byte-for-byte untouched (precedent: seed migrations carry
 * module-specific data). This keeps opaque payloads opaque.
 */

interface EventRow {
  id: number;
  source: string;
  payload: string | null;
}

export async function up(knex: Knex): Promise<void> {
  const rows = await knex<EventRow>("events")
    .where({ source: "ado" })
    .select("id", "payload");

  for (const row of rows) {
    if (!row.payload) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue; // Non-JSON payload: not ours to touch.
    }
    if (payload === null || typeof payload !== "object") continue;

    const record = payload as Record<string, unknown>;
    const url = record.url;
    if (typeof url !== "string" || !isWorkItemApiUrl(url)) continue;

    const webUrl = toWorkItemWebUrl(url);
    if (webUrl === url) continue; // Defensive: nothing actually changed.

    const next: Record<string, unknown> = { ...record, url: webUrl };
    // Preserve the original API url without clobbering an existing api_url.
    if (record.api_url === undefined) next.api_url = url;

    await knex<EventRow>("events")
      .where({ id: row.id })
      .update({ payload: JSON.stringify(next) });
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Irreversible by design: the rewritten web url is derivable from the api_url
  // this migration preserved, so there is nothing to restore. No-op.
}
