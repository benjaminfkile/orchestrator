import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";

import * as changeBus from "./changeBus";
import { subscribe, type ResourceChange } from "./changeBus";
import { emitEvent } from "./eventIntake";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-change-pub-"));
  return path.join(dir, "test.sqlite");
}

/**
 * Resolve once the bus broadcasts `resource` (ignoring any other resource), or
 * reject after `timeoutMs`. Tolerates the coalescing window's real delay.
 */
function waitForChange(resource: string, timeoutMs = 3000): Promise<ResourceChange> {
  return new Promise((resolve, reject) => {
    const unsubscribe = subscribe((change) => {
      if (change.resource !== resource) return;
      unsubscribe();
      clearTimeout(timer);
      resolve(change);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no "${resource}" change within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

describe("change publication", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("publishes 'playbooks' after a successful POST /api/playbooks (router-level)", async () => {
    const pending = waitForChange("playbooks");
    await request(app)
      .post("/api/playbooks")
      .send({ name: "pb-change", image: "img", ttl_seconds: 60 })
      .expect(201);
    const change = await pending;
    expect(change.resource).toBe("playbooks");
  });

  it("does not publish when the write fails (400 rejected body)", async () => {
    const spy = jest.spyOn(changeBus, "publish");
    await request(app).post("/api/playbooks").send({ name: "no-image" }).expect(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("publishes 'events' when emitEvent records an event (service-level)", async () => {
    const pending = waitForChange("events");
    await emitEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "1",
      },
      db
    );
    const change = await pending;
    expect(change.resource).toBe("events");
  });

  it("does not fail the request when a publish throws (fire-and-forget)", async () => {
    jest.spyOn(changeBus, "publish").mockImplementation(() => {
      throw new Error("bus exploded");
    });
    // The request must still succeed even though the post-commit publish throws.
    await request(app)
      .post("/api/playbooks")
      .send({ name: "pb-survive", image: "img", ttl_seconds: 60 })
      .expect(201);
  });
});
