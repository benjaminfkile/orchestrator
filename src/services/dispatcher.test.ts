import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { createDispatch, getDispatch, listDispatches } from "../db/dispatches";
import { insertEvent, listEvents } from "../db/events";
import { runMigrations } from "../db/migrate";
import { createPlaybook } from "../db/playbooks";
import { createRun } from "../db/runs";
import { setSetting } from "../db/settings";
import { createLogger, type Logger } from "../log";
import { WisperClient } from "../wisper/client";

import { Dispatcher } from "./dispatcher";
import * as runEvents from "./runEvents";
import * as runRetention from "./runRetention";

/** How the fake should terminate one streaming agent exec. */
interface ExecPlan {
  /** Terminal exit code (default 0); ignored when {@link errorCode} is set. */
  exitCode?: number;
  /** When set, the stream ends with an `error` frame carrying this code. */
  errorCode?: string;
}

/**
 * A tiny in-process wisper stand-in: create lease, streaming agent exec, release
 * lease. Each streaming exec consumes the next queued {@link ExecPlan} (the last
 * plan repeats), so a test can make attempt 1 fail and attempt 2 succeed. It
 * records lease-creation order and each streamed command for FIFO assertions.
 */
class FakeWisper {
  readonly createBodies: Record<string, unknown>[] = [];
  /** The rendered command of every streaming (agent) exec, in wire order. */
  readonly streamCommands: string[] = [];
  readonly releasedLeases: string[] = [];

  private plans: ExecPlan[] = [{ exitCode: 0 }];
  private streamCount = 0;
  private nextLease = 1;
  private server!: http.Server;
  baseUrl = "";

  /** Queue the plan(s) consumed by successive streaming execs. */
  planExecs(plans: ExecPlan[]): void {
    this.plans = plans.length > 0 ? plans : [{ exitCode: 0 }];
    this.streamCount = 0;
  }

  private planForStream(): ExecPlan {
    const idx = Math.min(this.streamCount, this.plans.length - 1);
    this.streamCount += 1;
    return this.plans[idx];
  }

