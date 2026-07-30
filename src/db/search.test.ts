import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { createDispatch, listDispatchesWithSubject } from "./dispatches";
import { insertEvent, listEvents } from "./events";
import { createFinding } from "./findings";
import { insertNotification, listNotifications } from "./notificationLog";
import { createPlaybook } from "./playbooks";
import { createRun, listRunHistory, updateRun } from "./runs";
import { escapeLike, searchTerms } from "./search";
import { runMigrations } from "./migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-search-"));
  return path.join(dir, "test.sqlite");
}

describe("search helpers", () => {
  describe("searchTerms", () => {
    it("returns [] for empty, whitespace-only, and non-string input", () => {
      expect(searchTerms("")).toEqual([]);
      expect(searchTerms("   ")).toEqual([]);
      expect(searchTerms("\t \n")).toEqual([]);
      expect(searchTerms(undefined)).toEqual([]);
      expect(searchTerms(null)).toEqual([]);
      expect(searchTerms(123)).toEqual([]);
    });

    it("trims and splits on runs of whitespace", () => {
      expect(searchTerms("  foo   bar\tbaz ")).toEqual(["foo", "bar", "baz"]);
      expect(searchTerms("solo")).toEqual(["solo"]);
    });
  });

  describe("escapeLike", () => {
    it("escapes LIKE wildcards and the escape char itself", () => {
      expect(escapeLike("100%")).toBe("100\\%");
      expect(escapeLike("a_b")).toBe("a\\_b");
      expect(escapeLike("c\\d")).toBe("c\\\\d");
      expect(escapeLike("plain")).toBe("plain");
    });
  });
});

