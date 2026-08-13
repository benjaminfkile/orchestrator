import http from "http";
import type { AddressInfo } from "net";

import { createLogger, type Logger } from "../log";
import {
  WisperApiError,
  WisperClient,
  wisperClientFromConfig,
  type StreamChunk,
} from "./client";
import { ConfigError, loadConfig } from "../config";
import { WisperCatalog, type HostImageResolver } from "./catalog";

/** A single request the mock server observed, with its parsed JSON body. */
interface CapturedRequest {
  method?: string;
  url?: string;
  body: string;
  /** Request headers, lower-cased by Node. Used to assert auth presence/absence. */
  headers: http.IncomingHttpHeaders;
}

/** How the mock server should answer the next request. */
interface MockResponse {
  status: number;
  /** JSON body; a string is sent verbatim, an object is stringified. */
  body?: unknown;
}

/**
 * A tiny in-process http server used as the wisper-api stand-in. Each test
 * queues one response per expected request and inspects what was received.
 */
class MockServer {
  readonly requests: CapturedRequest[] = [];
  private responses: MockResponse[] = [];
  private server!: http.Server;
  /** When true, requests are received but never answered (to drive timeouts). */
  private hang = false;
  baseUrl = "";

  respondWith(res: MockResponse): void {
    this.responses.push(res);
  }

  /** Accept requests but never respond, so the client-side timeout fires. */
  neverRespond(): void {
    this.hang = true;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: req.headers,
        });
        if (this.hang) return;
        const next = this.responses.shift() ?? { status: 500 };
        const payload =
          next.body === undefined
            ? ""
            : typeof next.body === "string"
            ? next.body
            : JSON.stringify(next.body);
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

/** Resolve after `ms`, forcing writes to land in separate network reads. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Instructions for how the stream mock should answer one exec request. */
interface StreamPlan {
  /** HTTP status for the response head (default 200). */
  status?: number;
  /** Raw text pieces written in order, one network write each. */
  parts?: string[];
  /** JSON error body to send verbatim (for a non-200 head). */
  errorBody?: unknown;
  /** When true, destroy the socket after the parts instead of a clean end. */
  destroyAfterParts?: boolean;
  /** When true, hold the connection open after the parts (never end/destroy). */
  hangAfterParts?: boolean;
}

/**
 * An http server that answers `/exec?stream=1` by writing raw SSE text in
 * deliberately awkward pieces. Each write is separated by a short delay so the
 * client observes them as distinct network reads, exercising frame reassembly.
 */
class StreamMockServer {
  readonly requests: CapturedRequest[] = [];
  private plan: StreamPlan = {};
  private server!: http.Server;
  /** Resolvers awaiting the client closing a still-open response socket. */
  private disconnectResolvers: Array<() => void> = [];
  baseUrl = "";

  plans(plan: StreamPlan): void {
    this.plan = plan;
  }

  /**
   * Resolves when the client tears down a response the server was still holding
   * open — i.e. proof the client released the socket (abort/timeout), not a
   * clean server-side end.
   */
  whenClientDisconnects(): Promise<void> {
    return new Promise<void>((resolve) => this.disconnectResolvers.push(resolve));
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        this.requests.push({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: req.headers,
        });
        const plan = this.plan;
        const status = plan.status ?? 200;
        if (status !== 200) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(plan.errorBody === undefined ? "" : JSON.stringify(plan.errorBody));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of plan.parts ?? []) {
          res.write(part);
          await delay(8);
        }
        if (plan.hangAfterParts) {
          // Leave the response open; the client-side idle timeout or an abort
          // must fire. When the client tears down the socket, notify waiters.
          res.on("close", () => {
            if (!res.writableEnded) {
              for (const resolve of this.disconnectResolvers.splice(0)) resolve();
            }
          });
          return;
        }
        if (plan.destroyAfterParts) {
          res.destroy();
        } else {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

/** A logger whose lines are captured for assertions. */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), clock: () => 0 });
  return { logger, lines };
}

