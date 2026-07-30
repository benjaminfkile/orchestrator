import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { getEventById, getEventFacets, insertEvent, listEvents } from "./events";
import { runMigrations } from "./migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-events-"));
  return path.join(dir, "test.sqlite");
}

const baseEvent = {
  source: "moduleA",
  type: "thing.changed",
  subject_kind: "widget",
  subject_ref: "42",
};

describe("events repo", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("inserts an event and reads it back with parsed payload and null lifecycle columns", async () => {
    const inserted = await insertEvent(
      { ...baseEvent, payload: { a: 1, nested: { b: true } }, ts: 1000 },
      db
    );
    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.payload).toEqual({ a: 1, nested: { b: true } });
    expect(inserted.dedupe_key).toBeNull();
    expect(inserted.last_dispatched_at).toBeNull();
    expect(inserted.cleared_at).toBeNull();
    expect(inserted.ts).toBe(1000);

    const fetched = await getEventById(inserted.id, db);
    expect(fetched).toEqual(inserted);
  });

  it("defaults ts to the current time when omitted", async () => {
    const before = Date.now();
    const inserted = await insertEvent({ ...baseEvent }, db);
    const after = Date.now();
    expect(inserted.ts).toBeGreaterThanOrEqual(before);
    expect(inserted.ts).toBeLessThanOrEqual(after);
  });

  it("stores a null payload when none is supplied", async () => {
    const inserted = await insertEvent({ ...baseEvent }, db);
    expect(inserted.payload).toBeNull();
  });

  it("returns undefined for a missing event", async () => {
    expect(await getEventById(9999, db)).toBeUndefined();
  });

  it("lists events newest-first and paginates by cursor", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await insertEvent({ ...baseEvent, ts: 1000 + i }, db);
      ids.push(e.id);
    }

    const firstPage = await listEvents({ limit: 2 }, db);
    expect(firstPage.map((e) => e.id)).toEqual([ids[4], ids[3]]);

    const secondPage = await listEvents(
      { limit: 2, cursor: firstPage[firstPage.length - 1].id },
      db
    );
    expect(secondPage.map((e) => e.id)).toEqual([ids[2], ids[1]]);
  });

  it("defaults the list limit to 50", async () => {
    for (let i = 0; i < 60; i++) {
      await insertEvent({ ...baseEvent, ts: 1000 + i }, db);
    }
    const page = await listEvents({}, db);
    expect(page).toHaveLength(50);
  });

  describe("getEventFacets", () => {
    it("returns empty arrays for an empty table", async () => {
      expect(await getEventFacets(db)).toEqual({ sources: [], types: [] });
    });

    it("returns distinct sources and types sorted ascending", async () => {
      const rows = [
        { source: "moduleB", type: "thing.updated" },
        { source: "moduleA", type: "thing.changed" },
        { source: "moduleA", type: "thing.updated" },
        { source: "moduleB", type: "thing.changed" },
      ];
      for (const r of rows) {
        await insertEvent(
          { ...r, subject_kind: "item", subject_ref: "x" },
          db
        );
      }
      expect(await getEventFacets(db)).toEqual({
        sources: ["moduleA", "moduleB"],
        types: ["thing.changed", "thing.updated"],
      });
    });
  });
});