describe("q search over lists", () => {
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

  describe("listEvents", () => {
    async function seed() {
      const a = await insertEvent(
        {
          source: "ado",
          type: "workitem.created",
          subject_kind: "workitem",
          subject_ref: "1234",
          payload: { title: "Fix login", state: "Active" },
        },
        db
      );
      const b = await insertEvent(
        {
          source: "github",
          type: "pull_request.opened",
          subject_kind: "pr",
          subject_ref: "99",
          payload: { title: "Add search", state: "Open" },
        },
        db
      );
      return { a, b };
    }

    it("matches in each searched column (source/type/subject/payload JSON)", async () => {
      const { a, b } = await seed();
      expect((await listEvents({ q: "ado" }, db)).map((e) => e.id)).toEqual([a.id]);
      expect(
        (await listEvents({ q: "workitem.created" }, db)).map((e) => e.id)
      ).toEqual([a.id]);
      expect((await listEvents({ q: "1234" }, db)).map((e) => e.id)).toEqual([
        a.id,
      ]);
      // subject_kind
      expect((await listEvents({ q: "pr" }, db)).map((e) => e.id)).toEqual([
        b.id,
      ]);
      // Raw payload JSON text.
      expect((await listEvents({ q: "Fix login" }, db)).map((e) => e.id)).toEqual(
        [a.id]
      );
      expect((await listEvents({ q: "Active" }, db)).map((e) => e.id)).toEqual([
        a.id,
      ]);
    });

    it("is case-insensitive", async () => {
      const { a } = await seed();
      expect((await listEvents({ q: "ADO" }, db)).map((e) => e.id)).toEqual([
        a.id,
      ]);
      expect((await listEvents({ q: "fix LOGIN" }, db)).map((e) => e.id)).toEqual(
        [a.id]
      );
    });

    it("ANDs multiple whitespace-separated terms across columns", async () => {
      const { a } = await seed();
      // Both terms present (source + payload), in different columns.
      expect(
        (await listEvents({ q: "ado login" }, db)).map((e) => e.id)
      ).toEqual([a.id]);
      // One term matches nothing -> no rows.
      expect(await listEvents({ q: "ado nomatch" }, db)).toEqual([]);
    });

    it("escapes LIKE wildcards: a literal % must not match everything", async () => {
      const { b } = await seed();
      // No seeded row contains a literal `%`, so `%` (a would-be match-all
      // wildcard) matches nothing once escaped.
      expect(await listEvents({ q: "%" }, db)).toEqual([]);
      // `_` (a would-be match-any-char wildcard) matches ONLY the row that has a
      // literal underscore (`pull_request.opened`), not every row.
      expect((await listEvents({ q: "_" }, db)).map((e) => e.id)).toEqual([
        b.id,
      ]);
      // A real percent is found literally.
      await insertEvent(
        {
          source: "meter",
          type: "usage",
          subject_kind: "cpu",
          subject_ref: "load",
          payload: { note: "at 100% capacity" },
        },
        db
      );
      expect((await listEvents({ q: "100%" }, db)).length).toBe(1);
    });

    it("composes with the cursor (cursor applies to the filtered set)", async () => {
      // Three ado events; the middle-by-id one is excluded by the cursor.
      const e1 = await insertEvent(
        { source: "ado", type: "t", subject_kind: "k", subject_ref: "a" },
        db
      );
      const e2 = await insertEvent(
        { source: "ado", type: "t", subject_kind: "k", subject_ref: "b" },
        db
      );
      const e3 = await insertEvent(
        { source: "other", type: "t", subject_kind: "k", subject_ref: "c" },
        db
      );
      // Newest-first, filtered to ado, page after e3 (cursor = e3.id).
      const page = await listEvents({ q: "ado", cursor: e3.id, limit: 1 }, db);
      expect(page.map((e) => e.id)).toEqual([e2.id]);
      const rest = await listEvents({ q: "ado", cursor: e2.id }, db);
      expect(rest.map((e) => e.id)).toEqual([e1.id]);
    });
  });

  describe("listNotifications", () => {
    async function seed() {
      const a = await insertNotification(
        { title: "Build failed", body: "step 2 broke", status: "delivered" },
        db
      );
      const b = await insertNotification(
        {
          title: "Deploy done",
          body: "all green",
          status: "failed",
          error: "toast ENOENT",
        },
        db
      );
      return { a, b };
    }

    it("matches in title, body, status, and error", async () => {
      const { a, b } = await seed();
      expect(
        (await listNotifications({ q: "Build" }, db)).map((n) => n.id)
      ).toEqual([a.id]);
      expect(
        (await listNotifications({ q: "broke" }, db)).map((n) => n.id)
      ).toEqual([a.id]);
      expect(
        (await listNotifications({ q: "delivered" }, db)).map((n) => n.id)
      ).toEqual([a.id]);
      expect(
        (await listNotifications({ q: "ENOENT" }, db)).map((n) => n.id)
      ).toEqual([b.id]);
    });

    it("is case-insensitive and ANDs terms", async () => {
      const { b } = await seed();
      expect(
        (await listNotifications({ q: "DEPLOY green" }, db)).map((n) => n.id)
      ).toEqual([b.id]);
      expect(await listNotifications({ q: "deploy broke" }, db)).toEqual([]);
    });

    it("escapes wildcards so a literal % matches nothing here", async () => {
      await seed();
      expect(await listNotifications({ q: "%" }, db)).toEqual([]);
    });

    it("composes with the cursor and unreadOnly", async () => {
      const a = await insertNotification(
        { title: "alpha match", body: "b", status: "delivered" },
        db
      );
      const b = await insertNotification(
        { title: "beta match", body: "b", status: "delivered" },
        db
      );
      // Filter to "match", page after b -> only a remains.
      const page = await listNotifications({ q: "match", cursor: b.id }, db);
      expect(page.map((n) => n.id)).toEqual([a.id]);
    });
  });

  describe("listDispatchesWithSubject", () => {
    async function seed() {
      const pbFix = await createPlaybook(
        { name: "fixer", image: "img", ttl_seconds: 60 },
        db
      );
      const pbRelease = await createPlaybook(
        { name: "releaser", image: "img", ttl_seconds: 60 },
        db
      );
      const evA = await insertEvent(
        {
          source: "ado",
          type: "workitem.assigned",
          subject_kind: "workitem",
          subject_ref: "5001",
          payload: { title: "Login bug" },
        },
        db
      );
      const evB = await insertEvent(
        {
          source: "github",
          type: "pull_request.opened",
          subject_kind: "pr",
          subject_ref: "88",
          payload: { title: "Docs update" },
        },
        db
      );
      const a = await createDispatch(
        {
          event_id: evA.id,
          playbook_id: pbFix.id,
          status: "failed",
          error: "boom happened",
        },
        db
      );
      const b = await createDispatch(
        { event_id: evB.id, playbook_id: pbRelease.id, status: "done" },
        db
      );
      return { a, b };
    }

    it("matches status, error, subject fields, event type, and playbook name", async () => {
      const { a, b } = await seed();
      const only = async (q: string) =>
        (await listDispatchesWithSubject({ q }, db)).map((d) => d.id);
      expect(await only("failed")).toEqual([a.id]);
      expect(await only("boom")).toEqual([a.id]);
      expect(await only("5001")).toEqual([a.id]); // subject_ref
      expect(await only("workitem")).toEqual([a.id]); // subject_kind
      expect(await only("workitem.assigned")).toEqual([a.id]); // event type
      expect(await only("Login bug")).toEqual([a.id]); // subject_title (payload.title)
      expect(await only("fixer")).toEqual([a.id]); // playbook name
      expect(await only("releaser")).toEqual([b.id]);
    });

    it("is case-insensitive and ANDs terms across columns", async () => {
      const { a } = await seed();
      // playbook name + error, different columns.
      expect(
        (await listDispatchesWithSubject({ q: "FIXER boom" }, db)).map(
          (d) => d.id
        )
      ).toEqual([a.id]);
      expect(await listDispatchesWithSubject({ q: "fixer green" }, db)).toEqual(
        []
      );
    });

    it("escapes wildcards so a literal % matches nothing", async () => {
      await seed();
      expect(await listDispatchesWithSubject({ q: "%" }, db)).toEqual([]);
    });

    it("composes with the status filter", async () => {
      const { a } = await seed();
      // q matches a (failed); status=done excludes it.
      expect(
        await listDispatchesWithSubject({ q: "fixer", status: "done" }, db)
      ).toEqual([]);
      expect(
        (await listDispatchesWithSubject({ q: "fixer", status: "failed" }, db)).map(
          (d) => d.id
        )
      ).toEqual([a.id]);
    });
  });

  describe("listRunHistory", () => {
    async function seed() {
      // Names chosen to avoid the seed migrations' reserved playbook names.
      const pb = await createPlaybook(
        { name: "histpb-primary", image: "img", ttl_seconds: 60 },
        db
      );
      const pb2 = await createPlaybook(
        { name: "histpb-secondary", image: "img", ttl_seconds: 60 },
        db
      );
      const ev = await insertEvent(
        {
          source: "ado",
          type: "workitem.created",
          subject_kind: "workitem",
          subject_ref: "7777",
          payload: { title: "Payment outage" },
        },
        db
      );
      const ev2 = await insertEvent(
        {
          source: "github",
          type: "pull_request.opened",
          subject_kind: "pr",
          subject_ref: "12",
          payload: { title: "Refactor" },
        },
        db
      );
      // Dispatch A: done, with a run carrying result_text + collected + findings.
      const a = await createDispatch(
        { event_id: ev.id, playbook_id: pb.id, status: "done" },
        db
      );
      const run = await createRun(
        { dispatch_id: a.id, started_at: 1000, ended_at: 2000 },
        db
      );
      await updateRun(
        run.id,
        {
          result_text: "diagnosis complete",
          collected: { summary: "root cause identified" },
        },
        db
      );
      await createFinding({ run_id: run.id, content: "ticket ABC-42" }, db);
      // Dispatch B: failed, no run.
      const b = await createDispatch(
        {
          event_id: ev2.id,
          playbook_id: pb2.id,
          status: "failed",
          error: "lease timeout",
        },
        db
      );
      return { a, b };
    }

    it("matches dispatch/event columns and playbook name", async () => {
      const { a, b } = await seed();
      const ids = async (q: string) =>
        (await listRunHistory({ q }, db)).map((r) => r.dispatch_id);
      expect(await ids("histpb-primary")).toEqual([a.id]); // playbook name
      expect(await ids("done")).toEqual([a.id]); // status
      expect(await ids("lease timeout")).toEqual([b.id]); // error
      expect(await ids("7777")).toEqual([a.id]); // subject_ref
      expect(await ids("workitem.created")).toEqual([a.id]); // event type
      expect(await ids("Payment outage")).toEqual([a.id]); // subject_title
    });

    it("matches run result_text, collected JSON, and findings content via EXISTS", async () => {
      const { a } = await seed();
      const ids = async (q: string) =>
        (await listRunHistory({ q }, db)).map((r) => r.dispatch_id);
      expect(await ids("diagnosis complete")).toEqual([a.id]); // result_text
      expect(await ids("root cause")).toEqual([a.id]); // collected JSON text
      expect(await ids("ABC-42")).toEqual([a.id]); // findings content
      // The result-bearing run belongs to A only; B has no run text.
      expect(await ids("diagnosis")).toEqual([a.id]);
    });

    it("is case-insensitive and ANDs terms across the searched surface", async () => {
      const { a } = await seed();
      // playbook name (histpb-primary) + a findings term (ABC-42), different
      // sources, mixed case.
      expect(
        (await listRunHistory({ q: "HISTPB-PRIMARY abc-42" }, db)).map(
          (r) => r.dispatch_id
        )
      ).toEqual([a.id]);
      expect(
        await listRunHistory({ q: "histpb-primary nomatch" }, db)
      ).toEqual([]);
    });

    it("escapes wildcards so a literal % matches nothing", async () => {
      const { b } = await seed();
      // No seeded value has a literal `%`, so an escaped `%` matches no row.
      expect(await listRunHistory({ q: "%" }, db)).toEqual([]);
      // `_` matches ONLY the dispatch whose event type has a literal underscore
      // (`pull_request.opened`), proving it is not a match-any wildcard.
      expect((await listRunHistory({ q: "_" }, db)).map((r) => r.dispatch_id)).toEqual(
        [b.id]
      );
    });

    it("composes with the limit, applying it to the filtered set", async () => {
      const pb = await createPlaybook(
        { name: "matcher", image: "img", ttl_seconds: 60 },
        db
      );
      const ev = await insertEvent(
        { source: "s", type: "t", subject_kind: "k", subject_ref: "r" },
        db
      );
      // Two matching dispatches + one non-matching interleaved by id.
      const d1 = await createDispatch(
        { event_id: ev.id, playbook_id: pb.id },
        db
      );
      const other = await createPlaybook(
        { name: "other", image: "img", ttl_seconds: 60 },
        db
      );
      await createDispatch({ event_id: ev.id, playbook_id: other.id }, db);
      const d3 = await createDispatch(
        { event_id: ev.id, playbook_id: pb.id },
        db
      );
      // Filtered to "matcher": d3 then d1; limit 1 keeps the newest match.
      const page = await listRunHistory({ q: "matcher", limit: 1 }, db);
      expect(page.map((r) => r.dispatch_id)).toEqual([d3.id]);
      const all = await listRunHistory({ q: "matcher" }, db);
      expect(all.map((r) => r.dispatch_id)).toEqual([d3.id, d1.id]);
    });
  });
});