  private handle(
    method: string,
    url: string,
    body: string,
    res: http.ServerResponse
  ): void {
    if (method === "POST" && url === "/dev/leases") {
      this.createBodies.push(JSON.parse(body) as Record<string, unknown>);
      const leaseId = `lease-${this.nextLease++}`;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          leaseId,
          wispContractId: `wisp-${leaseId}`,
          status: "ready",
        })
      );
      return;
    }

    const execMatch = url.match(/^\/dev\/leases\/([^/]+)\/exec/);
    if (method === "POST" && execMatch) {
      const parsed = JSON.parse(body) as { command?: string };
      const command = parsed.command ?? "";
      // Only the agent step streams; this fake is seeded with stepless playbooks.
      this.streamCommands.push(command);
      const plan = this.planForStream();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: chunk\ndata: ${JSON.stringify({
          stream: "stdout",
          data: `{"type":"result","result":"ok"}\n`,
        })}\n\n`
      );
      if (plan.errorCode) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: plan.errorCode })}\n\n`
        );
      } else {
        res.write(
          `event: exit\ndata: ${JSON.stringify({
            exit_code: plan.exitCode ?? 0,
          })}\n\n`
        );
      }
      res.end();
      return;
    }

    const delMatch = url.match(/^\/dev\/leases\/([^/?]+)/);
    if (method === "DELETE" && delMatch) {
      this.releasedLeases.push(decodeURIComponent(delMatch[1]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("");
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end("");
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.handle(
          req.method ?? "",
          req.url ?? "",
          Buffer.concat(chunks).toString("utf8"),
          res
        );
      });
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

/** A logger that swallows output; tests assert on state, not log lines. */
function silentLogger(): Logger {
  return createLogger({ sink: () => {}, clock: () => 0 });
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Dispatcher", () => {
  let fake: FakeWisper;
  let db: Knex;
  let dbDir: string;
  let logDir: string;
  let seedSeq = 0;

  beforeEach(async () => {
    fake = new FakeWisper();
    await fake.start();

    dbDir = tempDir("orch-dispatcher-db-");
    db = createDb(path.join(dbDir, "test.sqlite"));
    await runMigrations(db);

    logDir = tempDir("orch-dispatcher-logs-");
    seedSeq = 0;
  });

  afterEach(async () => {
    await fake.stop();
    await db.destroy();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  function client(): WisperClient {
    return new WisperClient({
      baseUrl: fake.baseUrl,
      hostId: "host-1",
      timeoutMs: 2000,
      logger: silentLogger(),
    });
  }

  function makeDispatcher(): Dispatcher {
    return new Dispatcher({
      wisper: client(),
      resolveEnv: () => undefined,
      db,
      logger: silentLogger(),
      logBaseDir: logDir,
    });
  }

  /** Seed one queued dispatch whose prompt embeds `subjectRef` for ordering. */
  async function seedDispatch(subjectRef: string): Promise<number> {
    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: subjectRef,
        payload: {},
      },
      db
    );
    const playbook = await createPlaybook(
      {
        name: `pb-${seedSeq++}`,
        image: "img",
        ttl_seconds: 600,
        prompt_template: "S={{ event.subject_ref }}",
      },
      db
    );
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbook.id },
      db
    );
    return dispatch.id;
  }

  /** Drive one full drain pass to completion. */
  async function drain(d: Dispatcher): Promise<void> {
    d.kick();
    await d.whenSettled();
  }

  it("processes multiple queued dispatches oldest-first (FIFO)", async () => {
    fake.planExecs([{ exitCode: 0 }]);

    const first = await seedDispatch("1");
    const second = await seedDispatch("2");
    const third = await seedDispatch("3");

    const d = makeDispatcher();
    await drain(d);

    // Every dispatch reached `done`.
    for (const id of [first, second, third]) {
      expect((await getDispatch(id, db))?.status).toBe("done");
    }

    // The agent execs ran in strict oldest-first order: S=1, then S=2, then S=3.
    const order = fake.streamCommands.map((c) => {
      const m = c.match(/S=(\d)/);
      return m ? m[1] : "?";
    });
    expect(order).toEqual(["1", "2", "3"]);
    // Leases were created and released one per dispatch, in the same order.
    expect(fake.createBodies).toHaveLength(3);
    expect(fake.releasedLeases).toEqual(["lease-1", "lease-2", "lease-3"]);
  });

  it("leaves the queue empty and idle once drained", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    await seedDispatch("1");

    const d = makeDispatcher();
    await drain(d);

    expect(await listDispatches("queued", db)).toHaveLength(0);
    expect(await listDispatches("done", db)).toHaveLength(1);

    // A second kick with nothing queued does no work.
    await drain(d);
    expect(fake.createBodies).toHaveLength(1);
  });

  it("retries a retryable failure up to dispatch_max_attempts, then leaves it failed", async () => {
    // Every attempt tears down with a retryable wisper error (host offline).
    fake.planExecs([{ errorCode: "host_offline" }]);

    const id = await seedDispatch("1");
    const d = makeDispatcher();
    await drain(d);

    const dispatch = await getDispatch(id, db);
    expect(dispatch?.status).toBe("failed");
    expect(dispatch?.error).toContain("host_offline");
    // Default max is 3, so it ran three times and exhausted its retries.
    expect(dispatch?.attempts).toBe(3);
    expect(fake.createBodies).toHaveLength(3);
    expect(fake.releasedLeases).toEqual(["lease-1", "lease-2", "lease-3"]);
  });

  it("honors a custom dispatch_max_attempts setting", async () => {
    fake.planExecs([{ errorCode: "host_offline" }]);
    await setSetting("dispatch_max_attempts", "2", db);

    const id = await seedDispatch("1");
    const d = makeDispatcher();
    await drain(d);

    const dispatch = await getDispatch(id, db);
    expect(dispatch?.status).toBe("failed");
    expect(dispatch?.attempts).toBe(2);
    expect(fake.createBodies).toHaveLength(2);
  });

  it("requeues a retryable failure and succeeds on the retry", async () => {
    // Attempt 1 fails retryably; attempt 2 exits 0.
    fake.planExecs([{ errorCode: "host_offline" }, { exitCode: 0 }]);

    const id = await seedDispatch("1");
    const d = makeDispatcher();
    await drain(d);

    const dispatch = await getDispatch(id, db);
    expect(dispatch?.status).toBe("done");
    // One failure was counted; the retry then succeeded.
    expect(dispatch?.attempts).toBe(1);
    expect(fake.createBodies).toHaveLength(2);
  });

  it("does not retry a non-retryable failure (terminal immediately)", async () => {
    // A non-zero agent exit is terminal — never requeued.
    fake.planExecs([{ exitCode: 5 }]);

    const id = await seedDispatch("1");
    const d = makeDispatcher();
    await drain(d);

    const dispatch = await getDispatch(id, db);
    expect(dispatch?.status).toBe("failed");
    expect(dispatch?.error).toContain("non-zero code 5");
    // Attempts stays at 0 and only one lease was ever created.
    expect(dispatch?.attempts).toBe(0);
    expect(fake.createBodies).toHaveLength(1);
  });

  it("processes a mix: a terminal failure does not block later dispatches", async () => {
    // First dispatch fails terminally, the second succeeds.
    fake.planExecs([{ exitCode: 5 }, { exitCode: 0 }]);

    const failed = await seedDispatch("1");
    const ok = await seedDispatch("2");

    const d = makeDispatcher();
    await drain(d);

    expect((await getDispatch(failed, db))?.status).toBe("failed");
    expect((await getDispatch(ok, db))?.status).toBe("done");
    expect(await listDispatches("queued", db)).toHaveLength(0);
  });

  it("start() drains existing work and stop() shuts the loop down cleanly", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    const id = await seedDispatch("1");

    const d = makeDispatcher();
    await d.start();
    await d.whenSettled();
    await d.stop();

    expect((await getDispatch(id, db))?.status).toBe("done");
  });

  it("reads dispatch_concurrency and warns when it exceeds 1 (clamped)", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    await setSetting("dispatch_concurrency", "4", db);
    await seedDispatch("1");

    const lines: string[] = [];
    const capturing = createLogger({ sink: (l) => lines.push(l), clock: () => 0 });
    const d = new Dispatcher({
      wisper: client(),
      db,
      logger: capturing,
      logBaseDir: logDir,
    });
    await d.start();
    await d.whenSettled();
    await d.stop();

    // The over-1 value was read and flagged; work still ran single-flight.
    expect(
      lines.some((l) => l.includes("dispatch_concurrency > 1 is not supported"))
    ).toBe(true);
    expect(fake.createBodies).toHaveLength(1);
  });

  it("run-budget gate off by default: all queued work drains as today", async () => {
    // No budget settings → the gate is disabled; behavior is identical to today.
    fake.planExecs([{ exitCode: 0 }]);
    const first = await seedDispatch("1");
    const second = await seedDispatch("2");
    const third = await seedDispatch("3");

    const d = makeDispatcher();
    await drain(d);

    for (const id of [first, second, third]) {
      expect((await getDispatch(id, db))?.status).toBe("done");
    }
    expect(fake.createBodies).toHaveLength(3);
  });

  it("run_budget_per_hour=1 starts exactly one run, holds the rest, and drains FIFO as the window slides", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    await setSetting("run_budget_per_hour", "1", db);
    await setSetting("run_budget_window_minutes", "1", db); // 60_000ms window

    const first = await seedDispatch("1");
    const second = await seedDispatch("2");
    const third = await seedDispatch("3");

    // A shared, injected clock stamps run started_at AND drives the gate window,
    // so aging is deterministic without real time passing.
    let clock = 5_000_000;
    const d = new Dispatcher({
      wisper: client(),
      db,
      logger: silentLogger(),
      logBaseDir: logDir,
      now: () => clock,
    });

    // Pass 1: exactly one run starts; the budget then holds the other two.
    await drain(d);
    expect((await getDispatch(first, db))?.status).toBe("done");
    expect((await getDispatch(second, db))?.status).toBe("queued");
    expect((await getDispatch(third, db))?.status).toBe("queued");
    expect(fake.createBodies).toHaveLength(1);

    // Still held while the first run is inside the window: nothing new claimed.
    await drain(d);
    expect(fake.createBodies).toHaveLength(1);

    // Advance past the window so the first run ages out; the next one drains.
    clock += 60_000 + 1;
    await drain(d);
    expect((await getDispatch(second, db))?.status).toBe("done");
    expect((await getDispatch(third, db))?.status).toBe("queued");
    expect(fake.createBodies).toHaveLength(2);

    // And once more for the third.
    clock += 60_000 + 1;
    await drain(d);
    expect((await getDispatch(third, db))?.status).toBe("done");
    expect(fake.createBodies).toHaveLength(3);

    // FIFO order preserved end to end: S=1, then S=2, then S=3.
    const order = fake.streamCommands.map((c) => c.match(/S=(\d)/)?.[1] ?? "?");
    expect(order).toEqual(["1", "2", "3"]);
  });

  it("token circuit breaker holds claiming while an in-window run's usage is over budget, then releases", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    await setSetting("token_budget_per_window", "1000", db);
    await setSetting("run_budget_window_minutes", "1", db); // 60_000ms window

    let clock = 8_000_000;

    // A prior, expensive run inside the window trips the breaker before any new
    // work is claimed. Seed it against its own done dispatch.
    const priorEvent = await insertEvent(
      {
        source: "m",
        type: "t",
        subject_kind: "k",
        subject_ref: "prior",
        payload: {},
      },
      db
    );
    const priorPb = await createPlaybook(
      { name: "pb-prior", image: "img", ttl_seconds: 600, prompt_template: "p" },
      db
    );
    const priorDispatch = await createDispatch(
      { event_id: priorEvent.id, playbook_id: priorPb.id, status: "done" },
      db
    );
    await createRun(
      {
        dispatch_id: priorDispatch.id,
        started_at: clock,
        usage: { input_tokens: 5000 },
      },
      db
    );

    const queued = await seedDispatch("1");
    const d = new Dispatcher({
      wisper: client(),
      db,
      logger: silentLogger(),
      logBaseDir: logDir,
      now: () => clock,
    });

    // Breaker tripped: nothing is claimed while the costly run is in-window.
    await drain(d);
    expect((await getDispatch(queued, db))?.status).toBe("queued");
    expect(fake.createBodies).toHaveLength(0);

    // Slide the window past the costly run: the breaker releases and it drains.
    clock += 60_000 + 1;
    await drain(d);
    expect((await getDispatch(queued, db))?.status).toBe("done");
    expect(fake.createBodies).toHaveLength(1);
  });

  /** The orchestrator-sourced run-lifecycle callback events, optionally by type. */
  async function callbackEvents(
    type?: string
  ): Promise<{ payload: unknown; type: string }[]> {
    const events = await listEvents({}, db);
    return events.filter(
      (e) => e.source === "orchestrator" && (type === undefined || e.type === type)
    );
  }

  it("emits run.completed at a terminal success", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    const id = await seedDispatch("1");

    const d = makeDispatcher();
    await drain(d);

    expect((await getDispatch(id, db))?.status).toBe("done");
    const completed = await callbackEvents("run.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toMatchObject({
      dispatch_id: id,
      status: "done",
      exit_code: 0,
      chain_depth: 1,
    });
    // No failure event for a successful run.
    expect(await callbackEvents("run.failed")).toHaveLength(0);
  });

  it("emits run.failed once for a non-retryable terminal failure", async () => {
    fake.planExecs([{ exitCode: 5 }]);
    const id = await seedDispatch("1");

    const d = makeDispatcher();
    await drain(d);

    expect((await getDispatch(id, db))?.status).toBe("failed");
    const failed = await callbackEvents("run.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({ dispatch_id: id, status: "failed" });
    expect(await callbackEvents("run.completed")).toHaveLength(0);
  });

  it("emits run.failed only once retries are exhausted, never before a retry", async () => {
    // Every attempt fails retryably; the cap is 2, so it runs twice then fails.
    fake.planExecs([{ errorCode: "host_offline" }]);
    await setSetting("dispatch_max_attempts", "2", db);
    const id = await seedDispatch("1");

    const d = makeDispatcher();
    await drain(d);

    expect((await getDispatch(id, db))?.status).toBe("failed");
    // Despite two attempts, exactly ONE run.failed is emitted — at the terminal
    // exhaustion, never after the intermediate (about-to-be-retried) failure.
    expect(await callbackEvents("run.failed")).toHaveLength(1);
  });

  it("emits no failure event when a retryable failure later succeeds on retry", async () => {
    // Attempt 1 fails retryably; attempt 2 exits 0.
    fake.planExecs([{ errorCode: "host_offline" }, { exitCode: 0 }]);
    const id = await seedDispatch("1");

    const d = makeDispatcher();
    await drain(d);

    expect((await getDispatch(id, db))?.status).toBe("done");
    // The requeued attempt is not terminal, so no run.failed was emitted...
    expect(await callbackEvents("run.failed")).toHaveLength(0);
    // ...only the terminal success.
    expect(await callbackEvents("run.completed")).toHaveLength(1);
  });

  it("an emit failure never breaks the drain loop", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    const first = await seedDispatch("1");
    const second = await seedDispatch("2");

    const spy = jest
      .spyOn(runEvents, "emitRunEvent")
      .mockRejectedValue(new Error("emit boom"));
    try {
      const d = makeDispatcher();
      await drain(d);
    } finally {
      spy.mockRestore();
    }

    // Both dispatches still ran to completion despite every emit throwing.
    expect((await getDispatch(first, db))?.status).toBe("done");
    expect((await getDispatch(second, db))?.status).toBe("done");
  });

  it("runs run-retention pruning after each terminal transition", async () => {
    fake.planExecs([{ exitCode: 0 }, { exitCode: 5 }]);
    const done = await seedDispatch("1");
    const failed = await seedDispatch("2");

    const spy = jest.spyOn(runRetention, "pruneRunRetention");
    try {
      const d = makeDispatcher();
      await drain(d);
    } finally {
      // One prune per terminal transition (a success and a terminal failure).
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    }

    expect((await getDispatch(done, db))?.status).toBe("done");
    expect((await getDispatch(failed, db))?.status).toBe("failed");
  });

  it("a retention failure never breaks the drain loop", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    const first = await seedDispatch("1");
    const second = await seedDispatch("2");

    const spy = jest
      .spyOn(runRetention, "pruneRunRetention")
      .mockRejectedValue(new Error("retention boom"));
    try {
      const d = makeDispatcher();
      await drain(d);
    } finally {
      spy.mockRestore();
    }

    // Both dispatches still reached their terminal state despite every prune
    // throwing — retention is best-effort housekeeping, never on the hot path.
    expect((await getDispatch(first, db))?.status).toBe("done");
    expect((await getDispatch(second, db))?.status).toBe("done");
  });

  it("stays idle with no wisper client and never claims work", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    const id = await seedDispatch("1");

    const d = new Dispatcher({
      wisper: null,
      db,
      logger: silentLogger(),
      logBaseDir: logDir,
    });
    await d.start();
    d.kick();
    await d.whenSettled();

    // The dispatch was never claimed; it is still queued.
    expect((await getDispatch(id, db))?.status).toBe("queued");
    expect(fake.createBodies).toHaveLength(0);
    await d.stop();
  });
});
