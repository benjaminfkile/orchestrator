import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { createDispatch } from "./dispatches";
import { insertEvent } from "./events";
import { createFinding, getFinding, listFindings } from "./findings";
import { createPlaybook } from "./playbooks";
import { createRun } from "./runs";
import { runMigrations } from "./migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-findings-"));
  return path.join(dir, "test.sqlite");
}

describe("findings repo", () => {
  let file: string;
  let db: Knex;
  let runId: number;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);

    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "1",
      },
      db
    );
    const playbook = await createPlaybook(
      { name: "pb", image: "img", ttl_seconds: 60 },
      db
    );
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbook.id },
      db
    );
    const run = await createRun({ dispatch_id: dispatch.id }, db);
    runId = run.id;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("creates a finding with defaults and reads it back with parsed tags", async () => {
    const finding = await createFinding({ run_id: runId, content: "hi" }, db);
    expect(finding.id).toBeGreaterThan(0);
    expect(finding.run_id).toBe(runId);
    expect(finding.content).toBe("hi");
    expect(finding.tags).toEqual([]);
    expect(finding.visibility).toBe("all");

    const fetched = await getFinding(finding.id, db);
    expect(fetched).toEqual(finding);
  });

  it("stores explicit tags and visibility", async () => {
    const finding = await createFinding(
      {
        run_id: runId,
        content: "detail",
        tags: ["a", "b"],
        visibility: "internal",
      },
      db
    );
    expect(finding.tags).toEqual(["a", "b"]);
    expect(finding.visibility).toBe("internal");

    const fetched = await getFinding(finding.id, db);
    expect(fetched?.tags).toEqual(["a", "b"]);
  });

  it("returns undefined for a missing finding", async () => {
    expect(await getFinding(9999, db)).toBeUndefined();
  });

  it("lists findings, optionally filtered by run", async () => {
    const otherEvent = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "2",
      },
      db
    );
    const otherPlaybook = await createPlaybook(
      { name: "pb2", image: "img", ttl_seconds: 60 },
      db
    );
    const otherDispatch = await createDispatch(
      { event_id: otherEvent.id, playbook_id: otherPlaybook.id },
      db
    );
    const otherRun = await createRun({ dispatch_id: otherDispatch.id }, db);

    const f1 = await createFinding({ run_id: runId, content: "one" }, db);
    const f2 = await createFinding({ run_id: otherRun.id, content: "two" }, db);
    const f3 = await createFinding({ run_id: runId, content: "three" }, db);

    // Newest-first: the findings table has no created_at, so id DESC leads.
    const all = await listFindings(undefined, db);
    expect(all.map((f) => f.id)).toEqual([f3.id, f2.id, f1.id]);

    const forRun = await listFindings(runId, db);
    expect(forRun.map((f) => f.id)).toEqual([f3.id, f1.id]);
  });
});
