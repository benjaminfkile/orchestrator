import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { createDispatch, getDispatch } from "../db/dispatches";
import { insertEvent } from "../db/events";
import { listFindings } from "../db/findings";
import { runMigrations } from "../db/migrate";
import { createPlaybook } from "../db/playbooks";
import { listRuns } from "../db/runs";
import { createSnippet, updateSnippet } from "../db/snippets";
import { setSetting } from "../db/settings";
import type { NewPlaybook } from "../interfaces";
import { createLogger, type Logger } from "../log";
import { ModuleRegistry } from "../modules/registry";
import { WisperClient } from "../wisper/client";

import {
  attemptLeaseRelease,
  reconcileOrphanedDispatches,
  runDispatch,
  sweepPendingReleases,
} from "./executor";

/** A single request the fake wisper server observed. */
interface CapturedExec {
  leaseId: string;
  command: string;
}

/** High-level description of how the fake should answer one streaming exec. */
interface ExecPlan {
  /** Each string is emitted as one stdout `chunk` SSE frame, in order. */
  chunks?: string[];
  /** Terminal exit code (default 0); ignored when {@link errorCode} is set. */
  exitCode?: number;
  /** When set, the stream terminates with an `error` frame instead of `exit`. */
  errorCode?: string;
  /**
   * When true, the stream writes its chunks then hangs open forever, never
   * emitting a terminal frame — used to exercise the client aborting the stream
   * (e.g. the per-dispatch timeout). The client's abort tears down the socket.
   */
  hang?: boolean;
}

/** How the fake answers one synchronous (non-streaming) step exec. */
interface SyncResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * A tiny in-process wisper-api stand-in covering the three endpoints the
 * executor touches: create lease, streaming exec, release lease. It records the
 * bodies it received and which leases were released so tests can assert the
 * pipeline's lease bookkeeping.
 */
class FakeWisper {
  readonly createBodies: Record<string, unknown>[] = [];
  readonly execs: CapturedExec[] = [];
  readonly releasedLeases: string[] = [];
  /** Every DELETE that arrived — including the ones the fake failed. */
  readonly releaseAttempts: string[] = [];

  private plan: ExecPlan = { exitCode: 0 };
  private syncPlan: (command: string) => SyncResult = () => ({ exitCode: 0 });
  private createFailure: { status: number; body: unknown } | null = null;
  /**
   * Per-lease queue of release responses. Each entry is applied to the NEXT
   * DELETE against that lease; when the queue is empty the fake responds 200
   * (the default happy-path). Used to script "fail once then succeed" flows.
   */
  private releaseResponses: Map<
    string,
    Array<{ status: number; body: unknown }>
  > = new Map();
  private nextLease = 1;
  private leaseOs: "linux" | "windows" | null = null;
  private server!: http.Server;
  baseUrl = "";

  planExec(plan: ExecPlan): void {
    this.plan = plan;
  }

  /**
   * Queue one canned release response for the next DELETE against `leaseId`.
   * Call multiple times to script a sequence. Once the queue is drained, later
   * releases succeed as usual.
   */
  planReleaseResponse(
    leaseId: string,
    response: { status: number; body: unknown }
  ): void {
    const queue = this.releaseResponses.get(leaseId) ?? [];
    queue.push(response);
    this.releaseResponses.set(leaseId, queue);
  }

  /**
   * Make every subsequently created lease report this OS family in its create
   * response. Defaults to omitted (older-server behavior, treated as linux).
   */
  planLeaseOs(os: "linux" | "windows" | null): void {
    this.leaseOs = os;
  }

  /** Answer each synchronous step exec by inspecting its rendered command. */
  planSync(fn: (command: string) => SyncResult): void {
    this.syncPlan = fn;
  }

  failCreateWith(status: number, body: unknown): void {
    this.createFailure = { status, body };
  }

