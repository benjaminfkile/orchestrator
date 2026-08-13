/**
 * End-to-end integration test of the full MVP flow, in-process and with no
 * external services.
 *
 * It wires the real pipeline together against a temp SQLite DB and the
 * {@link FakeWisper} dev server: the seeded `researcher` playbook (pointed at the
 * fake via the `default_lease_image` setting), a rule matching
 * `ado.workitem.assigned`, injected (stubbed) secrets, and the real
 * {@link emitEvent} → {@link Dispatcher} → {@link runDispatch} path. It asserts the
 * three MVP scenarios end-to-end:
 *
 *   1. one matching event → a queued dispatch driven to `done`, with a run row
 *      (exit 0 + usage) and findings persisted from the scripted NOTES_TO_SAVE,
 *      and exactly one lease released;
 *   2. two events queued → strict FIFO execution order;
 *   3. a scripted non-zero agent exit → a `failed` dispatch whose lease is still
 *      released.
 */

import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { getDispatch, listDispatches } from "../db/dispatches";
import { listFindings } from "../db/findings";
import { runMigrations } from "../db/migrate";
import { listPlaybooks } from "../db/playbooks";
import { createRule } from "../db/rules";
import { listRuns } from "../db/runs";
import { setSetting } from "../db/settings";
import type { EnvResolver } from "../executor/executor";
import type { NewEvent, PlaybookRecord } from "../interfaces";
import { createLogger, type Logger } from "../log";
import { emitEvent } from "../services/eventIntake";
import { Dispatcher } from "../services/dispatcher";
import type { HostImageResolver } from "../wisper/catalog";
import { WisperClient } from "../wisper/client";

import { FakeWisper, type ScriptedUsage } from "./fakeWisper";

/** A logger that swallows output; the test asserts on persisted state, not logs. */
function silentLogger(): Logger {
  return createLogger({ sink: () => {}, clock: () => 0 });
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The scripted secret store the executor resolves the playbook's env against. */
const SECRETS: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-stub",
  GIT_TOKEN: "git-token-stub",
};
const resolveEnv: EnvResolver = (name) => SECRETS[name];

const USAGE: ScriptedUsage = {
  input_tokens: 1200,
  output_tokens: 340,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 15,
};

