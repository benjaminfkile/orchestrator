import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { insertEvent } from "../db/events";
import { runMigrations } from "../db/migrate";
import { listNotifications } from "../db/notificationLog";
import { createNotifier } from "../db/notifiers";
import type { EventRecord } from "../interfaces";
import { createLogger } from "../log";

import { deliverForEvent } from "./notifications";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notifsvc-"));
  return path.join(dir, "test.sqlite");
}

/** A silent logger so tests don't spew JSON lines. */
function silentLogger() {
  return createLogger({ sink: () => {} });
}

/** A desktop sink that always succeeds, recording what it was asked to show. */
function stubDesktop() {
  const calls: unknown[] = [];
  const showDesktop = async (input: unknown) => {
    calls.push(input);
    return { ok: true as const };
  };
  return { showDesktop, calls };
}

describe("deliverForEvent", () => {
  let file: string;
  let db: Knex;
  let event: EventRecord;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "42",
        payload: { title: "Widget broke", severity: "high" },
      },
      db
    );
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("writes exactly one log row rendering event and payload tokens", async () => {
    const notifier = await createNotifier(
      {
        name: "alert",
        title_template: "{{event.type}} on {{event.subject_ref}}",
        body_template: "{{payload.title}} ({{payload.severity}})",
      },
      db
    );
    const { showDesktop } = stubDesktop();

    const written = await deliverForEvent(
      event,
      [{ notifier_id: notifier.id }],
      db,
      { logger: silentLogger(), showDesktop }
    );

    expect(written).toHaveLength(1);
    expect(written[0].status).toBe("delivered");
    expect(written[0].title).toBe("thing.changed on 42");
    expect(written[0].body).toBe("Widget broke (high)");
    expect(written[0].notifier_id).toBe(notifier.id);
    expect(written[0].event_id).toBe(event.id);
    expect(written[0].error).toBeNull();

    const rows = await listNotifications({}, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(written[0].id);
  });

  it("always attempts a desktop toast with the rendered title/body", async () => {
    const notifier = await createNotifier(
      {
        name: "alert",
        title_template: "{{event.type}}",
        body_template: "{{payload.title}}",
      },
      db
    );
    const { showDesktop, calls } = stubDesktop();

    await deliverForEvent(event, [{ notifier_id: notifier.id }], db, {
      logger: silentLogger(),
      showDesktop,
    });

    // A single toast attempt carrying only title/body — no click-through url.
    expect(calls).toEqual([{ title: "thing.changed", body: "Widget broke" }]);
  });

  it("uses the same template engine: unresolved tokens render empty", async () => {
    const notifier = await createNotifier(
      {
        name: "n",
        title_template: "{{payload.missing}}!",
        body_template: "{{bogus.root}}",
      },
      db
    );
    const { showDesktop } = stubDesktop();
    const [row] = await deliverForEvent(
      event,
      [{ notifier_id: notifier.id }],
      db,
      { logger: silentLogger(), showDesktop }
    );
    expect(row.title).toBe("!");
    expect(row.body).toBe("");
  });

  it("skips a disabled notifier without writing a row or toasting", async () => {
    const notifier = await createNotifier(
      { name: "off", enabled: false },
      db
    );
    const { showDesktop, calls } = stubDesktop();
    const written = await deliverForEvent(
      event,
      [{ notifier_id: notifier.id }],
      db,
      { logger: silentLogger(), showDesktop }
    );
    expect(written).toEqual([]);
    expect(await listNotifications({}, db)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips a target whose notifier does not exist", async () => {
    const { showDesktop, calls } = stubDesktop();
    const written = await deliverForEvent(
      event,
      [{ notifier_id: 9999 }],
      db,
      { logger: silentLogger(), showDesktop }
    );
    expect(written).toEqual([]);
    expect(await listNotifications({}, db)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps the notification delivered when the desktop toast fails, recording the error", async () => {
    const notifier = await createNotifier(
      { name: "alert", body_template: "hi" },
      db
    );
    const showDesktop = async () => ({ ok: false, error: "notify-send ENOENT" });

    const [row] = await deliverForEvent(
      event,
      [{ notifier_id: notifier.id }],
      db,
      { logger: silentLogger(), showDesktop }
    );

    // The in-app record still lands as delivered; the toast failure is recorded.
    expect(row.status).toBe("delivered");
    expect(row.error).toBe("notify-send ENOENT");

    const rows = await listNotifications({}, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(row.id);
  });

  it("isolates a missing target within a batch without aborting the rest", async () => {
    const a = await createNotifier({ name: "a", title_template: "A" }, db);
    const b = await createNotifier({ name: "b", title_template: "B" }, db);
    const { showDesktop } = stubDesktop();
    const errors: string[] = [];
    const logger = createLogger({ sink: (line) => errors.push(line) });

    // Deliver a + a non-existent notifier + b: the missing one is skipped and
    // logged, the two real ones still deliver.
    const written = await deliverForEvent(
      event,
      [{ notifier_id: a.id }, { notifier_id: 12345 }, { notifier_id: b.id }],
      db,
      { logger, showDesktop }
    );

    expect(written.map((r) => r.title)).toEqual(["A", "B"]);
    // The missing notifier produced a warn line, not a thrown error.
    expect(errors.some((l) => l.includes("missing notifier"))).toBe(true);
  });

  it("never throws into the caller even when the db access itself fails", async () => {
    // A db stub that throws on any query proves delivery catches and isolates a
    // hard failure rather than propagating it into event intake.
    const throwingDb = (() => {
      throw new Error("db exploded");
    }) as unknown as Knex;
    const errors: string[] = [];
    const logger = createLogger({ sink: (line) => errors.push(line) });
    const { showDesktop } = stubDesktop();

    const written = await deliverForEvent(
      event,
      [{ notifier_id: 1 }],
      throwingDb,
      { logger, showDesktop }
    );

    expect(written).toEqual([]);
    expect(errors.some((l) => l.includes("delivery failed"))).toBe(true);
  });

  it("delivers each target of a multi-target batch in order", async () => {
    const a = await createNotifier({ name: "a", title_template: "A" }, db);
    const b = await createNotifier({ name: "b", title_template: "B" }, db);
    const { showDesktop } = stubDesktop();
    const written = await deliverForEvent(
      event,
      [{ notifier_id: a.id }, { notifier_id: b.id }],
      db,
      { logger: silentLogger(), showDesktop }
    );
    expect(written.map((r) => r.title)).toEqual(["A", "B"]);
  });
});
