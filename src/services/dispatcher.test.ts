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
import { listNotifications } from "../db/notificationLog";
import { createNotifier } from "../db/notifiers";
import { createPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import { createRun } from "../db/runs";
import { setSetting } from "../db/settings";
import { sweepPendingReleases } from "../executor/executor";
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
  /**
   * When true, the stream writes its initial chunk then hangs forever with no
   * terminal frame; only the client's own abort (or timeout) closes it. Used
   * by the cancel tests to hold the executor in the agent-step exec while an
   * external signal fires.
   */
  hang?: boolean;
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
  /** Every DELETE the fake observed — including the ones it failed. */
  readonly releaseAttempts: string[] = [];

  private plans: ExecPlan[] = [{ exitCode: 0 }];
  private streamCount = 0;
  private nextLease = 1;
  /**
   * Per-lease queue of scripted release responses. Each entry answers the NEXT
   * DELETE against that lease; once the queue drains the fake responds 200
   * (the happy default). Lets a test say "fail this lease's release N times".
   */
  private releaseResponses: Map<
    string,
    Array<{ status: number; body: unknown }>
  > = new Map();
  private server!: http.Server;
  baseUrl = "";

  /** Queue the plan(s) consumed by successive streaming execs. */
  planExecs(plans: ExecPlan[]): void {
    this.plans = plans.length > 0 ? plans : [{ exitCode: 0 }];
    this.streamCount = 0;
  }

  /**
   * Queue one canned release response for the next DELETE against `leaseId`.
   * Call multiple times to script a sequence; once the queue empties, later
   * DELETEs succeed as usual.
   */
  planReleaseResponse(
    leaseId: string,
    response: { status: number; body: unknown }
  ): void {
    const queue = this.releaseResponses.get(leaseId) ?? [];
    queue.push(response);
    this.releaseResponses.set(leaseId, queue);
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
      if (plan.hang) {
        // Leave the response open with no terminal frame; the client aborts.
        return;
      }
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
      const leaseId = decodeURIComponent(delMatch[1]);
      this.releaseAttempts.push(leaseId);
      const scripted = this.releaseResponses.get(leaseId)?.shift();
      if (scripted) {
        res.writeHead(scripted.status, { "content-type": "application/json" });
        res.end(
          typeof scripted.body === "string"
            ? scripted.body
            : JSON.stringify(scripted.body)
        );
        return;
      }
      this.releasedLeases.push(leaseId);
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

    // The agent execs ran in strict oldest-first order: the rendered prompt
    // for each dispatch is staged as a lease file at /work/prompt.txt on its
    // createLease body, and each carries S=<subject_ref>.
    const order = fake.createBodies.map((body) => {
      const files = body.files as Array<{ path: string; content_base64: string }>;
      const promptFile = files?.find((f) => f.path === "/work/prompt.txt");
      const decoded = promptFile
        ? Buffer.from(promptFile.content_base64, "base64").toString("utf8")
        : "";
      return decoded.match(/S=(\d)/)?.[1] ?? "?";
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
    // The retryable-failure branch requeued cleanly: no extra "one more inline
    // release" was needed because the executor's in-line release succeeded.
    // Two attempts, two leases created, two leases released (the retry's exec
    // also succeeded, so its release ran too).
    expect(fake.releasedLeases).toEqual(["lease-1", "lease-2"]);
  });

  it("retryable failure with a failed inline release: one more inline release, then requeued", async () => {
    // Attempt 1: agent fails retryably (host_offline) AND every one of the
    // executor's in-line release retries (there are 2 backoffs => 3 total
    // attempts) also fails with a retryable code. The dispatcher must then
    // try one more inline release before requeueing; that extra one succeeds,
    // so the retry runs and eventually succeeds.
    fake.planExecs([{ errorCode: "host_offline" }, { exitCode: 0 }]);
    for (let i = 0; i < 3; i++) {
      fake.planReleaseResponse("lease-1", {
        status: 409,
        body: {
          error: {
            code: "host_offline",
            message: "host is offline",
            request_id: `r-${i}`,
          },
        },
      });
    }

    const id = await seedDispatch("1");
    const d = makeDispatcher();
    await drain(d);

    const dispatch = await getDispatch(id, db);
    expect(dispatch?.status).toBe("done");
    // Retry succeeded, so only the first attempt's failure was counted.
    expect(dispatch?.attempts).toBe(1);
    // Two leases were created (one per attempt); the retry's lease released
    // cleanly, and the first lease also eventually released via the
    // dispatcher's extra inline release call.
    expect(fake.createBodies).toHaveLength(2);
    // lease-1 saw 4 DELETEs: 3 from the executor's in-line retries (all
    // failing), plus the extra ONE from the dispatcher (which succeeded).
    // lease-2 saw exactly ONE (its normal happy-path release).
    const l1Attempts = fake.releaseAttempts.filter((l) => l === "lease-1").length;
    const l2Attempts = fake.releaseAttempts.filter((l) => l === "lease-2").length;
    expect(l1Attempts).toBe(4);
    expect(l2Attempts).toBe(1);
    // Both leases were eventually released.
    expect(fake.releasedLeases.sort()).toEqual(["lease-1", "lease-2"]);
    // No release_pending left on the row.
    expect(dispatch?.release_pending).toBe(false);
    expect(dispatch?.released_at).not.toBeNull();
  });

  it("retryable failure whose release keeps failing: dispatch converts to terminal failed with release_pending, sweep recovers", async () => {
    // Attempt 1: agent fails retryably (host_offline) AND every release DELETE
    // ever aimed at lease-1 fails — the executor's in-line retries AND the
    // dispatcher's extra `attemptLeaseRelease` (which itself does internal
    // backoff retries) all get scripted failures. The dispatcher must then
    // convert the dispatch to TERMINAL failed rather than requeueing (which
    // would drop the lease handle). The row stays release_pending; a
    // subsequent sweep recovers the lease when wisper starts answering again.
    fake.planExecs([{ errorCode: "host_offline" }]);
    // Script 6 = 3 (executor in-line retries) + 3 (dispatcher's extra
    // attemptLeaseRelease's internal retries) failing DELETEs, so every
    // release attempt against lease-1 before the sweep is a hard failure.
    for (let i = 0; i < 6; i++) {
      fake.planReleaseResponse("lease-1", {
        status: 409,
        body: {
          error: {
            code: "host_offline",
            message: "host is offline",
            request_id: `r-${i}`,
          },
        },
      });
    }

    const id = await seedDispatch("1");
    const d = makeDispatcher();
    await drain(d);

    // Dispatch is terminal failed (not requeued), still holding an unreleased
    // lease handle with release_pending set.
    let dispatch = await getDispatch(id, db);
    expect(dispatch?.status).toBe("failed");
    expect(dispatch?.error).toContain("host_offline");
    expect(dispatch?.lease_id).toBe("lease-1");
    expect(dispatch?.released_at).toBeNull();
    expect(dispatch?.release_pending).toBe(true);
    // Attempts counter still bumped for the attempt that just failed.
    expect(dispatch?.attempts).toBe(1);
    // Only ONE dispatch attempt ever created a lease — we did NOT requeue.
    expect(fake.createBodies).toHaveLength(1);
    // No second dispatch attempt kicked off.
    expect(fake.streamCommands).toHaveLength(1);
    // 6 DELETEs against lease-1: 3 in-line (executor) + 3 (dispatcher's
    // extra attemptLeaseRelease's own bounded retries). All were the
    // scripted failures, so releasedLeases is empty at this point.
    expect(fake.releaseAttempts.filter((l) => l === "lease-1").length).toBe(6);
    expect(fake.releasedLeases).toEqual([]);

    // Now drive the real sweep — wisper is answering again (scripted
    // responses are drained, so the next DELETE 200s). backoffMs=0 rules
    // out the per-lease cooldown.
    const released = await sweepPendingReleases({
      wisper: client(),
      db,
      logger: silentLogger(),
      backoffMs: 0,
    });
    expect(released).toBe(1);

    dispatch = await getDispatch(id, db);
    expect(dispatch?.status).toBe("failed");
    expect(dispatch?.released_at).not.toBeNull();
    expect(dispatch?.release_pending).toBe(false);
    expect(fake.releasedLeases).toEqual(["lease-1"]);
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

    // FIFO order preserved end to end: the rendered prompt on each
    // successive createLease body carries S=1, then S=2, then S=3.
    const order = fake.createBodies.map((body) => {
      const files = body.files as Array<{ path: string; content_base64: string }>;
      const promptFile = files?.find((f) => f.path === "/work/prompt.txt");
      const decoded = promptFile
        ? Buffer.from(promptFile.content_base64, "base64").toString("utf8")
        : "";
      return decoded.match(/S=(\d)/)?.[1] ?? "?";
    });
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

  it("emits run.started exactly once per dispatch begun, before the run terminates", async () => {
    fake.planExecs([{ exitCode: 0 }]);
    const id = await seedDispatch("1");

    const d = makeDispatcher();
    await drain(d);

    const started = await callbackEvents("run.started");
    expect(started).toHaveLength(1);
    expect(started[0].payload).toMatchObject({
      dispatch_id: id,
      chain_depth: 1,
    });
    // Start-time payload carries no terminal fields.
    const payload = started[0].payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("exit_code");
    expect(payload).not.toHaveProperty("findings");
    expect(payload).not.toHaveProperty("duration_ms");
    expect(payload).not.toHaveProperty("run_id");
    // playbook_name/dispatch_id are visible on run.started (per acceptance 233).
    expect(payload.dispatch_id).toBe(id);
    expect(typeof payload.playbook_name).toBe("string");
  });

  it("emits no run.started for a queued dispatch the dispatcher never claims (budget-held)", async () => {
    // A budget of 1 with a prior in-window run holds the queued dispatch: it
    // never transitions to leasing, so run.started must not fire.
    fake.planExecs([{ exitCode: 0 }]);
    await setSetting("run_budget_per_hour", "1", db);
    await setSetting("run_budget_window_minutes", "60", db);

    const clock = 5_000_000;
    // Pre-seed a completed run inside the window so the gate is tripped from
    // the first pass: the queued dispatch stays queued, unclaimed.
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
      { name: "prior", image: "img", ttl_seconds: 600, prompt_template: "p" },
      db
    );
    const priorDispatch = await createDispatch(
      { event_id: priorEvent.id, playbook_id: priorPb.id, status: "done" },
      db
    );
    await createRun(
      { dispatch_id: priorDispatch.id, started_at: clock },
      db
    );

    const id = await seedDispatch("1");
    const d = new Dispatcher({
      wisper: client(),
      db,
      logger: silentLogger(),
      logBaseDir: logDir,
      now: () => clock,
    });
    await drain(d);

    // Never claimed → still queued, no lease created, no run.started emitted.
    expect((await getDispatch(id, db))?.status).toBe("queued");
    expect(fake.createBodies).toHaveLength(0);
    expect(await callbackEvents("run.started")).toHaveLength(0);
  });

  it("fires a notifier attached to a rule matching run.started", async () => {
    fake.planExecs([{ exitCode: 0 }]);

    // Seed the target playbook up front so we can bind the rule by name.
    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "1",
        payload: {},
      },
      db
    );
    const playbook = await createPlaybook(
      {
        name: "smoke-test",
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

    // Notifier rendered against the run.started event; matched by playbook_name.
    const notifier = await createNotifier(
      {
        name: "start-notify",
        title_template: "started {{ payload.playbook_name }}",
        body_template: "dispatch {{ payload.dispatch_id }}",
      },
      db
    );
    await createRule(
      {
        name: "notify-on-start",
        match: {
          source: "orchestrator",
          type: "run.started",
          criteria: { playbook_name: "smoke-test" },
        },
        notify: [{ notifier_id: notifier.id }],
      },
      db
    );

    const d = makeDispatcher();
    await drain(d);

    expect((await getDispatch(dispatch.id, db))?.status).toBe("done");
    const notifications = await listNotifications({}, db);
    // Exactly one notification for the run.started callback (nothing else matches).
    const starts = notifications.filter(
      (n) => n.title === `started smoke-test`
    );
    expect(starts).toHaveLength(1);
    expect(starts[0].body).toBe(`dispatch ${dispatch.id}`);
    expect(starts[0].notifier_id).toBe(notifier.id);
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

  describe("cancel", () => {
    it("returns false when no run is in-flight for the id", async () => {
      const d = makeDispatcher();
      // No processDispatch has been called for id 1, so the inflight map is empty.
      expect(d.cancel(1)).toBe(false);
    });

    it("cancelling an in-flight dispatch: dispatch lands cancelled, lease released, run.cancelled emitted, no auto-retry", async () => {
      // The agent stream hangs open so the dispatch stays in `running` until
      // an external cancel tears it down.
      fake.planExecs([{ hang: true }]);
      const id = await seedDispatch("1");

      const d = makeDispatcher();
      const drainPromise = (async () => {
        d.kick();
        await d.whenSettled();
      })();

      // Poll until the row is in-flight (leasing/running/collecting), then
      // trigger the cancel. This avoids a fixed sleep by observing state.
      await new Promise<void>((resolve) => {
        const tick = async () => {
          const row = await getDispatch(id, db);
          if (
            row &&
            (row.status === "leasing" ||
              row.status === "running" ||
              row.status === "collecting")
          ) {
            resolve();
            return;
          }
          setTimeout(tick, 10);
        };
        void tick();
      });

      expect(d.cancel(id)).toBe(true);
      await drainPromise;

      const dispatch = await getDispatch(id, db);
      expect(dispatch?.status).toBe("cancelled");
      expect(dispatch?.error).toBe("cancelled");
      // Lease was still released via the executor's finally.
      expect(fake.releasedLeases).toEqual(["lease-1"]);
      // Cancelled dispatches are terminal and never auto-retried, so exactly
      // ONE agent-stream exec ever fired (no second attempt).
      expect(fake.streamCommands).toHaveLength(1);
      // run.cancelled fired; run.failed did NOT.
      const cancelled = await callbackEvents("run.cancelled");
      const failed = await callbackEvents("run.failed");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].payload).toMatchObject({
        dispatch_id: id,
        status: "cancelled",
      });
      expect(failed).toHaveLength(0);
    });
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
