import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";

import { up as rewriteAdoUrls } from "./20260713000015_ado_workitem_web_urls";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ado-url-"));
  return path.join(dir, "test.sqlite");
}

interface SeedEvent {
  source: string;
  type: string;
  subject_kind: string;
  subject_ref: string;
  payload: unknown;
}

async function insertEvent(db: Knex, e: SeedEvent): Promise<number> {
  const [row] = await db("events")
    .insert({
      source: e.source,
      type: e.type,
      subject_kind: e.subject_kind,
      subject_ref: e.subject_ref,
      payload: JSON.stringify(e.payload),
      dedupe_key: null,
      ts: 1_700_000_000_000,
      last_dispatched_at: null,
      cleared_at: null,
    })
    .returning("id");
  return typeof row === "object" ? (row as { id: number }).id : (row as number);
}

async function payloadOf(db: Knex, id: number): Promise<Record<string, unknown>> {
  const row = await db("events").where({ id }).first("payload");
  return JSON.parse((row as { payload: string }).payload);
}

describe("ado work-item web-url migration", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    // Bring the schema up; on an empty events table this migration is a no-op,
    // so we seed rows afterward and invoke `up` directly to exercise the rewrite.
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("rewrites only matching ado work-item urls and preserves the api url", async () => {
    const adoWorkItem = await insertEvent(db, {
      source: "ado",
      type: "ado.workitem.created",
      subject_kind: "work_item",
      subject_ref: "42",
      payload: {
        id: 42,
        title: "Fix the widget",
        url: "https://dev.azure.com/org/proj/_apis/wit/workItems/42",
      },
    });
    // Same shape, but this ado event is a pull request: url does not match.
    const adoPr = await insertEvent(db, {
      source: "ado",
      type: "ado.pullrequest.created",
      subject_kind: "pull_request",
      subject_ref: "9",
      payload: {
        id: 9,
        url: "https://dev.azure.com/org/proj/_apis/git/pullRequests/9",
      },
    });
    // A work-item-shaped url but a different source: out of scope, untouched.
    const otherSource = await insertEvent(db, {
      source: "other",
      type: "other.thing",
      subject_kind: "thing",
      subject_ref: "1",
      payload: {
        url: "https://dev.azure.com/org/proj/_apis/wit/workItems/1",
      },
    });
    // An ado event that already carries the web url: nothing to change.
    const alreadyWeb = await insertEvent(db, {
      source: "ado",
      type: "ado.workitem.updated",
      subject_kind: "work_item",
      subject_ref: "7",
      payload: {
        url: "https://dev.azure.com/org/proj/_workitems/edit/7",
      },
    });

    await rewriteAdoUrls(db);

    const rewritten = await payloadOf(db, adoWorkItem);
    expect(rewritten.url).toBe(
      "https://dev.azure.com/org/proj/_workitems/edit/42"
    );
    expect(rewritten.api_url).toBe(
      "https://dev.azure.com/org/proj/_apis/wit/workItems/42"
    );
    // Untouched fields survive verbatim.
    expect(rewritten.title).toBe("Fix the widget");

    // The pull-request payload is opaque to this migration: left exactly as-is.
    const pr = await payloadOf(db, adoPr);
    expect(pr.url).toBe(
      "https://dev.azure.com/org/proj/_apis/git/pullRequests/9"
    );
    expect(pr.api_url).toBeUndefined();

    // A non-ado source with a work-item-shaped url is never touched.
    const other = await payloadOf(db, otherSource);
    expect(other.url).toBe(
      "https://dev.azure.com/org/proj/_apis/wit/workItems/1"
    );
    expect(other.api_url).toBeUndefined();

    // An already-web ado url is left unchanged and gains no api_url.
    const web = await payloadOf(db, alreadyWeb);
    expect(web.url).toBe("https://dev.azure.com/org/proj/_workitems/edit/7");
    expect(web.api_url).toBeUndefined();
  });
});