  private handle(
    method: string,
    url: string,
    body: string,
    res: http.ServerResponse
  ): void {
    if (method === "POST" && url === "/dev/leases") {
      this.createBodies.push(JSON.parse(body) as Record<string, unknown>);
      if (this.createFailure) {
        res.writeHead(this.createFailure.status, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(this.createFailure.body));
        return;
      }
      const leaseId = `lease-${this.nextLease++}`;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          leaseId,
          wispContractId: `wisp-${leaseId}`,
          status: "ready",
          ...(this.leaseOs !== null ? { os: this.leaseOs } : {}),
        })
      );
      return;
    }

    const execMatch = url.match(/^\/dev\/leases\/([^/]+)\/exec/);
    if (method === "POST" && execMatch) {
      const parsed = JSON.parse(body) as { command?: string };
      const command = parsed.command ?? "";
      this.execs.push({
        leaseId: decodeURIComponent(execMatch[1]),
        command,
      });
      // The agent step streams (`?stream=1`); pre/collect steps are synchronous.
      if (!url.includes("stream=1")) {
        const result = this.syncPlan(command);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exit_code: result.exitCode ?? 0,
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of this.plan.chunks ?? []) {
        res.write(
          `event: chunk\ndata: ${JSON.stringify({
            stream: "stdout",
            data: chunk,
          })}\n\n`
        );
      }
      if (this.plan.hang) {
        // Leave the response open with no terminal frame; the client aborts.
        return;
      }
      if (this.plan.errorCode) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: this.plan.errorCode })}\n\n`
        );
      } else {
        res.write(
          `event: exit\ndata: ${JSON.stringify({
            exit_code: this.plan.exitCode ?? 0,
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
      const queue = this.releaseResponses.get(leaseId);
      const scripted = queue?.shift();
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

describe("runDispatch pipeline", () => {
  let fake: FakeWisper;
  let db: Knex;
  let dbDir: string;
  let logDir: string;

  beforeEach(async () => {
    fake = new FakeWisper();
    await fake.start();

    dbDir = tempDir("orch-executor-db-");
    db = createDb(path.join(dbDir, "test.sqlite"));
    await runMigrations(db);

    logDir = tempDir("orch-executor-logs-");
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

  async function seedDispatch(
    overrides: Partial<NewPlaybook> = {}
  ): Promise<number> {
    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "42",
        payload: { title: "hello world" },
      },
      db
    );
    const playbook = await createPlaybook(
      {
        name: "pb",
        image: "ghcr.io/example/runner:latest",
        ttl_seconds: 600,
        userdata_template: "#!/bin/sh\necho {{ payload.title }}",
        prompt_template: "Handle {{ event.type }} for {{ payload.title }}.",
        ...overrides,
      },
      db
    );
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbook.id },
      db
    );
    return dispatch.id;
  }

  const deps = () => ({
    wisper: client(),
    resolveEnv: () => undefined,
    db,
    logger: silentLogger(),
    logBaseDir: logDir,
  });

  it("threads the playbook's host into createLease (dev mode: verbatim hostId)", async () => {
    fake.planExec({
      exitCode: 0,
      chunks: [JSON.stringify({ type: "result", result: "done" }) + "\n"],
    });
    const dispatchId = await seedDispatch({ host: "worker-9" });
    await runDispatch(dispatchId, deps());
    // In dev mode the selector is used verbatim as the dev hostId.
    expect(fake.createBodies[0].hostId).toBe("worker-9");
  });

  it("defaults createLease to the configured hostId when the playbook has no host", async () => {
    fake.planExec({
      exitCode: 0,
      chunks: [JSON.stringify({ type: "result", result: "done" }) + "\n"],
    });
    const dispatchId = await seedDispatch();
    await runDispatch(dispatchId, deps());
    expect(fake.createBodies[0].hostId).toBe("host-1");
  });

  it("success: streams to done, records a run + findings, releases the lease", async () => {
    // The NOTES_TO_SAVE block lives INSIDE the result envelope's `result` string,
    // exactly as real headless claude emits it (the block is part of the agent's
    // final message). It is honored only from there — never scraped from raw
    // stdout — so this is the shape that yields a finding.
    const resultText =
      'All checks passed.\n\n<NOTES_TO_SAVE>\n[{"content":"found a thing","visibility":"siblings","tags":["a"]}]\n</NOTES_TO_SAVE>';
    fake.planExec({
      exitCode: 0,
      chunks: [
        `{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
        JSON.stringify({
          type: "result",
          result: resultText,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }) + "\n",
      ],
    });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("done");
    expect(result.error).toBeNull();
    expect(result.lease_id).toBe("lease-1");
    expect(result.wisp_contract_id).toBe("wisp-lease-1");

    // Exactly one lease created and it was released.
    expect(fake.createBodies).toHaveLength(1);
    expect(fake.releasedLeases).toEqual(["lease-1"]);

    // userdata was rendered with the same {{...}} engine as prompts.
    expect(fake.createBodies[0].userdata).toBe("#!/bin/sh\necho hello world");

    // A run row captured the parsed result, summed usage, and log path.
    const runs = await listRuns(dispatchId, db);
    expect(runs).toHaveLength(1);
    expect(runs[0].exit_code).toBe(0);
    // result_text is the whole decoded envelope string, which carries the agent's
    // final message including its NOTES_TO_SAVE block.
    expect(runs[0].result_text).toContain("All checks passed.");
    expect(runs[0].usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(runs[0].log_path).toBe(
      path.join(logDir, "logs", `dispatch-${dispatchId}.log`)
    );

    // The finding from the NOTES_TO_SAVE block was persisted.
    const findings = await listFindings(runs[0].id, db);
    expect(findings).toHaveLength(1);
    expect(findings[0].content).toBe("found a thing");
    expect(findings[0].visibility).toBe("siblings");
    expect(findings[0].tags).toEqual(["a"]);

    // The log file received the streamed output.
    const logText = fs.readFileSync(runs[0].log_path as string, "utf8");
    expect(logText).toContain("All checks passed.");
  });

  it("persists findings from a NOTES_TO_SAVE block inside the result envelope (JSON-escaped on the wire)", async () => {
    // This is the shape real headless claude produces: the block lives in the
    // result string, so on the raw stream it is JSON-escaped and only becomes
    // parseable after the envelope is decoded. Regression test for the first
    // production run, which recorded zero findings.
    const resultText =
      'Wrapping up.\n\n<NOTES_TO_SAVE>\n[{"content":"escaped finding","visibility":"all","tags":["x"]}]\n</NOTES_TO_SAVE>';
    fake.planExec({
      exitCode: 0,
      chunks: [JSON.stringify({ type: "result", result: resultText }) + "\n"],
    });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());
    expect(result.status).toBe("done");

    const runs = await listRuns(dispatchId, db);
    expect(runs).toHaveLength(1);
    const findings = await listFindings(runs[0].id, db);
    expect(findings).toHaveLength(1);
    expect(findings[0].content).toBe("escaped finding");
    expect(findings[0].tags).toEqual(["x"]);
  });

  it("exit 0 with NO result envelope fails the dispatch (claude never ran), no run row", async () => {
    // Only prose noise, no `{"type":"result",...}` line: the stream-json contract
    // was never satisfied, so a zero exit is NOT success.
    fake.planExec({
      exitCode: 0,
      chunks: [`some noise\n`, `more noise but no envelope\n`],
    });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no stream-json result envelope");
    // No done run was recorded and the lease was still released.
    expect(await listRuns(dispatchId, db)).toHaveLength(0);
    expect(fake.releasedLeases).toEqual(["lease-1"]);
  });

  it("does not harvest a NOTES_TO_SAVE block echoed from raw output; run fails, zero findings", async () => {
    // Reproduces the windows quoting bug: powershell echoed the invocation and the
    // fully rendered prompt (exit 0, ~instant) instead of running claude. The
    // echoed prompt carries the protocol's OWN example block with a placeholder
    // finding. With no result envelope the dispatch must fail — and the placeholder
    // must NEVER be scraped from raw stdout into a finding.
    fake.planExec({
      exitCode: 0,
      chunks: [
        "& claude --print --dangerously-skip-permissions --output-format " +
          "stream-json --verbose You are an automated agent...\n",
        "<NOTES_TO_SAVE>\n" +
          '[{"content": "<your brief here>", "visibility": "all"}]\n' +
          "</NOTES_TO_SAVE>\n",
      ],
    });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no stream-json result envelope");
    // No run row, and therefore no findings — the placeholder was not persisted.
    const runs = await listRuns(dispatchId, db);
    expect(runs).toHaveLength(0);
    expect(fake.releasedLeases).toEqual(["lease-1"]);
  });

  it("ignores a NOTES_TO_SAVE block outside the result envelope even on a successful run", async () => {
    // A proper envelope is present (so the run succeeds), but a stray block sits in
    // raw stdout OUTSIDE it. Notes are honored only from the decoded envelope text,
    // so the stray block yields no finding.
    fake.planExec({
      exitCode: 0,
      chunks: [
        `{"type":"result","result":"clean result with no block"}\n`,
        "<NOTES_TO_SAVE>\n" +
          '[{"content": "scraped from raw stdout", "visibility": "all"}]\n' +
          "</NOTES_TO_SAVE>\n",
      ],
    });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("done");
    const runs = await listRuns(dispatchId, db);
    expect(runs).toHaveLength(1);
    expect(await listFindings(runs[0].id, db)).toHaveLength(0);
  });

  it("non-zero exit: fails with the exit code, no run row, lease released", async () => {
    fake.planExec({ exitCode: 3, chunks: [`nothing useful here\n`] });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("non-zero code 3");
    expect(fake.releasedLeases).toEqual(["lease-1"]);
    expect(await listRuns(dispatchId, db)).toHaveLength(0);
  });

  it("non-zero exit with an auth signal folds the match into the error", async () => {
    fake.planExec({
      exitCode: 1,
      chunks: [`Error: authentication_error: invalid credentials\n`],
    });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("auth failure: authentication_error");
    expect(fake.releasedLeases).toEqual(["lease-1"]);
  });

  it("thrown error mid-stream: fails and still releases the lease", async () => {
    fake.planExec({ errorCode: "host_offline", chunks: [`partial\n`] });

    const dispatchId = await seedDispatch();
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("host_offline");
    expect(fake.releasedLeases).toEqual(["lease-1"]);
    expect(await listRuns(dispatchId, db)).toHaveLength(0);
  });

  it("missing secret: fails WITHOUT creating a lease, so none is released", async () => {
    const dispatchId = await seedDispatch({
      env_requirements: ["SECRET_TOKEN"],
    });
    const result = await runDispatch(dispatchId, {
      ...deps(),
      resolveEnv: (name) => (name === "SECRET_TOKEN" ? undefined : "x"),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("SECRET_TOKEN");
    // No lease was ever created, and therefore none was released.
    expect(fake.createBodies).toHaveLength(0);
    expect(fake.releasedLeases).toHaveLength(0);
    expect(fake.execs).toHaveLength(0);
  });

  it("forwards resolved secrets into the lease env", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });

    const dispatchId = await seedDispatch({
      env_requirements: ["SECRET_TOKEN", "REGION"],
    });
    const secrets: Record<string, string> = {
      SECRET_TOKEN: "s3cr3t",
      REGION: "westus",
    };
    const result = await runDispatch(dispatchId, {
      ...deps(),
      resolveEnv: (name) => secrets[name],
    });

    expect(result.status).toBe("done");
    // The resolved secrets are forwarded verbatim. The lease env also carries the
    // rendered prompt under ORCH_AGENT_PROMPT (see the windows-prompt tests); it
    // is a separate concern from secret resolution and is asserted there.
    expect(fake.createBodies[0].env).toMatchObject({
      SECRET_TOKEN: "s3cr3t",
      REGION: "westus",
    });
  });

  it("missing secrets: reports ALL missing NAMES only, never their values", async () => {
    const dispatchId = await seedDispatch({
      env_requirements: ["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN", "REGION"],
    });
    const secrets: Record<string, string> = { REGION: "westus" };
    const result = await runDispatch(dispatchId, {
      ...deps(),
      resolveEnv: (name) => secrets[name],
    });

    expect(result.status).toBe("failed");
    // Both unmet names are listed together...
    expect(result.error).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(result.error).toContain("GIT_TOKEN");
    // ...the satisfied secret's NAME and VALUE never appear in the error.
    expect(result.error).not.toContain("REGION");
    expect(result.error).not.toContain("westus");
    // No lease was ever created.
    expect(fake.createBodies).toHaveLength(0);
    expect(fake.releasedLeases).toHaveLength(0);
  });

  it("resolves a setting:<key> image from app_settings at dispatch time", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });
    await setSetting("default_lease_image", "ghcr.io/example/prebaked:1", db);

    const dispatchId = await seedDispatch({ image: "setting:default_lease_image" });
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("done");
    expect(fake.createBodies[0].image).toBe("ghcr.io/example/prebaked:1");
  });

  it("fails without leasing when a setting:<key> image is unconfigured", async () => {
    const dispatchId = await seedDispatch({ image: "setting:default_lease_image" });
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("default_lease_image");
    expect(fake.createBodies).toHaveLength(0);
    expect(fake.releasedLeases).toHaveLength(0);
  });

  it("fails without leasing when the playbook names an unknown runner", async () => {
    const dispatchId = await seedDispatch({ runner: "no-such-runner" });
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no-such-runner");
    expect(fake.createBodies).toHaveLength(0);
    expect(fake.releasedLeases).toHaveLength(0);
  });

  it("builds the agent command with model, allowedTools, and a quoted prompt", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });

    const dispatchId = await seedDispatch({
      runner_config: { model: "claude-opus-4-8", allowed_tools: ["Bash", "Read"] },
    });
    await runDispatch(dispatchId, deps());

    expect(fake.execs).toHaveLength(1);
    const command = fake.execs[0].command;
    expect(command).toContain(
      "claude --print --dangerously-skip-permissions --output-format stream-json --verbose"
    );
    expect(command).toContain("--model claude-opus-4-8");
    expect(command).toContain("--allowedTools Bash,Read");
    // The prompt is a single shell-quoted trailing argument.
    expect(command).toMatch(/ '[\s\S]*'$/);
  });

  describe("script runner", () => {
    it("runs a script playbook end to end: rendered command, raw output, findings", async () => {
      // A script's output is arbitrary text, NOT stream-json — the raw captured
      // output is the result text as-is, and a printed NOTES_TO_SAVE block still
      // yields a finding.
      const scriptOutput =
        'build ok for hello world\n\n<NOTES_TO_SAVE>\n[{"content":"built widget 42","visibility":"siblings","tags":["build"]}]\n</NOTES_TO_SAVE>\n';
      fake.planExec({ exitCode: 0, chunks: [scriptOutput] });

      const dispatchId = await seedDispatch({
        runner: "script",
        // A script playbook needs no prompt; leave it empty to prove the runner
        // does not require one.
        prompt_template: "",
        runner_config: {
          command_template:
            "build.sh --type {{ event.type }} --title '{{ payload.title }}' --token {{ env.API_TOKEN }}",
        },
        env_requirements: ["API_TOKEN"],
      });

      const result = await runDispatch(dispatchId, {
        ...deps(),
        resolveEnv: (name) =>
          name === "API_TOKEN" ? "super-secret-token" : undefined,
      });

      expect(result.status).toBe("done");
      expect(result.error).toBeNull();

      // The command reached wisper with every template root rendered, including
      // the resolved secret.
      expect(fake.execs).toHaveLength(1);
      expect(fake.execs[0].command).toBe(
        "build.sh --type thing.changed --title 'hello world' --token super-secret-token"
      );

      // The run captured the raw output verbatim, with null usage (a script
      // reports no token metrics).
      const runs = await listRuns(dispatchId, db);
      expect(runs).toHaveLength(1);
      expect(runs[0].exit_code).toBe(0);
      expect(runs[0].result_text).toBe(scriptOutput);
      expect(runs[0].usage).toBeNull();

      // NOTES_TO_SAVE printed by the script became a finding.
      const findings = await listFindings(runs[0].id, db);
      expect(findings).toHaveLength(1);
      expect(findings[0].content).toBe("built widget 42");
      expect(findings[0].visibility).toBe("siblings");
      expect(findings[0].tags).toEqual(["build"]);

      // The lease was released.
      expect(fake.releasedLeases).toEqual(["lease-1"]);

      // The rendered command was MASKED in the dispatch log — the secret never
      // appears, the masked placeholder does.
      const logText = fs.readFileSync(runs[0].log_path as string, "utf8");
      expect(logText).toContain("$ agent: build.sh --type thing.changed");
      expect(logText).not.toContain("super-secret-token");
      expect(logText).toContain("--token ***");
    });

    it("a script that prints nothing is a valid run with no findings", async () => {
      fake.planExec({ exitCode: 0, chunks: [] });

      const dispatchId = await seedDispatch({
        runner: "script",
        prompt_template: "",
        runner_config: { command_template: "true" },
      });
      const result = await runDispatch(dispatchId, deps());

      expect(result.status).toBe("done");
      const runs = await listRuns(dispatchId, db);
      expect(runs).toHaveLength(1);
      expect(runs[0].result_text).toBe("");
      expect(runs[0].usage).toBeNull();
      expect(await listFindings(runs[0].id, db)).toHaveLength(0);
    });

    it("fails without leasing when command_template is missing", async () => {
      const dispatchId = await seedDispatch({
        runner: "script",
        prompt_template: "",
        runner_config: {},
      });
      const result = await runDispatch(dispatchId, deps());

      expect(result.status).toBe("failed");
      expect(result.error).toContain("command_template");
      expect(fake.createBodies).toHaveLength(0);
      expect(fake.releasedLeases).toHaveLength(0);
    });
  });

  describe("snippet resolution", () => {
    /** Plan a trivially successful agent result so the pipeline reaches `done`. */
    function planOk(): void {
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });
    }

    describe("prompt {{snippet.*}} tokens", () => {
      it("splices a prompt snippet's content into the rendered prompt", async () => {
        planOk();
        await createSnippet(
          { kind: "prompt", name: "intro", content: "INTRO_BLOCK" },
          db
        );
        const dispatchId = await seedDispatch({
          prompt_template: "Start. {{snippet.intro}} End.",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("done");
        expect(fake.execs).toHaveLength(1);
        expect(fake.execs[0].command).toContain("Start. INTRO_BLOCK End.");
      });

      it("renders event/payload/env tokens INSIDE snippet content", async () => {
        planOk();
        await createSnippet(
          {
            kind: "prompt",
            name: "ctx",
            content: "type={{event.type}} title={{payload.title}} tok={{env.TOK}}",
          },
          db
        );
        const dispatchId = await seedDispatch({
          prompt_template: "[{{snippet.ctx}}]",
          env_requirements: ["TOK"],
        });
        const result = await runDispatch(dispatchId, {
          ...deps(),
          resolveEnv: (name) => (name === "TOK" ? "s3cr3t" : undefined),
        });

        expect(result.status).toBe("done");
        expect(fake.execs[0].command).toContain(
          "[type=thing.changed title=hello world tok=s3cr3t]"
        );
      });

      it("stacks nested prompt snippets", async () => {
        planOk();
        await createSnippet(
          { kind: "prompt", name: "inner", content: "INNER" },
          db
        );
        await createSnippet(
          { kind: "prompt", name: "outer", content: "outer<{{snippet.inner}}>" },
          db
        );
        const dispatchId = await seedDispatch({
          prompt_template: "{{snippet.outer}}",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("done");
        expect(fake.execs[0].command).toContain("outer<INNER>");
      });

      it("fails BEFORE leasing on an unknown prompt snippet name", async () => {
        const dispatchId = await seedDispatch({
          prompt_template: "{{snippet.nope}}",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("unknown prompt snippet");
        expect(result.error).toContain("nope");
        expect(fake.createBodies).toHaveLength(0);
        expect(fake.releasedLeases).toHaveLength(0);
      });

      it("fails BEFORE leasing on a prompt snippet cycle", async () => {
        await createSnippet(
          { kind: "prompt", name: "a", content: "a{{snippet.b}}" },
          db
        );
        await createSnippet(
          { kind: "prompt", name: "b", content: "b{{snippet.a}}" },
          db
        );
        const dispatchId = await seedDispatch({
          prompt_template: "{{snippet.a}}",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("cycle");
        expect(fake.createBodies).toHaveLength(0);
      });

      it("fails BEFORE leasing when snippet nesting exceeds the depth cap", async () => {
        // Chain s0 -> s1 -> ... -> s6, deeper than the depth-5 cap, with no cycle.
        for (let i = 0; i < 6; i++) {
          await createSnippet(
            { kind: "prompt", name: `s${i}`, content: `[{{snippet.s${i + 1}}}]` },
            db
          );
        }
        await createSnippet(
          { kind: "prompt", name: "s6", content: "LEAF" },
          db
        );
        const dispatchId = await seedDispatch({
          prompt_template: "{{snippet.s0}}",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("depth");
        expect(fake.createBodies).toHaveLength(0);
      });

      it("does NOT resolve a `snippet:<name>` whole-value ref in a prompt (that is prompt-token-only)", async () => {
        // The whole-value `snippet:` prefix is for userdata/step, not prompts —
        // a prompt_template that is literally `snippet:foo` is passed through as
        // plain text (no token), so it stays verbatim.
        planOk();
        const dispatchId = await seedDispatch({
          prompt_template: "snippet:intro",
        });
        const result = await runDispatch(dispatchId, deps());
        expect(result.status).toBe("done");
        expect(fake.execs[0].command).toContain("snippet:intro");
      });
    });

    describe("userdata whole-value snippet:<name>", () => {
      it("resolves and renders a userdata snippet reference", async () => {
        planOk();
        await createSnippet(
          {
            kind: "userdata",
            name: "boot",
            content: "#!/bin/sh\necho {{ payload.title }}",
          },
          db
        );
        const dispatchId = await seedDispatch({
          userdata_template: "snippet:boot",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("done");
        expect(fake.createBodies[0].userdata).toBe("#!/bin/sh\necho hello world");
      });

      it("fails BEFORE leasing when the userdata snippet name is missing", async () => {
        const dispatchId = await seedDispatch({
          userdata_template: "snippet:missing",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("unknown userdata snippet");
        expect(fake.createBodies).toHaveLength(0);
        expect(fake.releasedLeases).toHaveLength(0);
      });

      it("fails BEFORE leasing when the referenced name is of a different kind", async () => {
        // A `prompt` snippet named `boot` must NOT satisfy a userdata reference.
        await createSnippet(
          { kind: "prompt", name: "boot", content: "x" },
          db
        );
        const dispatchId = await seedDispatch({
          userdata_template: "snippet:boot",
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("unknown userdata snippet");
        expect(fake.createBodies).toHaveLength(0);
      });
    });

    describe("step whole-value snippet:<name>", () => {
      it("resolves pre and collect step references and renders them at run time", async () => {
        fake.planExec({
          exitCode: 0,
          chunks: [`{"type":"result","result":"ok"}\n`],
        });
        fake.planSync(() => ({ stdout: "", exitCode: 0 }));
        await createSnippet(
          { kind: "step", name: "clone", content: "git clone {{ env.GIT }}" },
          db
        );
        await createSnippet(
          { kind: "step", name: "gather", content: "cat report-{{ payload.title }}" },
          db
        );
        const dispatchId = await seedDispatch({
          env_requirements: ["GIT"],
          steps: [
            { phase: "pre", command_template: "snippet:clone", label: "clone" },
            { phase: "collect", command_template: "snippet:gather", label: "gather" },
          ],
        });
        const result = await runDispatch(dispatchId, {
          ...deps(),
          resolveEnv: (name) => (name === "GIT" ? "tok" : undefined),
        });

        expect(result.status).toBe("done");
        // pre step (rendered), agent step, collect step (rendered).
        const commands = fake.execs.map((e) => e.command);
        expect(commands).toContain("git clone tok");
        expect(commands).toContain("cat report-hello world");
      });

      it("fails BEFORE leasing when a step snippet is missing", async () => {
        const dispatchId = await seedDispatch({
          steps: [
            { phase: "pre", command_template: "snippet:nope", label: "x" },
          ],
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("unknown step snippet");
        expect(fake.createBodies).toHaveLength(0);
        expect(fake.releasedLeases).toHaveLength(0);
      });

      it("fails BEFORE leasing when a step reference names a wrong-kind snippet", async () => {
        await createSnippet(
          { kind: "userdata", name: "clone", content: "x" },
          db
        );
        const dispatchId = await seedDispatch({
          steps: [
            { phase: "pre", command_template: "snippet:clone", label: "x" },
          ],
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("unknown step snippet");
        expect(fake.createBodies).toHaveLength(0);
      });
    });

    describe("script runner command_template snippet:<name>", () => {
      it("resolves a step-kind snippet as the script command", async () => {
        fake.planExec({ exitCode: 0, chunks: ["done\n"] });
        await createSnippet(
          {
            kind: "step",
            name: "build",
            content: "build.sh --title '{{ payload.title }}'",
          },
          db
        );
        const dispatchId = await seedDispatch({
          runner: "script",
          prompt_template: "",
          runner_config: { command_template: "snippet:build" },
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("done");
        expect(fake.execs[0].command).toBe("build.sh --title 'hello world'");
      });

      it("fails BEFORE leasing when the script's snippet is missing", async () => {
        const dispatchId = await seedDispatch({
          runner: "script",
          prompt_template: "",
          runner_config: { command_template: "snippet:missing" },
        });
        const result = await runDispatch(dispatchId, deps());

        expect(result.status).toBe("failed");
        expect(result.error).toContain("unknown step snippet");
        expect(fake.createBodies).toHaveLength(0);
        expect(fake.releasedLeases).toHaveLength(0);
      });
    });

    it("a rename breaks a live reference as a loud pre-lease failure", async () => {
      const snippet = await createSnippet(
        { kind: "prompt", name: "intro", content: "INTRO" },
        db
      );
      const dispatchId = await seedDispatch({
        name: "pb-rename-a",
        prompt_template: "{{snippet.intro}}",
      });

      // A dispatch works while the name matches...
      planOk();
      const first = await runDispatch(dispatchId, deps());
      expect(first.status).toBe("done");
      expect(fake.execs[0].command).toContain("INTRO");

      // ...but after renaming the snippet, the by-name reference is dangling and
      // the next dispatch fails loudly before any lease is created.
      await updateSnippet(snippet.id, { name: "intro_v2" }, db);
      const secondId = await seedDispatch({
        name: "pb-rename-b",
        prompt_template: "{{snippet.intro}}",
      });
      const before = fake.createBodies.length;
      const second = await runDispatch(secondId, deps());
      expect(second.status).toBe("failed");
      expect(second.error).toContain("unknown prompt snippet");
      // No NEW lease was created for the failed dispatch.
      expect(fake.createBodies.length).toBe(before);
    });
  });

  describe("windows lease prompt delivery", () => {
    // A playbook whose rendered prompt is laden with the characters that break a
    // cmd /c command line: quotes, %, $, backticks, pipes, and a newline.
    const HOSTILE_TEMPLATE =
      "It's a \"weird\" 100% $HOME `whoami` | pipe > redirect\n" +
      "second line for {{ payload.title }}.";
    const HOSTILE_RENDERED =
      "It's a \"weird\" 100% $HOME `whoami` | pipe > redirect\n" +
      "second line for hello world.";

    it("injects the exact rendered prompt into the lease env, not the command", async () => {
      fake.planLeaseOs("windows");
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });

      const dispatchId = await seedDispatch({
        prompt_template: HOSTILE_TEMPLATE,
      });
      const result = await runDispatch(dispatchId, deps());

      expect(result.status).toBe("done");
      // The lease env carries the fully rendered prompt verbatim — quotes and
      // newline included — under ORCH_AGENT_PROMPT.
      const env = fake.createBodies[0].env as Record<string, string>;
      expect(env.ORCH_AGENT_PROMPT).toContain(HOSTILE_RENDERED);

      // The agent exec command is the short, fixed powershell -EncodedCommand
      // string that reads the prompt from the environment; none of the prompt's
      // bytes appear on it, and it carries no double quotes to be mangled in
      // transport.
      const agentCmd = fake.execs.find((e) =>
        e.command.startsWith("powershell")
      )!.command;
      const expectedScript =
        "$env:ORCH_AGENT_PROMPT | & claude --print " +
        "--dangerously-skip-permissions --output-format stream-json --verbose";
      const expectedEncoded = Buffer.from(expectedScript, "utf16le").toString(
        "base64"
      );
      expect(agentCmd).toBe(
        `powershell -NoProfile -EncodedCommand ${expectedEncoded}`
      );
      expect(agentCmd).not.toContain('"');
      expect(agentCmd).not.toContain("weird");
      expect(agentCmd.length).toBeLessThan(2000);
    });

    it("keeps the command short and fixed no matter how large the prompt is", async () => {
      fake.planLeaseOs("windows");
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });

      // A ~20k-char prompt — well over the cmd 8191 ceiling, but comfortably
      // under the windows per-variable limit.
      const big = "context ".repeat(2500);
      const dispatchId = await seedDispatch({ prompt_template: big });
      const result = await runDispatch(dispatchId, deps());

      expect(result.status).toBe("done");
      const env = fake.createBodies[0].env as Record<string, string>;
      expect(env.ORCH_AGENT_PROMPT).toContain(big);
      const agentCmd = fake.execs.find((e) =>
        e.command.startsWith("powershell")
      )!.command;
      expect(agentCmd.length).toBeLessThan(2000);
    });

    it("fails clearly (no truncation) when the prompt exceeds the windows limit", async () => {
      fake.planLeaseOs("windows");
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });

      // Over the 30000-char env ceiling.
      const huge = "x".repeat(30001);
      const dispatchId = await seedDispatch({ prompt_template: huge });
      const result = await runDispatch(dispatchId, deps());

      expect(result.status).toBe("failed");
      expect(result.error).toContain("prompt too large for windows lease");
      // The over-limit prompt was never injected into the lease env...
      const env = (fake.createBodies[0].env ?? {}) as Record<string, string>;
      expect(env.ORCH_AGENT_PROMPT).toBeUndefined();
      // ...the agent was never invoked, and the lease was still released.
      expect(fake.execs.some((e) => e.command.includes("claude"))).toBe(false);
      expect(fake.releasedLeases).toEqual(["lease-1"]);
    });

    it("does not fail an over-limit prompt on a linux lease (argv has no ceiling)", async () => {
      fake.planLeaseOs("linux");
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });

      const huge = "x".repeat(30001);
      const dispatchId = await seedDispatch({ prompt_template: huge });
      const result = await runDispatch(dispatchId, deps());

      // Linux carries the prompt as an argv argument, so the size guard never
      // fires and the run completes.
      expect(result.status).toBe("done");
      const agentCmd = fake.execs.find((e) => e.command.includes("claude"))!
        .command;
      expect(agentCmd).toContain(huge);
      expect(agentCmd).not.toContain("$env:ORCH_AGENT_PROMPT");
    });
  });

  it("runs pre steps before the agent and collect steps after exit 0, in order", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });
    fake.planSync((command) =>
      command.includes("cat result.txt")
        ? { stdout: "the result body\n" }
        : { exitCode: 0 }
    );

    // Array order deliberately lists the collect step first to prove phase, not
    // array position, decides when a step runs.
    const dispatchId = await seedDispatch({
      steps: [
        { phase: "collect", label: "out", command_template: "cat result.txt" },
        { phase: "pre", label: "clone", command_template: "git clone repo" },
        { phase: "pre", label: "install", command_template: "npm ci" },
      ],
    });
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("done");

    const commands = fake.execs.map((e) => e.command);
    const agentIdx = commands.findIndex((c) => c.includes("claude --print"));
    // Pre steps ran, in array order, before the agent.
    expect(commands.indexOf("git clone repo")).toBe(0);
    expect(commands.indexOf("npm ci")).toBe(1);
    expect(commands.indexOf("npm ci")).toBeLessThan(agentIdx);
    // The collect step ran after the agent.
    expect(commands.indexOf("cat result.txt")).toBeGreaterThan(agentIdx);

    // The collect step's stdout was captured on the run, keyed by label.
    const runs = await listRuns(dispatchId, db);
    expect(runs[0].collected).toEqual({ out: "the result body\n" });
    expect(fake.releasedLeases).toEqual(["lease-1"]);
  });

  it("threads execTimeoutMs to every exec/stream/release call", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });
    fake.planSync(() => ({ exitCode: 0 }));

    const dispatchId = await seedDispatch({
      steps: [
        { phase: "pre", label: "clone", command_template: "git clone repo" },
        { phase: "collect", label: "out", command_template: "cat result.txt" },
      ],
    });

    const c = client();
    const execSyncSpy = jest.spyOn(c, "execSync");
    const execStreamSpy = jest.spyOn(c, "execStream");
    const releaseSpy = jest.spyOn(c, "releaseLease");

    const result = await runDispatch(dispatchId, {
      ...deps(),
      wisper: c,
      execTimeoutMs: 12345,
    });
    expect(result.status).toBe("done");

    // The pre and collect steps, the streaming agent exec, and the release all
    // carry the configured per-call timeout — never the client's create-lease
    // default.
    for (const call of execSyncSpy.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 12345 });
    }
    expect(execSyncSpy).toHaveBeenCalledTimes(2);
    expect(execStreamSpy.mock.calls[0][2]).toMatchObject({ timeoutMs: 12345 });
    expect(releaseSpy.mock.calls[0][1]).toMatchObject({ timeoutMs: 12345 });
  });

  it("defaults exec/stream/release to the 60s exec timeout when unset", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });

    const dispatchId = await seedDispatch();

    const c = client();
    const execStreamSpy = jest.spyOn(c, "execStream");
    const releaseSpy = jest.spyOn(c, "releaseLease");

    const result = await runDispatch(dispatchId, { ...deps(), wisper: c });
    expect(result.status).toBe("done");

    expect(execStreamSpy.mock.calls[0][2]).toMatchObject({ timeoutMs: 60000 });
    expect(releaseSpy.mock.calls[0][1]).toMatchObject({ timeoutMs: 60000 });
  });

  it("pre-step non-zero exit fails the dispatch and skips remaining steps + the agent", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });
    fake.planSync((command) =>
      command.includes("false-cmd") ? { exitCode: 7 } : { exitCode: 0 }
    );

    const dispatchId = await seedDispatch({
      steps: [
        { phase: "pre", label: "first", command_template: "false-cmd" },
        { phase: "pre", label: "second", command_template: "never-runs" },
        { phase: "collect", label: "out", command_template: "cat result.txt" },
      ],
    });
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toContain('pre step "first"');
    expect(result.error).toContain("non-zero code 7");

    // Only the failing pre step ran; the second pre step, the agent, and the
    // collect step were all short-circuited.
    expect(fake.execs.map((e) => e.command)).toEqual(["false-cmd"]);

    // Lease was still released; no run row was written.
    expect(fake.releasedLeases).toEqual(["lease-1"]);
    expect(await listRuns(dispatchId, db)).toHaveLength(0);
  });

  it("collect-step non-zero exit is logged but not fatal; every collect step still runs", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });
    fake.planSync((command) => {
      if (command.includes("collect-good")) return { stdout: "captured\n" };
      if (command.includes("collect-bad")) return { stdout: "partial\n", exitCode: 5 };
      return { exitCode: 0 };
    });

    const dispatchId = await seedDispatch({
      steps: [
        { phase: "collect", label: "good", command_template: "collect-good" },
        { phase: "collect", label: "bad", command_template: "collect-bad" },
      ],
    });
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("done");
    const runs = await listRuns(dispatchId, db);
    // Both labels captured, including the one whose command exited non-zero.
    expect(runs[0].collected).toEqual({ good: "captured\n", bad: "partial\n" });
    expect(fake.releasedLeases).toEqual(["lease-1"]);
  });

  it("masks resolved secrets in the step commands written to the dispatch log", async () => {
    fake.planExec({ exitCode: 0, chunks: [`{"type":"result","result":"ok"}\n`] });
    fake.planSync(() => ({ stdout: "done\n" }));

    const dispatchId = await seedDispatch({
      env_requirements: ["SECRET_TOKEN", "PIN"],
      steps: [
        {
          phase: "pre",
          label: "auth",
          command_template:
            "login --token {{env.SECRET_TOKEN}} --pin {{env.PIN}}",
        },
        {
          phase: "collect",
          label: "dump",
          command_template: "report --token {{env.SECRET_TOKEN}}",
        },
      ],
    });
    const secrets: Record<string, string> = {
      SECRET_TOKEN: "s3cr3t-value",
      PIN: "99",
    };
    const result = await runDispatch(dispatchId, {
      ...deps(),
      resolveEnv: (name) => secrets[name],
    });

    expect(result.status).toBe("done");

    // The real secret was substituted into the command wisper actually ran...
    expect(fake.execs.some((e) => e.command.includes("s3cr3t-value"))).toBe(true);

    // ...but the dispatch log only ever saw the masked form. The >3-char secret
    // is redacted; the 2-char PIN is left intact (too short to mask).
    const runs = await listRuns(dispatchId, db);
    const logText = fs.readFileSync(runs[0].log_path as string, "utf8");
    expect(logText).not.toContain("s3cr3t-value");
    expect(logText).toContain("login --token *** --pin 99");
    expect(logText).toContain("report --token ***");
  });

  it("per-dispatch timeout aborts the in-flight stream, fails 'timeout', releases the lease", async () => {
    // The stream hangs open with no terminal frame; only the deadline can end it.
    fake.planExec({ hang: true, chunks: [`working...\n`] });

    // A sub-second override tightens the deadline below ttl_seconds - 60 so the
    // timer fires quickly. This also exercises the min(...) with the setting.
    await setSetting("dispatch_timeout_seconds", "0.15", db);

    const dispatchId = await seedDispatch({ ttl_seconds: 600 });
    const result = await runDispatch(dispatchId, deps());

    expect(result.status).toBe("failed");
    expect(result.error).toBe("timeout");
    // The lease is still released despite the aborted stream, and no run row was
    // written because the agent never exited 0.
    expect(fake.releasedLeases).toEqual(["lease-1"]);
    expect(await listRuns(dispatchId, db)).toHaveLength(0);
  });

  it("injects a granted capability's labelled content into the agent prompt", async () => {
    fake.planExec({
      exitCode: 0,
      chunks: [`{"type":"result","result":"ok"}\n`],
    });

    let sawSubjectRef = "";
    let sawEnvNames: string[] | undefined;
    let sawEventType: string | undefined;
    let sawEventPayload: unknown;
    const registry = new ModuleRegistry();
    registry.register({
      id: "fakeMod",
      capabilities: [
        {
          id: "fake.cap",
          fetch: async (_config, subjectRef, context) => {
            sawSubjectRef = subjectRef;
            sawEnvNames = context?.envNames;
            sawEventType = context?.event?.type;
            sawEventPayload = context?.event?.payload;
            return {
              label: `Context for ${subjectRef}`,
              content: "SUPER-SECRET-CONTEXT-BLOCK",
            };
          },
        },
      ],
    });

    const dispatchId = await seedDispatch({
      granted_capabilities: [{ capability_id: "fake.cap" }],
      env_requirements: ["ADO_PAT"],
    });
    const result = await runDispatch(dispatchId, {
      ...deps(),
      // ADO_PAT is a required secret, so it must resolve or the dispatch fails
      // before capabilities are ever fetched.
      resolveEnv: (name) => (name === "ADO_PAT" ? "the-pat" : undefined),
      registry,
    });

    expect(result.status).toBe("done");
    // The capability's fetch was called with the event's subject_ref.
    expect(sawSubjectRef).toBe("42");
    // ...and with the playbook's env_requirements as the domain-neutral envNames.
    expect(sawEnvNames).toEqual(["ADO_PAT"]);
    // ...and with the triggering event surfaced so a capability can default from it.
    expect(sawEventType).toBe("thing.changed");
    expect(sawEventPayload).toBeDefined();
    // Its labelled block was rendered into the prompt handed to the agent exec.
    const agentExec = fake.execs.find((e) =>
      e.command.includes("SUPER-SECRET-CONTEXT-BLOCK")
    );
    expect(agentExec).toBeDefined();
    expect(agentExec?.command).toContain("## Context for 42");
  });

  it("skips an unknown granted capability with a warning and still completes", async () => {
    fake.planExec({
      exitCode: 0,
      chunks: [`{"type":"result","result":"ok"}\n`],
    });

    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), clock: () => 0 });
    // An empty registry knows no capabilities, so the grant is unresolvable.
    const registry = new ModuleRegistry();

    const dispatchId = await seedDispatch({
      granted_capabilities: [{ capability_id: "nope.missing" }],
    });
    const result = await runDispatch(dispatchId, {
      ...deps(),
      registry,
      logger,
    });

    expect(result.status).toBe("done");
    expect(await listRuns(dispatchId, db)).toHaveLength(1);
    expect(
      lines.some(
        (l) =>
          l.includes("unknown granted capability") &&
          l.includes("nope.missing")
      )
    ).toBe(true);
  });

  it("skips a granted capability whose fetch throws and still completes", async () => {
    fake.planExec({
      exitCode: 0,
      chunks: [`{"type":"result","result":"ok"}\n`],
    });

    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), clock: () => 0 });
    const registry = new ModuleRegistry();
    registry.register({
      id: "fakeMod",
      capabilities: [
        {
          id: "fake.boom",
          fetch: async () => {
            throw new Error("kaboom");
          },
        },
      ],
    });

    const dispatchId = await seedDispatch({
      granted_capabilities: [{ capability_id: "fake.boom" }],
    });
    const result = await runDispatch(dispatchId, {
      ...deps(),
      registry,
      logger,
    });

    expect(result.status).toBe("done");
    expect(
      lines.some(
        (l) => l.includes("failed to fetch") && l.includes("fake.boom")
      )
    ).toBe(true);
  });

  it("throws for an unknown dispatch id", async () => {
    await expect(runDispatch(9999, deps())).rejects.toThrow(/not found/);
  });

  describe("lease release retry and sweep", () => {
    it("happy path: sets released_at, does not flip release_pending, and needs no sweep", async () => {
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });
      const dispatchId = await seedDispatch();
      const result = await runDispatch(dispatchId, deps());
      expect(result.status).toBe("done");

      const persisted = await getDispatch(dispatchId, db);
      expect(persisted?.released_at).not.toBeNull();
      expect(persisted?.release_pending).toBe(false);
      expect(fake.releaseAttempts).toEqual(["lease-1"]);

      // A subsequent sweep must find nothing to do (no additional DELETE).
      const before = fake.releaseAttempts.length;
      const released = await sweepPendingReleases({
        wisper: client(),
        db,
        logger: silentLogger(),
      });
      expect(released).toBe(0);
      expect(fake.releaseAttempts.length).toBe(before);
    });

    it("retryable failure retries in-line, then succeeds, no sweep needed", async () => {
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });
      // First DELETE fails with a retryable code; the in-line retry succeeds.
      fake.planReleaseResponse("lease-1", {
        status: 504,
        body: {
          error: {
            code: "upstream_timeout",
            message: "upstream timed out",
            request_id: "r-1",
          },
        },
      });

      const dispatchId = await seedDispatch();
      const result = await runDispatch(dispatchId, deps());
      expect(result.status).toBe("done");

      const persisted = await getDispatch(dispatchId, db);
      expect(persisted?.released_at).not.toBeNull();
      expect(persisted?.release_pending).toBe(false);
      expect(fake.releaseAttempts).toEqual(["lease-1", "lease-1"]);
      expect(fake.releasedLeases).toEqual(["lease-1"]);
    });

    it("in-line retries exhausted: release_pending set, sweep succeeds later, released_at recorded", async () => {
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });
      // Both the initial call and every in-line retry (there are 2 backoffs =>
      // 3 total attempts) fail with a retryable code, so the executor flips
      // release_pending. Then the sweep succeeds.
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

      const dispatchId = await seedDispatch();
      const result = await runDispatch(dispatchId, deps());
      // The run itself still resolves `done` — release failure is orthogonal.
      expect(result.status).toBe("done");

      let persisted = await getDispatch(dispatchId, db);
      expect(persisted?.released_at).toBeNull();
      expect(persisted?.release_pending).toBe(true);
      expect(fake.releaseAttempts.length).toBe(3); // in-line: 1 + 2 retries

      // Now run the sweep with backoff = 0 so it does not skip us for the
      // per-lease cooldown. The next DELETE (no more scripted responses) 200s.
      const released = await sweepPendingReleases({
        wisper: client(),
        db,
        logger: silentLogger(),
        backoffMs: 0,
      });
      expect(released).toBe(1);

      persisted = await getDispatch(dispatchId, db);
      expect(persisted?.released_at).not.toBeNull();
      expect(persisted?.release_pending).toBe(false);
      expect(fake.releasedLeases).toEqual(["lease-1"]);
    });

    it("wisper 404 not_found is treated as a successful release", async () => {
      fake.planExec({
        exitCode: 0,
        chunks: [`{"type":"result","result":"ok"}\n`],
      });
      fake.planReleaseResponse("lease-1", {
        status: 404,
        body: {
          error: {
            code: "not_found",
            message: "no such lease",
            request_id: "r-nf",
          },
        },
      });

      const dispatchId = await seedDispatch();
      const result = await runDispatch(dispatchId, deps());
      expect(result.status).toBe("done");

      const persisted = await getDispatch(dispatchId, db);
      expect(persisted?.released_at).not.toBeNull();
      expect(persisted?.release_pending).toBe(false);
      // Only ONE DELETE was sent — the 404 was accepted and no retry ran.
      expect(fake.releaseAttempts).toEqual(["lease-1"]);
    });

    it("attemptLeaseRelease: not-found returns ok without retry", async () => {
      fake.planReleaseResponse("lease-XYZ", {
        status: 404,
        body: {
          error: { code: "not_found", message: "gone", request_id: "r-1" },
        },
      });
      const outcome = await attemptLeaseRelease(client(), "lease-XYZ", 2000);
      expect(outcome.ok).toBe(true);
      expect(fake.releaseAttempts).toEqual(["lease-XYZ"]);
    });

    it("attemptLeaseRelease: non-retryable error returns error immediately", async () => {
      // A validation_error is non-retryable, so no in-line retry should happen.
      fake.planReleaseResponse("lease-Y", {
        status: 400,
        body: {
          error: {
            code: "validation_error",
            message: "bad",
            request_id: "r-y",
          },
        },
      });
      const outcome = await attemptLeaseRelease(client(), "lease-Y", 2000);
      expect(outcome.ok).toBe(false);
      expect(fake.releaseAttempts).toEqual(["lease-Y"]);
    });

    it("sweep NEVER releases a lease belonging to an in-flight dispatch (regression)", async () => {
      // Regression: before task #59 the sweep query filtered only on lease_id
      // and released_at, with no status filter. An in-flight run's row (status
      // 'running'/'collecting', release_pending false, released_at null) also
      // matched, so the periodic sweep would DELETE the lease while the agent
      // was still using it. The status filter blocks that.
      for (const inFlight of ["leasing", "running", "collecting"] as const) {
        const event = await insertEvent(
          {
            source: "moduleA",
            type: "thing.changed",
            subject_kind: "widget",
            subject_ref: `inflight-${inFlight}`,
          },
          db
        );
        const playbook = await createPlaybook(
          {
            name: `pb-sweep-inflight-${inFlight}`,
            image: "img",
            ttl_seconds: 600,
          },
          db
        );
        const dispatch = await createDispatch(
          {
            event_id: event.id,
            playbook_id: playbook.id,
            status: inFlight,
            lease_id: `lease-inflight-${inFlight}`,
          },
          db
        );

        const released = await sweepPendingReleases({
          wisper: client(),
          db,
          logger: silentLogger(),
          // Rule out the backoff branch as the reason we saw no release.
          backoffMs: 0,
        });
        expect(released).toBe(0);
        // No DELETE was sent to wisper for this in-flight lease.
        expect(fake.releaseAttempts).not.toContain(
          `lease-inflight-${inFlight}`
        );
        expect(fake.releasedLeases).not.toContain(
          `lease-inflight-${inFlight}`
        );

        // The row is fully untouched — status, lease binding, and release
        // bookkeeping all as seeded. `runDispatch` still owns the release path.
        const persisted = await getDispatch(dispatch.id, db);
        expect(persisted?.status).toBe(inFlight);
        expect(persisted?.lease_id).toBe(`lease-inflight-${inFlight}`);
        expect(persisted?.released_at).toBeNull();
        expect(persisted?.release_pending).toBe(false);
      }
    });

    it("boot sweep releases a terminal dispatch that still holds a lease", async () => {
      // Simulate the state left behind by a crashed process: a `done` dispatch
      // whose lease was never released (released_at null) and never marked
      // release_pending. The sweep must still pick it up.
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
        { name: "pb-sweep-done", image: "img", ttl_seconds: 600 },
        db
      );
      const dispatch = await createDispatch(
        {
          event_id: event.id,
          playbook_id: playbook.id,
          status: "done",
          lease_id: "lease-stranded",
        },
        db
      );

      const released = await sweepPendingReleases({
        wisper: client(),
        db,
        logger: silentLogger(),
        // No release_pending is set, so the backoff branch does not apply.
      });
      expect(released).toBe(1);
      expect(fake.releasedLeases).toEqual(["lease-stranded"]);

      const persisted = await getDispatch(dispatch.id, db);
      expect(persisted?.released_at).not.toBeNull();
      expect(persisted?.release_pending).toBe(false);
      // Terminal status is preserved.
      expect(persisted?.status).toBe("done");
    });

    it("sweep respects per-lease backoff for release_pending rows", async () => {
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
        { name: "pb-sweep-backoff", image: "img", ttl_seconds: 600 },
        db
      );
      const dispatch = await createDispatch(
        {
          event_id: event.id,
          playbook_id: playbook.id,
          status: "failed",
          lease_id: "lease-cooldown",
          release_pending: true,
        },
        db
      );

      // With a 10-minute cooldown vs. an immediate call, the sweep must skip
      // this row entirely — no DELETE fires against wisper.
      const released = await sweepPendingReleases({
        wisper: client(),
        db,
        logger: silentLogger(),
        backoffMs: 600_000,
      });
      expect(released).toBe(0);
      expect(fake.releaseAttempts).toHaveLength(0);

      // The row is unchanged: still pending, still no released_at.
      const persisted = await getDispatch(dispatch.id, db);
      expect(persisted?.release_pending).toBe(true);
      expect(persisted?.released_at).toBeNull();
    });
  });

  describe("reconcileOrphanedDispatches", () => {
    let seedSeq = 0;

    /** Seed one dispatch in a specific state, optionally holding a lease. */
    async function seedInState(
      status: "queued" | "leasing" | "running" | "collecting" | "done" | "failed",
      leaseId: string | null
    ): Promise<number> {
      const event = await insertEvent(
        {
          source: "moduleA",
          type: "thing.changed",
          subject_kind: "widget",
          subject_ref: "1",
        },
        db
      );
      // Playbook names are unique; each seeded row needs a distinct one.
      const playbook = await createPlaybook(
        { name: `pb-${seedSeq++}`, image: "img", ttl_seconds: 600 },
        db
      );
      const dispatch = await createDispatch(
        {
          event_id: event.id,
          playbook_id: playbook.id,
          status,
          lease_id: leaseId,
        },
        db
      );
      return dispatch.id;
    }

    it("fails every in-flight dispatch, releases held leases, leaves the rest", async () => {
      const leasing = await seedInState("leasing", "lease-A");
      const running = await seedInState("running", "lease-B");
      const collecting = await seedInState("collecting", null);
      const queued = await seedInState("queued", null);
      const done = await seedInState("done", "lease-C");

      const count = await reconcileOrphanedDispatches({
        wisper: client(),
        db,
        logger: silentLogger(),
      });

      expect(count).toBe(3);

      for (const id of [leasing, running, collecting]) {
        const d = await getDispatch(id, db);
        expect(d?.status).toBe("failed");
        expect(d?.error).toBe("orphaned_by_restart");
      }

      // Only the two in-flight dispatches that HELD a lease were released; the
      // collecting one had none, and the terminal `done` lease is untouched.
      expect(fake.releasedLeases.sort()).toEqual(["lease-A", "lease-B"]);

      // queued and done were left exactly as they were.
      expect((await getDispatch(queued, db))?.status).toBe("queued");
      expect((await getDispatch(done, db))?.status).toBe("done");
    });

    it("is best-effort on lease release: a failing release still fails the dispatch", async () => {
      const leasing = await seedInState("leasing", "lease-A");
      // A wisper whose releaseLease always throws stands in for a release error.
      const throwingWisper = {
        releaseLease: async () => {
          throw new Error("host_offline");
        },
      } as unknown as WisperClient;

      const count = await reconcileOrphanedDispatches({
        wisper: throwingWisper,
        db,
        logger: silentLogger(),
      });

      expect(count).toBe(1);
      const d = await getDispatch(leasing, db);
      expect(d?.status).toBe("failed");
      expect(d?.error).toBe("orphaned_by_restart");
    });

    it("without a wisper client, still fails in-flight dispatches (leases left to TTL)", async () => {
      const running = await seedInState("running", "lease-A");

      const count = await reconcileOrphanedDispatches({
        wisper: null,
        db,
        logger: silentLogger(),
      });

      expect(count).toBe(1);
      const d = await getDispatch(running, db);
      expect(d?.status).toBe("failed");
      expect(d?.error).toBe("orphaned_by_restart");
      // No client, so nothing was released.
      expect(fake.releasedLeases).toHaveLength(0);
    });

    it("logs a loud warning for a 'leasing' orphan with no lease_id (mid-createLease crash)", async () => {
      // Simulate a process death between flipping to 'leasing' and the
      // createLease response landing: the row is 'leasing' with no lease_id,
      // and a lease may exist server-side that only the TTL can catch.
      const dispatchId = await seedInState("leasing", null);

      const lines: string[] = [];
      const logger = createLogger({
        sink: (l) => lines.push(l),
        clock: () => 0,
      });
      const count = await reconcileOrphanedDispatches({
        wisper: client(),
        db,
        logger,
      });

      expect(count).toBe(1);
      expect(
        lines.some(
          (l) =>
            l.includes("orphaned dispatch in 'leasing' with no lease_id") &&
            l.includes(String(dispatchId))
        )
      ).toBe(true);
      // The dispatch is still failed with orphaned_by_restart, and no DELETE was
      // sent (nothing to release).
      const d = await getDispatch(dispatchId, db);
      expect(d?.status).toBe("failed");
      expect(d?.error).toBe("orphaned_by_restart");
      expect(fake.releaseAttempts).toHaveLength(0);
    });

    it("returns 0 and releases nothing when there is nothing to reconcile", async () => {
      await seedInState("queued", null);
      await seedInState("done", "lease-Z");

      const count = await reconcileOrphanedDispatches({
        wisper: client(),
        db,
        logger: silentLogger(),
      });

      expect(count).toBe(0);
      expect(fake.releasedLeases).toHaveLength(0);
    });
  });
});