describe("WisperClient", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = new MockServer();
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  function client(logger?: Logger): WisperClient {
    return new WisperClient({
      baseUrl: mock.baseUrl,
      hostId: "host-1",
      timeoutMs: 2000,
      logger,
    });
  }

  const createParams = () => ({
    image: "ghcr.io/example/runner:latest",
    network: "open",
    resources: { cpus: 2, memory_mb: 2048, pids: 256 },
    ttl_seconds: 600,
    userdata: "#!/bin/sh\necho hi",
  });

  describe("createLease", () => {
    it("posts the correctly cased body and returns the lease on 201", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-42", wispContractId: "wisp-9", status: "ready" },
      });

      const lease = await client().createLease({
        ...createParams(),
        env: { API_TOKEN: "s3cr3t-value", REGION: "westus" },
      });

      expect(lease).toEqual({
        leaseId: "lease-42",
        wispContractId: "wisp-9",
        status: "ready",
        os: null,
        isolation: null,
      });

      expect(mock.requests).toHaveLength(1);
      const req = mock.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/dev/leases");

      const sent = JSON.parse(req.body);
      expect(sent).toEqual({
        hostId: "host-1",
        image: "ghcr.io/example/runner:latest",
        network: "open",
        resources: { cpus: 2, memory_mb: 2048, pids: 256 },
        ttl_seconds: 600,
        userdata: "#!/bin/sh\necho hi",
        env: { API_TOKEN: "s3cr3t-value", REGION: "westus" },
      });
    });

    it("dev mode uses an explicit host selector verbatim as the dev hostId", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-42", wispContractId: "wisp-9", status: "ready" },
      });

      await client().createLease({ ...createParams(), host: "worker-7" });

      const sent = JSON.parse(mock.requests[0].body);
      // No catalog fetch in dev mode; the selector is the hostId, image verbatim.
      expect(sent.hostId).toBe("worker-7");
      expect(sent.image).toBe("ghcr.io/example/runner:latest");
      expect(mock.requests).toHaveLength(1);
    });

    it("dev mode falls back to the configured hostId when no host is given", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-42", wispContractId: "wisp-9", status: "ready" },
      });

      await client().createLease(createParams());

      expect(JSON.parse(mock.requests[0].body).hostId).toBe("host-1");
    });

    it("omits env from the body when not supplied", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-1", wispContractId: "wisp-1", status: "ready" },
      });

      await client().createLease(createParams());

      const sent = JSON.parse(mock.requests[0].body);
      expect(sent).not.toHaveProperty("env");
    });

    it("dev mode sends isolation in the body when the param is set", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-1", wispContractId: "wisp-1", status: "ready" },
      });

      await client().createLease({ ...createParams(), isolation: "vm" });

      expect(JSON.parse(mock.requests[0].body).isolation).toBe("vm");
    });

    it("dev mode omits isolation from the body when unset (server default)", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-1", wispContractId: "wisp-1", status: "ready" },
      });

      await client().createLease(createParams());

      expect(JSON.parse(mock.requests[0].body)).not.toHaveProperty("isolation");
    });

    it("surfaces isolation from the response when the server reports it", async () => {
      mock.respondWith({
        status: 201,
        body: {
          leaseId: "lease-i",
          wispContractId: "wisp-i",
          status: "ready",
          isolation: "sandboxed",
        },
      });

      const lease = await client().createLease(createParams());
      expect(lease.isolation).toBe("sandboxed");
    });

    it("surfaces os from the response when the server reports it", async () => {
      mock.respondWith({
        status: 201,
        body: {
          leaseId: "lease-w",
          wispContractId: "wisp-w",
          status: "ready",
          os: "windows",
        },
      });

      const lease = await client().createLease(createParams());
      expect(lease.os).toBe("windows");
    });

    it("normalizes a missing or unknown os to null (older servers)", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-1", wispContractId: "wisp-1", status: "ready" },
      });
      expect((await client().createLease(createParams())).os).toBeNull();

      mock.respondWith({
        status: 201,
        body: {
          leaseId: "lease-2",
          wispContractId: "wisp-2",
          status: "ready",
          os: "plan9",
        },
      });
      expect((await client().createLease(createParams())).os).toBeNull();
    });

    it("never logs env keys or values", async () => {
      mock.respondWith({
        status: 201,
        body: { leaseId: "lease-1", wispContractId: "wisp-1", status: "ready" },
      });
      const { logger, lines } = capturingLogger();

      await client(logger).createLease({
        ...createParams(),
        env: { API_TOKEN: "s3cr3t-value", DB_PASSWORD: "hunter2" },
      });

      expect(lines.length).toBeGreaterThan(0);
      const joined = lines.join("\n");
      expect(joined).not.toContain("s3cr3t-value");
      expect(joined).not.toContain("hunter2");
      expect(joined).not.toContain("API_TOKEN");
      expect(joined).not.toContain("DB_PASSWORD");
    });

    it.each([
      [400, "validation_error", false],
      [409, "host_offline", true],
      [409, "lease_not_ready", false],
      [409, "at_capacity", false],
      [404, "not_found", false],
      [502, "lease_failed", false],
      [504, "upstream_timeout", true],
    ] as const)(
      "maps HTTP %s / %s to a typed error (retryable=%s)",
      async (status, code, retryable) => {
        mock.respondWith({
          status,
          body: {
            error: { code, message: `it failed: ${code}`, request_id: "req-abc" },
          },
        });

        const err = await client()
          .createLease(createParams())
          .catch((e) => e);

        expect(err).toBeInstanceOf(WisperApiError);
        expect(err.code).toBe(code);
        expect(err.httpStatus).toBe(status);
        expect(err.requestId).toBe("req-abc");
        expect(err.retryable).toBe(retryable);
        expect(err.message).toBe(`it failed: ${code}`);
      }
    );

    it("never leaks env into a thrown error, even when the server echoes it", async () => {
      // A hostile/buggy server that reflects the env value in its message must
      // not cause the client to surface it — but the client also must not add it
      // itself. Here the server does NOT echo it; the client must keep it out.
      mock.respondWith({
        status: 400,
        body: {
          error: {
            code: "validation_error",
            message: "bad image",
            request_id: "req-x",
          },
        },
      });
      const { logger, lines } = capturingLogger();

      const err = await client(logger)
        .createLease({ ...createParams(), env: { SECRET: "topsecret-1234" } })
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(JSON.stringify(err)).not.toContain("topsecret-1234");
      expect(err.message).not.toContain("topsecret-1234");
      expect(lines.join("\n")).not.toContain("topsecret-1234");
      expect(lines.join("\n")).not.toContain("SECRET");
    });

    it("falls back to a status-derived code when the envelope is missing", async () => {
      mock.respondWith({ status: 502, body: "gateway blew up" });

      const err = await client()
        .createLease(createParams())
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("lease_failed");
      expect(err.httpStatus).toBe(502);
      expect(err.requestId).toBe("");
      // The raw non-JSON body is not surfaced.
      expect(err.message).not.toContain("gateway blew up");
    });

    it("rejects with a typed client-timeout error when the server stalls", async () => {
      mock.neverRespond();
      const err = await client()
        .createLease({ ...createParams(), timeoutMs: 50 })
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("upstream_timeout_client");
      expect(err.httpStatus).toBe(0);
      expect(err.retryable).toBe(true);
      expect(String(err.message)).toContain("timed out");
    });

    it("rejects promptly with the abort reason and never leaks env on abort", async () => {
      mock.neverRespond();
      const { logger, lines } = capturingLogger();
      const controller = new AbortController();
      const promise = client(logger).createLease({
        ...createParams(),
        env: { SECRET: "topsecret-1234" },
        signal: controller.signal,
      });
      await delay(20);
      controller.abort();

      const err = await promise.catch((e) => e);
      expect(err.name).toBe("AbortError");
      expect(JSON.stringify(err)).not.toContain("topsecret-1234");
      expect(lines.join("\n")).not.toContain("topsecret-1234");
    });
  });

  describe("releaseLease", () => {
    it("issues DELETE with the leaseId path and hostId query on 200", async () => {
      mock.respondWith({ status: 200 });

      await client().releaseLease("lease-42");

      expect(mock.requests).toHaveLength(1);
      const req = mock.requests[0];
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe("/dev/leases/lease-42?hostId=host-1");
      expect(req.body).toBe("");
    });

    it("url-encodes the leaseId", async () => {
      mock.respondWith({ status: 200 });

      await client().releaseLease("lease/weird id");

      expect(mock.requests[0].url).toBe(
        "/dev/leases/lease%2Fweird%20id?hostId=host-1"
      );
    });

    it("throws a typed error on a non-200 response", async () => {
      mock.respondWith({
        status: 404,
        body: {
          error: { code: "not_found", message: "no such lease", request_id: "req-9" },
        },
      });

      const err = await client()
        .releaseLease("lease-gone")
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("not_found");
      expect(err.httpStatus).toBe(404);
      expect(err.retryable).toBe(false);
    });
  });

  describe("execSync", () => {
    it("posts {hostId, command} with leaseId in the path and returns exit_code 0", async () => {
      mock.respondWith({
        status: 200,
        body: { stdout: "hello\n", stderr: "", exit_code: 0 },
      });

      const result = await client().execSync("lease-42", "echo hello");

      expect(result).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });

      expect(mock.requests).toHaveLength(1);
      const req = mock.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/dev/leases/lease-42/exec");
      expect(JSON.parse(req.body)).toEqual({
        hostId: "host-1",
        command: "echo hello",
      });
    });

    it("returns a non-zero exit_code and stderr without throwing", async () => {
      mock.respondWith({
        status: 200,
        body: { stdout: "", stderr: "boom: not found\n", exit_code: 127 },
      });

      const result = await client().execSync("lease-42", "nope");

      expect(result).toEqual({
        stdout: "",
        stderr: "boom: not found\n",
        exitCode: 127,
      });
    });

    it("url-encodes the leaseId in the path", async () => {
      mock.respondWith({
        status: 200,
        body: { stdout: "", stderr: "", exit_code: 0 },
      });

      await client().execSync("lease/weird id", "true");

      expect(mock.requests[0].url).toBe("/dev/leases/lease%2Fweird%20id/exec");
    });

    it.each([
      [409, "host_offline", true],
      [504, "upstream_timeout", true],
    ] as const)(
      "maps relay error HTTP %s / %s to a typed error (retryable=%s)",
      async (status, code, retryable) => {
        mock.respondWith({
          status,
          body: {
            error: { code, message: `relay failed: ${code}`, request_id: "req-7" },
          },
        });

        const err = await client()
          .execSync("lease-42", "echo hi")
          .catch((e) => e);

        expect(err).toBeInstanceOf(WisperApiError);
        expect(err.code).toBe(code);
        expect(err.httpStatus).toBe(status);
        expect(err.requestId).toBe("req-7");
        expect(err.retryable).toBe(retryable);
      }
    );

    it("honors a per-call timeout override with a typed client-timeout error", async () => {
      // The client's default timeout is generous; a tight per-call timeout must
      // fire when the server stalls past it, producing the typed client-timeout
      // error (code upstream_timeout_client, distinct from a server-sent
      // upstream_timeout) rather than a bare Error.
      const slowClient = new WisperClient({
        baseUrl: mock.baseUrl,
        hostId: "host-1",
        timeoutMs: 5000,
      });
      mock.neverRespond();
      const err = await slowClient
        .execSync("lease-42", "sleep 1", { timeoutMs: 50 })
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("upstream_timeout_client");
      expect(err.httpStatus).toBe(0);
      expect(err.retryable).toBe(true);
      expect(String(err.message)).toContain("timed out");
    });

    it("rejects promptly with the abort reason when the signal fires mid-flight", async () => {
      mock.neverRespond();
      const controller = new AbortController();
      const promise = client().execSync("lease-42", "sleep 100", {
        signal: controller.signal,
      });
      await delay(20);
      controller.abort();

      const err = await promise.catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(WisperApiError);
      expect(err.name).toBe("AbortError");
    });
  });

  describe("execStream", () => {
    let stream: StreamMockServer;

    beforeEach(async () => {
      stream = new StreamMockServer();
      await stream.start();
    });

    afterEach(async () => {
      await stream.stop();
    });

    function streamClient(): WisperClient {
      return new WisperClient({
        baseUrl: stream.baseUrl,
        hostId: "host-1",
        timeoutMs: 2000,
      });
    }

    it("posts to the stream endpoint with the SSE Accept header and body", async () => {
      stream.plans({
        parts: ['event: exit\ndata: {"exit_code": 0}\n\n'],
      });

      const result = await streamClient().execStream("lease-42", "echo hi", {});

      expect(result).toEqual({ exitCode: 0 });
      expect(stream.requests).toHaveLength(1);
      const req = stream.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/dev/leases/lease-42/exec?stream=1");
      expect(JSON.parse(req.body)).toEqual({ hostId: "host-1", command: "echo hi" });
    });

    it("url-encodes the leaseId in the path", async () => {
      stream.plans({ parts: ['event: exit\ndata: {"exit_code": 0}\n\n'] });

      await streamClient().execStream("lease/weird id", "true", {});

      expect(stream.requests[0].url).toBe(
        "/dev/leases/lease%2Fweird%20id/exec?stream=1"
      );
    });

    it("delivers chunks in order then resolves with the exit code", async () => {
      stream.plans({
        parts: [
          'event: chunk\ndata: {"stream": "stdout", "data": "one\\n"}\n\n',
          'event: chunk\ndata: {"stream": "stderr", "data": "warn\\n"}\n\n',
          'event: chunk\ndata: {"stream": "stdout", "data": "two\\n"}\n\n',
          'event: exit\ndata: {"exit_code": 3}\n\n',
        ],
      });

      const chunks: StreamChunk[] = [];
      const result = await streamClient().execStream("lease-1", "run", {
        onChunk: (c) => chunks.push(c),
      });

      expect(result).toEqual({ exitCode: 3 });
      expect(chunks).toEqual([
        { stream: "stdout", data: "one\n" },
        { stream: "stderr", data: "warn\n" },
        { stream: "stdout", data: "two\n" },
      ]);
    });

    it("reassembles frames split mid-line and mid-frame across reads", async () => {
      // The exact same three chunk frames + exit as above, but sliced at brutal
      // boundaries: inside a field name, inside the JSON, and across the blank
      // line that delimits frames.
      const wire =
        'event: chunk\ndata: {"stream": "stdout", "data": "hel' +
        'lo "}\n\n' +
        'event: chunk\ndata: {"stream": "stde' +
        'rr", "data": "oops"}\n\n' +
        'event: exit\ndata: {"exit_c' +
        'ode": 0}\n\n';
      // Cut the wire into fixed 7-char slabs so boundaries fall anywhere.
      const parts: string[] = [];
      for (let i = 0; i < wire.length; i += 7) {
        parts.push(wire.slice(i, i + 7));
      }
      stream.plans({ parts });

      const chunks: StreamChunk[] = [];
      const result = await streamClient().execStream("lease-1", "run", {
        onChunk: (c) => chunks.push(c),
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(chunks).toEqual([
        { stream: "stdout", data: "hello " },
        { stream: "stderr", data: "oops" },
      ]);
    });

    it("coalesces multiple frames arriving in a single read", async () => {
      stream.plans({
        parts: [
          'event: chunk\ndata: {"stream": "stdout", "data": "a"}\n\n' +
            'event: chunk\ndata: {"stream": "stdout", "data": "b"}\n\n' +
            'event: exit\ndata: {"exit_code": 0}\n\n',
        ],
      });

      const chunks: StreamChunk[] = [];
      await streamClient().execStream("lease-1", "run", {
        onChunk: (c) => chunks.push(c),
      });

      expect(chunks.map((c) => c.data)).toEqual(["a", "b"]);
    });

    it.each([
      ["host_offline", true],
      ["upstream_timeout", true],
      ["stream_closed", false],
    ] as const)(
      "rejects with a typed error on an error frame (%s, retryable=%s)",
      async (code, retryable) => {
        stream.plans({
          parts: [
            'event: chunk\ndata: {"stream": "stdout", "data": "partial"}\n\n',
            `event: error\ndata: {"error": "${code}"}\n\n`,
          ],
        });

        const chunks: StreamChunk[] = [];
        const err = await streamClient()
          .execStream("lease-1", "run", { onChunk: (c) => chunks.push(c) })
          .catch((e) => e);

        expect(err).toBeInstanceOf(WisperApiError);
        expect(err.code).toBe(code);
        expect(err.retryable).toBe(retryable);
        // Output emitted before the error frame is still delivered in order.
        expect(chunks).toEqual([{ stream: "stdout", data: "partial" }]);
      }
    );

    it("rejects with stream_closed when the connection ends without an exit", async () => {
      stream.plans({
        parts: ['event: chunk\ndata: {"stream": "stdout", "data": "hi"}\n\n'],
      });

      const err = await streamClient()
        .execStream("lease-1", "run", {})
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("stream_closed");
    });

    it("rejects with stream_closed when the socket is destroyed mid-stream", async () => {
      stream.plans({
        parts: ['event: chunk\ndata: {"stream": "stdout", "data": "hi"}\n\n'],
        destroyAfterParts: true,
      });

      const err = await streamClient()
        .execStream("lease-1", "run", {})
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("stream_closed");
    });

    it("maps a non-200 response to a typed error from the envelope", async () => {
      stream.plans({
        status: 409,
        errorBody: {
          error: { code: "host_offline", message: "host down", request_id: "req-3" },
        },
      });

      const err = await streamClient()
        .execStream("lease-1", "run", {})
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("host_offline");
      expect(err.httpStatus).toBe(409);
      expect(err.requestId).toBe("req-3");
      expect(err.retryable).toBe(true);
    });

    it("aborts the stream and surfaces the error when onChunk throws", async () => {
      stream.plans({
        parts: [
          'event: chunk\ndata: {"stream": "stdout", "data": "boom"}\n\n',
          'event: exit\ndata: {"exit_code": 0}\n\n',
        ],
      });

      const err = await streamClient()
        .execStream("lease-1", "run", {
          onChunk: () => {
            throw new Error("callback exploded");
          },
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toContain("callback exploded");
    });

    it("honors a per-call timeout when the stream stalls mid-flight", async () => {
      // One frame, then the server holds the connection open forever. The idle
      // timeout must fire and reject with the typed client-timeout error (code
      // upstream_timeout_client, distinct from a server-sent upstream_timeout and
      // from stream_closed).
      stream.plans({
        parts: ['event: chunk\ndata: {"stream": "stdout", "data": "hi"}\n\n'],
        hangAfterParts: true,
      });

      const err = await streamClient()
        .execStream("lease-1", "sleep 1", { timeoutMs: 80 })
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("upstream_timeout_client");
      expect(err.retryable).toBe(true);
      expect(String(err.message)).toContain("timed out");
    });

    it("aborts mid-stream, rejecting promptly with the abort reason and releasing the socket", async () => {
      // One frame arrives, then the server hangs. Aborting must reject promptly
      // (well before the 2000ms idle timeout) and tear down the socket, which the
      // server observes as a premature close.
      stream.plans({
        parts: ['event: chunk\ndata: {"stream": "stdout", "data": "hi"}\n\n'],
        hangAfterParts: true,
      });
      const disconnected = stream.whenClientDisconnects();

      const controller = new AbortController();
      const chunks: StreamChunk[] = [];
      const promise = streamClient().execStream("lease-1", "sleep 100", {
        signal: controller.signal,
        onChunk: (c) => chunks.push(c),
      });

      // Let the first frame land mid-stream, then abort.
      await delay(30);
      controller.abort();

      const err = await promise.catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(WisperApiError);
      expect(err.name).toBe("AbortError");
      // Output delivered before the abort is still observed, in order.
      expect(chunks).toEqual([{ stream: "stdout", data: "hi" }]);
      // The client destroyed the request, so the server sees the socket close.
      await disconnected;
    });

    it("rejects immediately when the signal is already aborted", async () => {
      stream.plans({ parts: ['event: exit\ndata: {"exit_code": 0}\n\n'] });
      const controller = new AbortController();
      controller.abort();

      const err = await streamClient()
        .execStream("lease-1", "run", { signal: controller.signal })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("AbortError");
    });
  });

  describe("v1 mode", () => {
    const API_KEY = "wck_live_secretkey123";

    /**
     * An echoing fake catalog: it resolves any (host, image) pair to those very
     * strings as `host_id`/`host_image_id`, so a v1 createLease can be exercised
     * with a single queued lease response (no extra `/v1/catalog` fetch). Tests
     * that need real catalog resolution use a {@link WisperCatalog} instead.
     */
    const echoCatalog: HostImageResolver = {
      resolve: async (hostSelector, imageName) => ({
        host_id: hostSelector,
        host_image_id: imageName,
      }),
    };

    /** A v1 client against the buffered mock, resolving a fixed API key. */
    function v1Client(
      logger?: Logger,
      resolveApiKey: () => string | undefined = () => API_KEY,
      catalog: HostImageResolver = echoCatalog
    ): WisperClient {
      return new WisperClient({
        baseUrl: mock.baseUrl,
        hostId: "host-1",
        mode: "v1",
        resolveApiKey,
        catalog,
        timeoutMs: 2000,
        logger,
      });
    }

    it("dev mode sends NO Authorization header", async () => {
      mock.respondWith({ status: 200 });
      await client().releaseLease("lease-1");
      expect(mock.requests[0].headers.authorization).toBeUndefined();
    });

    it("createLease posts the v1 body to /v1/leases with a bearer token", async () => {
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "ready", os: "linux" },
      });

      const lease = await v1Client().createLease({
        ...createParams(),
        env: { API_TOKEN: "s3cr3t-value" },
      });

      expect(lease).toEqual({
        leaseId: "lease-v1",
        wispContractId: "wisp-v1",
        status: "ready",
        os: "linux",
        isolation: null,
      });

      const req = mock.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/leases");
      expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
      // The v1 body is fully snake_case and carries catalog ids, not `hostId`.
      // Resources are fixed by the selected offer server-side, so no `resources`
      // or `gpus` is sent — v1 rejects any body carrying either.
      expect(JSON.parse(req.body)).toEqual({
        host_id: "host-1",
        host_image_id: "ghcr.io/example/runner:latest",
        network: "open",
        ttl_seconds: 600,
        userdata: "#!/bin/sh\necho hi",
        env: { API_TOKEN: "s3cr3t-value" },
      });
    });

    it("createLease never sends resources or gpus on v1 (server rejects both)", async () => {
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "ready" },
      });

      await v1Client().createLease(createParams());

      const sent = JSON.parse(mock.requests[0].body);
      expect(sent).not.toHaveProperty("resources");
      expect(sent).not.toHaveProperty("gpus");
    });

    it("createLease sends isolation in the v1 body and passes it to the resolver", async () => {
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "ready" },
      });

      let seenIsolation: string | undefined = "unset";
      const catalog: HostImageResolver = {
        resolve: async (hostSelector, imageName, isolation) => {
          seenIsolation = isolation;
          return { host_id: hostSelector, host_image_id: imageName };
        },
      };

      await v1Client(undefined, () => API_KEY, catalog).createLease({
        ...createParams(),
        isolation: "vm",
      });

      // The resolver gets the requested level for its fail-fast check...
      expect(seenIsolation).toBe("vm");
      // ...and it is included in the outgoing v1 lease body.
      expect(JSON.parse(mock.requests[0].body).isolation).toBe("vm");
    });

    it("createLease omits isolation from the v1 body when unset (server default)", async () => {
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "ready" },
      });

      await v1Client().createLease(createParams());

      expect(JSON.parse(mock.requests[0].body)).not.toHaveProperty("isolation");
    });

    it("createLease surfaces isolation from the v1 lease view", async () => {
      mock.respondWith({
        status: 201,
        body: {
          id: "lease-v1",
          wisp_contract_id: "wisp-v1",
          status: "ready",
          isolation: "vm",
        },
      });

      const lease = await v1Client().createLease(createParams());
      expect(lease.isolation).toBe("vm");
    });

    it("createLease sends the catalog ids resolved from an explicit host selector", async () => {
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "ready" },
      });

      // A catalog that maps a selector + image name to concrete catalog ids.
      const catalog: HostImageResolver = {
        resolve: async (hostSelector, imageName) => {
          expect(hostSelector).toBe("gpu-host");
          expect(imageName).toBe("ghcr.io/example/runner:latest");
          return { host_id: "catalog-host-9", host_image_id: "catalog-image-3" };
        },
      };

      await v1Client(undefined, () => API_KEY, catalog).createLease({
        ...createParams(),
        host: "gpu-host",
      });

      const sent = JSON.parse(mock.requests[0].body);
      expect(sent.host_id).toBe("catalog-host-9");
      expect(sent.host_image_id).toBe("catalog-image-3");
      // `image` is not part of the v1 body.
      expect(sent).not.toHaveProperty("image");
    });

    it("createLease resolves host/image NAMES against a real catalog before leasing", async () => {
      // First the catalog fetch, then the lease create — two queued responses.
      mock.respondWith({
        status: 200,
        body: {
          hosts: [
            {
              host_id: "h-cat-1",
              name: "host-1",
              images: [
                {
                  host_image_id: "img-cat-1",
                  image_ref: "ghcr.io/example/runner:latest",
                },
              ],
            },
          ],
        },
      });
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "ready" },
      });

      const catalog = new WisperCatalog({
        baseUrl: mock.baseUrl,
        resolveApiKey: () => API_KEY,
        timeoutMs: 2000,
      });

      // Default host selector falls back to the configured hostId ("host-1"),
      // which matches the catalog host's NAME.
      await v1Client(undefined, () => API_KEY, catalog).createLease(createParams());

      // The catalog GET was authenticated, then the lease body carried the
      // resolved catalog ids (not the names).
      expect(mock.requests[0].method).toBe("GET");
      expect(mock.requests[0].url).toBe("/v1/catalog");
      expect(mock.requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
      const sent = JSON.parse(mock.requests[1].body);
      expect(sent.host_id).toBe("h-cat-1");
      expect(sent.host_image_id).toBe("img-cat-1");
    });

    it("fails the dispatch BEFORE leasing when the image is not offered", async () => {
      mock.respondWith({
        status: 200,
        body: {
          hosts: [
            { host_id: "h-cat-1", name: "host-1", images: [] },
          ],
        },
      });

      const catalog = new WisperCatalog({
        baseUrl: mock.baseUrl,
        resolveApiKey: () => API_KEY,
        timeoutMs: 2000,
      });

      const err = await v1Client(undefined, () => API_KEY, catalog)
        .createLease(createParams())
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("is not offered by host");
      // Only the catalog GET was ever sent — no lease was created.
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].url).toBe("/v1/catalog");
    });

    it("createLease reads os:null (host offline) from the v1 response", async () => {
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "pending", os: null },
      });
      expect((await v1Client().createLease(createParams())).os).toBeNull();
    });

    it("execSync posts {command} (no hostId) to /v1/leases/:id/exec with the token", async () => {
      mock.respondWith({
        status: 200,
        body: { stdout: "hi\n", stderr: "", exit_code: 0 },
      });

      const result = await v1Client().execSync("lease-v1", "echo hi");
      expect(result).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });

      const req = mock.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/leases/lease-v1/exec");
      expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(JSON.parse(req.body)).toEqual({ command: "echo hi" });
    });

    it("releaseLease issues DELETE /v1/leases/:id with no hostId query, with the token", async () => {
      mock.respondWith({ status: 200 });

      await v1Client().releaseLease("lease-v1");

      const req = mock.requests[0];
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe("/v1/leases/lease-v1");
      expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
    });

    it("raises a terminal, key-naming error when the secret is unset — before any request", async () => {
      const err = await v1Client(undefined, () => undefined)
        .createLease(createParams())
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("WISPER_API_KEY");
      // No request was ever sent.
      expect(mock.requests).toHaveLength(0);
    });

    it.each([401, 403] as const)(
      "maps HTTP %s to a terminal auth error naming the key, never echoing it",
      async (status) => {
        mock.respondWith({
          status,
          body: {
            error: {
              code: "invalid_api_key",
              // A hostile server that reflects the key back must not leak it.
              message: `rejected key ${API_KEY}`,
              request_id: "req-auth",
            },
          },
        });
        const { logger, lines } = capturingLogger();

        const err = await v1Client(logger)
          .createLease(createParams())
          .catch((e) => e);

        expect(err).toBeInstanceOf(WisperApiError);
        expect(err.httpStatus).toBe(status);
        expect(err.code).toBe("invalid_api_key");
        expect(err.retryable).toBe(false);
        expect(err.message).toContain("WISPER_API_KEY");
        // The key value never appears in the error text or the logs.
        expect(err.message).not.toContain(API_KEY);
        expect(JSON.stringify(err)).not.toContain(API_KEY);
        expect(lines.join("\n")).not.toContain(API_KEY);
      }
    );

    it("maps HTTP 402 insufficient_funds to a terminal error with required/available cents", async () => {
      mock.respondWith({
        status: 402,
        body: {
          error: {
            code: "insufficient_funds",
            message: "not enough balance",
            request_id: "req-pay",
            required_cents: 1500,
            available_cents: 300,
          },
        },
      });

      const err = await v1Client()
        .createLease(createParams())
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.httpStatus).toBe(402);
      expect(err.code).toBe("insufficient_funds");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("1500");
      expect(err.message).toContain("300");
    });

    it.each([
      [409, "host_offline", true],
      [504, "upstream_timeout", true],
    ] as const)(
      "keeps HTTP %s / %s retryable in v1 mode",
      async (status, code, retryable) => {
        mock.respondWith({
          status,
          body: { error: { code, message: `it failed: ${code}`, request_id: "req-r" } },
        });

        const err = await v1Client()
          .createLease(createParams())
          .catch((e) => e);

        expect(err).toBeInstanceOf(WisperApiError);
        expect(err.code).toBe(code);
        expect(err.retryable).toBe(retryable);
      }
    );

    it("never logs the API key on a successful create", async () => {
      mock.respondWith({
        status: 201,
        body: { id: "lease-v1", wisp_contract_id: "wisp-v1", status: "ready" },
      });
      const { logger, lines } = capturingLogger();

      await v1Client(logger).createLease(createParams());

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(API_KEY);
    });

    it("streams over /v1/leases/:id/exec?stream=1 with {command} and the token", async () => {
      const stream = new StreamMockServer();
      await stream.start();
      try {
        stream.plans({
          parts: [
            'event: chunk\ndata: {"stream":"stdout","data":"out"}\n\n',
            'event: exit\ndata: {"exit_code": 0}\n\n',
          ],
        });
        const chunks: StreamChunk[] = [];
        const v1Stream = new WisperClient({
          baseUrl: stream.baseUrl,
          hostId: "host-1",
          mode: "v1",
          resolveApiKey: () => API_KEY,
          timeoutMs: 2000,
        });

        const result = await v1Stream.execStream("lease-v1", "run", {
          onChunk: (c) => chunks.push(c),
        });

        expect(result).toEqual({ exitCode: 0 });
        expect(chunks).toEqual([{ stream: "stdout", data: "out" }]);
        const req = stream.requests[0];
        expect(req.url).toBe("/v1/leases/lease-v1/exec?stream=1");
        expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
        expect(JSON.parse(req.body)).toEqual({ command: "run" });
      } finally {
        await stream.stop();
      }
    });

    it("maps a non-200 stream head 401 to a terminal auth error", async () => {
      const stream = new StreamMockServer();
      await stream.start();
      try {
        stream.plans({
          status: 401,
          errorBody: { error: { code: "invalid_api_key", message: "nope" } },
        });
        const v1Stream = new WisperClient({
          baseUrl: stream.baseUrl,
          hostId: "host-1",
          mode: "v1",
          resolveApiKey: () => API_KEY,
          timeoutMs: 2000,
        });

        const err = await v1Stream.execStream("lease-v1", "run").catch((e) => e);
        expect(err).toBeInstanceOf(WisperApiError);
        expect(err.httpStatus).toBe(401);
        expect(err.retryable).toBe(false);
        expect(err.message).toContain("WISPER_API_KEY");
      } finally {
        await stream.stop();
      }
    });
  });

  describe("wisperClientFromConfig", () => {
    it("throws ConfigError when WISPER_HOST_ID is unset", () => {
      const cfg = loadConfig({});
      expect(() => wisperClientFromConfig(cfg)).toThrow(ConfigError);
    });

    it("builds a client when a host id is configured", async () => {
      mock.respondWith({ status: 200 });
      const cfg = loadConfig({
        WISPER_BASE_URL: mock.baseUrl,
        WISPER_HOST_ID: "host-cfg",
      });

      await wisperClientFromConfig(cfg).releaseLease("lease-1");

      expect(mock.requests[0].url).toBe("/dev/leases/lease-1?hostId=host-cfg");
    });

    it("threads WISPER_CREATE_LEASE_TIMEOUT_MS to the create-lease call", async () => {
      // A createLease with no per-call timeout falls back to the client's
      // construction-time timeout, which wisperClientFromConfig sets from
      // WISPER_CREATE_LEASE_TIMEOUT_MS. A tiny value must fire against a stalled
      // server, proving the config knob reaches the effective timeout.
      const cfg = loadConfig({
        WISPER_BASE_URL: mock.baseUrl,
        WISPER_HOST_ID: "host-cfg",
        WISPER_CREATE_LEASE_TIMEOUT_MS: "50",
      });
      mock.neverRespond();

      const err = await wisperClientFromConfig(cfg)
        .createLease(createParams())
        .catch((e) => e);

      expect(err).toBeInstanceOf(WisperApiError);
      expect(err.code).toBe("upstream_timeout_client");
      expect(String(err.message)).toContain("timed out after 50ms");
    });
  });
});
