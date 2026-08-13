/**
 * An in-process stand-in for the wisper-api dev lease surface, used by the
 * end-to-end MVP flow test. It implements exactly the three lifecycle operations
 * orchestrator drives — `POST /dev/leases`, `POST /dev/leases/:id/exec` (both the
 * synchronous form and the `?stream=1` SSE form), and `DELETE /dev/leases/:id` —
 * and records enough of each call to assert the pipeline behaved.
 *
 * Streaming agent execs are scripted: each consumes the next {@link ScriptedAgentRun}
 * (the last one repeats), so a test can drive a success then a failure, or replay
 * the same run for every dispatch. Every synchronous exec (a playbook `pre`/`collect`
 * step, e.g. the researcher's `git clone`) simply succeeds with exit 0 — the flow
 * under test cares about the agent step, not the shell steps.
 *
 * The fake is deliberately domain-neutral: it replays whatever claude stream-json
 * bytes the script hands it and never inspects intent.
 */

import http from "http";
import type { AddressInfo } from "net";

/** Token totals attached to the scripted `result` envelope. */
export interface ScriptedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * One scripted streaming agent exec: the terminal exit code plus the pieces of
 * claude `--output-format stream-json` output the fake replays as SSE `chunk`
 * frames before the terminal `exit` frame.
 */
export interface ScriptedAgentRun {
  /** Terminal exit code delivered by the SSE `exit` event (default 0). */
  exitCode?: number;
  /** `result` string of the emitted `{"type":"result"}` envelope. */
  resultText?: string;
  /** Usage totals attached to the result envelope; omit to emit none. */
  usage?: ScriptedUsage;
  /**
   * Note objects emitted inside a single `<NOTES_TO_SAVE>` block; omit or leave
   * empty to emit no block (so a failed run produces no findings).
   */
  notes?: unknown[];
}

/** A single exec the fake observed, in wire order. */
export interface RecordedExec {
  leaseId: string;
  command: string;
  /** True for the `?stream=1` SSE agent exec, false for a synchronous step. */
  streaming: boolean;
}

/**
 * Assemble the raw claude stream-json output for one scripted run: an init line,
 * a prose line, an optional NOTES_TO_SAVE block, then the terminal `result`
 * envelope (carrying usage when scripted). The executor accumulates the streamed
 * `chunk` payloads into exactly this string before parsing it.
 */
function buildAgentOutput(run: ScriptedAgentRun): string {
  const lines: string[] = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }),
    "Exploring the cloned repository as instructed...",
  ];
  // The agent's final message — the envelope's `result` string — carries any
  // NOTES_TO_SAVE block, exactly as real headless claude emits it. The executor
  // honors notes ONLY from inside the decoded envelope, never scraped from raw
  // stdout, so the block must ride the result text, not sit on its own line.
  let resultText = run.resultText ?? "done";
  if (run.notes && run.notes.length > 0) {
    resultText += `\n\n<NOTES_TO_SAVE>\n${JSON.stringify(run.notes)}\n</NOTES_TO_SAVE>`;
  }
  const envelope: Record<string, unknown> = {
    type: "result",
    subtype: "success",
    result: resultText,
  };
  if (run.usage) envelope.usage = run.usage;
  lines.push(JSON.stringify(envelope));
  return `${lines.join("\n")}\n`;
}

export class FakeWisper {
  /** Every `POST /dev/leases` body the fake received, in order. */
  readonly createRequests: Record<string, unknown>[] = [];
  /** Every exec (sync + streaming) the fake received, in wire order. */
  readonly execs: RecordedExec[] = [];
  /** Every leaseId released via `DELETE`, in order. */
  readonly deletedLeases: string[] = [];

  /** Milliseconds to wait before answering `POST /dev/leases` with a 201. */
  createDelayMs = 5;

  private runs: ScriptedAgentRun[] = [{ exitCode: 0 }];
  private streamCount = 0;
  private nextLease = 1;
  private server!: http.Server;
  baseUrl = "";

