import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { runMigrations } from "./migrate";
import {
  countUnread,
  getNotification,
  insertNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notificationLog";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notiflog-"));
  return path.join(dir, "test.sqlite");
}

describe("notification_log repo", () => {
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

  it("inserts a delivered row with null defaults", async () => {
    const row = await insertNotification(
      { title:"t", body: "b", status: "delivered" },
      db
    );
    expect(row.id).toBeGreaterThan(0);
    expect(row.notifier_id).toBeNull();
    expect(row.event_id).toBeNull();
    expect(row.error).toBeNull();
    expect(row.read_at).toBeNull();
    expect(row.created_at).toBeGreaterThan(0);
    expect(await getNotification(row.id, db)).toEqual(row);
  });

  it("stores a delivered row carrying a toast error", async () => {
    const row = await insertNotification(
      {
        notifier_id: 5,
        event_id: 9,
        title: "t",
        body: "b",
        status: "delivered",
        error: "notify-send ENOENT",
      },
      db
    );
    expect(row.status).toBe("delivered");
    expect(row.error).toBe("notify-send ENOENT");
    expect(row.notifier_id).toBe(5);
    expect(row.event_id).toBe(9);
  });

  it("lists newest-first, pages by cursor, and filters unread", async () => {
    const a = await insertNotification(
      { title:"a", body: "b", status: "delivered" },
      db
    );
    const b = await insertNotification(
      { title:"b", body: "b", status: "delivered" },
      db
    );
    const c = await insertNotification(
      { title:"c", body: "b", status: "delivered" },
      db
    );

    const all = await listNotifications({}, db);
    expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);

    const page = await listNotifications({ limit: 1, cursor: c.id }, db);
    expect(page.map((r) => r.id)).toEqual([b.id]);

    await markNotificationRead(b.id, db);
    const unread = await listNotifications({ unreadOnly: true }, db);
    expect(unread.map((r) => r.id)).toEqual([c.id, a.id]);
  });

  it("counts unread and marks a single row read idempotently", async () => {
    const a = await insertNotification(
      { title:"a", body: "b", status: "delivered" },
      db
    );
    await insertNotification(
      { title:"b", body: "b", status: "delivered" },
      db
    );
    expect(await countUnread(db)).toBe(2);

    const read = await markNotificationRead(a.id, db);
    expect(read?.read_at).not.toBeNull();
    const firstReadAt = read?.read_at;
    expect(await countUnread(db)).toBe(1);

    // Marking an already-read row again keeps the original read_at.
    const again = await markNotificationRead(a.id, db);
    expect(again?.read_at).toBe(firstReadAt);

    expect(await markNotificationRead(999, db)).toBeUndefined();
  });

  it("marks all unread rows read and returns the count", async () => {
    await insertNotification(
      { title:"a", body: "b", status: "delivered" },
      db
    );
    await insertNotification(
      { title:"b", body: "b", status: "delivered" },
      db
    );
    const updated = await markAllNotificationsRead(db);
    expect(updated).toBe(2);
    expect(await countUnread(db)).toBe(0);
    // A second sweep finds nothing left to mark.
    expect(await markAllNotificationsRead(db)).toBe(0);
  });
});