describe("E2E: full MVP flow against a fake wisper", () => {
  let fake: FakeWisper;
  let db: Knex;
  let dbDir: string;
  let logDir: string;
  let researcher: PlaybookRecord;

  beforeEach(async () => {
    fake = new FakeWisper();
    await fake.start();

    dbDir = tempDir("orch-e2e-db-");
    db = createDb(path.join(dbDir, "test.sqlite"));
    await runMigrations(db);

    // Point the seeded researcher playbook's `setting:default_lease_image` image
    // at a concrete (arbitrary) reference so leasing resolves.
    await setSetting("default_lease_image", "ghcr.io/acme/agent:latest", db);

    const playbook = (await listPlaybooks(db)).find((p) => p.name === "researcher");
    if (!playbook) throw new Error("seed researcher playbook missing");
    researcher = playbook;

    logDir = tempDir("orch-e2e-logs-");
  });

  afterEach(async () => {
    await fake.stop();
    await db.destroy();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  function makeDispatcher(mode: "dev" | "v1" = "dev"): Dispatcher {
    // In v1 mode the client authenticates and resolves the (host, image) NAMES
    // against the catalog before leasing. Fake both so the dispatcher can exercise
    // the v1 lease surface without a real wisper.
    const catalog: HostImageResolver = {
      resolve: async (hostSelector, imageName) => ({
        host_id: hostSelector,
        host_image_id: imageName,
      }),
    };
    const wisper = new WisperClient({
      baseUrl: fake.baseUrl,
      hostId: "host-e2e",
      mode,
      resolveApiKey: () => "wck_test",
      catalog,
      timeoutMs: 5000,
      logger: silentLogger(),
    });
    return new Dispatcher({
      wisper,
      resolveEnv,
      db,
      logger: silentLogger(),
      logBaseDir: logDir,
    });
  }

  /** Drive one full drain pass to completion. */
  async function drain(d: Dispatcher): Promise<void> {
    d.kick();
    await d.whenSettled();
  }

  /** A synthetic ADO work-item-assigned event with a title to identify its run. */
  function assignedEvent(subjectRef: string, title: string): NewEvent {
    return {
      source: "ado",
      type: "ado.workitem.assigned",
      subject_kind: "workitem",
      subject_ref: subjectRef,
      payload: { repo_url: "github.com/acme/widget.git", title },
    };
  }

  /** A rule that fires the researcher playbook on `ado.workitem.assigned`. */
  async function seedRule(): Promise<void> {
    await createRule(
      {
        name: "assigned-workitems",
        match: { type: "ado.workitem.assigned" },
        dispatch: [{ playbook_id: researcher.id }],
      },
      db
    );
  }

  it("drives a matching event through to a done dispatch with findings, a run, and one lease release", async () => {
    fake.scriptRuns([
      {
        exitCode: 0,
        resultText: "Investigation complete",
        usage: USAGE,
        notes: [
          {
            content: "The widget repo builds with npm and has no CI.",
            visibility: "all",
            tags: ["research", "build"],
          },
        ],
      },
    ]);

    await seedRule();

    // Emit WITHOUT a dispatcher so nothing drains yet — the queued row is observable.
    const result = await emitEvent(
      assignedEvent("42", "Investigate flaky test"),
      db,
      { logger: silentLogger() }
    );
    expect(result.suppressed).toBe(false);

    const queued = await listDispatches("queued", db);
    expect(queued).toHaveLength(1);
    const dispatchId = queued[0].id;
    expect(queued[0].playbook_id).toBe(researcher.id);

    // Drive the executor: the dispatch runs to completion.
    const d = makeDispatcher();
    await drain(d);

    const dispatch = await getDispatch(dispatchId, db);
    expect(dispatch?.status).toBe("done");
    expect(dispatch?.error).toBeNull();

    // A run row recorded exit 0 and the scripted usage totals.
    const runs = await listRuns(dispatchId, db);
    expect(runs).toHaveLength(1);
    expect(runs[0].exit_code).toBe(0);
    expect(runs[0].result_text).toContain("Investigation complete");
    expect(runs[0].usage).toEqual(USAGE);

    // Findings were persisted from the scripted NOTES_TO_SAVE block.
    const findings = await listFindings(runs[0].id, db);
    expect(findings).toHaveLength(1);
    expect(findings[0].content).toBe(
      "The widget repo builds with npm and has no CI."
    );
    expect(findings[0].visibility).toBe("all");
    expect(findings[0].tags).toEqual(["research", "build"]);

    // Exactly one lease was created and exactly one DELETE (release) was received.
    expect(fake.createRequests).toHaveLength(1);
    expect(fake.deletedLeases).toEqual(["lease-1"]);

    // The clone pre-step ran (sync) and the agent step streamed (once).
    expect(fake.execs.filter((e) => e.streaming)).toHaveLength(1);
    expect(fake.execs.some((e) => !e.streaming)).toBe(true);
  });

  it("executes two queued events in strict FIFO order", async () => {
    fake.scriptRuns([{ exitCode: 0, resultText: "ok", usage: USAGE }]);
    await seedRule();

    // Queue both dispatches before draining anything.
    await emitEvent(assignedEvent("1", "Alpha"), db, { logger: silentLogger() });
    await emitEvent(assignedEvent("2", "Beta"), db, { logger: silentLogger() });

    const queued = await listDispatches("queued", db);
    expect(queued).toHaveLength(2);

    const d = makeDispatcher();
    await drain(d);

    // Both reached done.
    for (const q of queued) {
      expect((await getDispatch(q.id, db))?.status).toBe("done");
    }

    // The agent execs streamed oldest-first: Alpha's prompt before Beta's.
    const order = fake.execs
      .filter((e) => e.streaming)
      .map((e) =>
        e.command.includes("Alpha")
          ? "Alpha"
          : e.command.includes("Beta")
            ? "Beta"
            : "?"
      );
    expect(order).toEqual(["Alpha", "Beta"]);

    // One lease per dispatch, each released, in the same order.
    expect(fake.createRequests).toHaveLength(2);
    expect(fake.deletedLeases).toEqual(["lease-1", "lease-2"]);
  });

  it("drives a v1-mode dispatch end-to-end: create → exec → release, with no resources/gpus in the v1 body", async () => {
    fake.scriptRuns([{ exitCode: 0, resultText: "ok", usage: USAGE }]);
    await seedRule();

    await emitEvent(assignedEvent("v1", "Investigate v1"), db, {
      logger: silentLogger(),
    });
    const queued = await listDispatches("queued", db);
    expect(queued).toHaveLength(1);
    const dispatchId = queued[0].id;

    // A v1 dispatcher — the fake enforces the v1 body contract (a POST that
    // carries `resources` or `gpus` is rejected 400 validation_error) and any
    // regression there would fail the create call and leave the dispatch failed.
    const d = makeDispatcher("v1");
    await drain(d);

    expect((await getDispatch(dispatchId, db))?.status).toBe("done");
    expect(fake.createRequests).toHaveLength(1);
    const createBody = fake.createRequests[0];
    expect(createBody).not.toHaveProperty("resources");
    expect(createBody).not.toHaveProperty("gpus");
    expect(createBody.host_id).toBe("host-e2e");
    // v1 fake mints ids as `lease-<n>` in its v1 response envelope, and the
    // executor releases exactly the lease it created.
    expect(fake.deletedLeases).toEqual(["lease-1"]);
    // The full lifecycle: at least one exec (the streamed agent step) and the
    // release above.
    expect(fake.execs.some((e) => e.streaming)).toBe(true);
  });

  it("fails the dispatch on a non-zero agent exit but still releases the lease", async () => {
    fake.scriptRuns([{ exitCode: 7 }]);
    await seedRule();

    await emitEvent(assignedEvent("99", "Doomed"), db, {
      logger: silentLogger(),
    });
    const queued = await listDispatches("queued", db);
    expect(queued).toHaveLength(1);
    const dispatchId = queued[0].id;

    const d = makeDispatcher();
    await drain(d);

    const dispatch = await getDispatch(dispatchId, db);
    expect(dispatch?.status).toBe("failed");
    expect(dispatch?.error).toContain("non-zero code 7");
    // A non-zero exit is terminal, not retryable: it ran once and was not requeued.
    expect(dispatch?.attempts).toBe(0);

    // No run row and no findings were persisted for the failed dispatch.
    expect(await listRuns(dispatchId, db)).toHaveLength(0);
    expect(await listFindings(undefined, db)).toHaveLength(0);

    // The lease was still created and released exactly once.
    expect(fake.createRequests).toHaveLength(1);
    expect(fake.deletedLeases).toEqual(["lease-1"]);
  });
});