  /** Queue the scripted streaming runs; the last one repeats past the queue end. */
  scriptRuns(runs: ScriptedAgentRun[]): void {
    this.runs = runs.length > 0 ? runs : [{ exitCode: 0 }];
    this.streamCount = 0;
  }

  private nextRun(): ScriptedAgentRun {
    const idx = Math.min(this.streamCount, this.runs.length - 1);
    this.streamCount += 1;
    return this.runs[idx];
  }

  private streamRun(run: ScriptedAgentRun, res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Split the output mid-way so the client's SSE reassembler is exercised
    // across a chunk boundary rather than handed one whole frame.
    const output = buildAgentOutput(run);
    const mid = Math.floor(output.length / 2);
    for (const piece of [output.slice(0, mid), output.slice(mid)]) {
      res.write(
        `event: chunk\ndata: ${JSON.stringify({
          stream: "stdout",
          data: piece,
        })}\n\n`
      );
    }
    res.write(
      `event: exit\ndata: ${JSON.stringify({ exit_code: run.exitCode ?? 0 })}\n\n`
    );
    res.end();
  }

  private handle(
    method: string,
    url: string,
    body: string,
    res: http.ServerResponse
  ): void {
    if (method === "POST" && url === "/dev/leases") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      this.createRequests.push(parsed);
      const leaseId = `lease-${this.nextLease++}`;
      // Echo back the requested isolation verbatim when the caller sent one
      // (absent otherwise). No validation — the fake mirrors what it received.
      const { isolation } = parsed;
      // A createLease 201 blocks on lease readiness by design; model that with a
      // brief delay so the executor genuinely awaits provisioning.
      setTimeout(() => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            leaseId,
            wispContractId: `wisp-${leaseId}`,
            status: "ready",
            ...(isolation !== undefined ? { isolation } : {}),
          })
        );
      }, this.createDelayMs);
      return;
    }

    if (method === "POST" && url === "/v1/leases") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      this.createRequests.push(parsed);
      // Mirror the real wisper-api v1 contract: resources are fixed by the
      // selected offer server-side, so any body carrying a `resources` object
      // or a top-level `gpus` is rejected with a 400 validation_error. This is
      // the shape that RejectClientResourceKnobs enforces on the real server —
      // the fake enforces it so orchestrator tests catch the drift class.
      if (
        Object.prototype.hasOwnProperty.call(parsed, "resources") ||
        Object.prototype.hasOwnProperty.call(parsed, "gpus")
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "validation_error",
              message: "resources are fixed by the selected offer",
            },
          })
        );
        return;
      }
      const leaseId = `lease-${this.nextLease++}`;
      const { isolation } = parsed;
      setTimeout(() => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: leaseId,
            wisp_contract_id: `wisp-${leaseId}`,
            status: "ready",
            ...(isolation !== undefined ? { isolation } : {}),
          })
        );
      }, this.createDelayMs);
      return;
    }

    const execMatch = url.match(/^\/(?:dev|v1)\/leases\/([^/?]+)\/exec/);
    if (method === "POST" && execMatch) {
      const leaseId = decodeURIComponent(execMatch[1]);
      const command = (JSON.parse(body) as { command?: string }).command ?? "";
      const streaming = /[?&]stream=1(?:&|$)/.test(url);
      this.execs.push({ leaseId, command, streaming });
      if (streaming) {
        this.streamRun(this.nextRun(), res);
      } else {
        // Synchronous steps (e.g. the researcher's git clone) always succeed;
        // the flow under test asserts on the agent step, not the shell steps.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stdout: "", stderr: "", exit_code: 0 }));
      }
      return;
    }

    const delMatch = url.match(/^\/(?:dev|v1)\/leases\/([^/?]+)/);
    if (method === "DELETE" && delMatch) {
      this.deletedLeases.push(decodeURIComponent(delMatch[1]));
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
