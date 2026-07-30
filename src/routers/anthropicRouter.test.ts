import http from "http";
import type { AddressInfo } from "net";
import fs from "fs";
import os from "os";
import path from "path";

import request from "supertest";

import app from "../app";
import { resetRuntime, setRuntime } from "../runtime";
import { SecretStore, setSecret, setSecretStore, type Keychain } from "../secrets";
import { resetAnthropicModelsCache } from "../services/anthropicModels";

/** One request the mock upstream received, reduced to what the tests assert on. */
interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
}

/** How the mock upstream should answer the next request. */
interface MockResponse {
  status: number;
  body?: unknown;
}

/**
 * A tiny HTTP server standing in for `https://api.anthropic.com`. It records
 * every request (so a test can assert which auth header was sent) and answers
 * with a queued response, defaulting to 500 when the queue is empty.
 */
class MockServer {
  readonly requests: CapturedRequest[] = [];
  private responses: MockResponse[] = [];
  private server!: http.Server;
  baseUrl = "";

  respondWith(res: MockResponse): void {
    this.responses.push(res);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
      });
      const next = this.responses.shift() ?? { status: 500 };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(next.body === undefined ? "" : JSON.stringify(next.body));
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

/** An in-memory keychain so the store never touches the real OS keychain. */
function fakeKeychain(): Keychain {
  let stored: string | null = null;
  return {
    get: () => stored,
    set: (password) => {
      stored = password;
    },
  };
}

/** A models-list payload with releases deliberately out of chronological order. */
const MODELS_PAYLOAD = {
  data: [
    { type: "model", id: "claude-opus-4-1", display_name: "Claude Opus 4.1", created_at: "2025-08-05T00:00:00Z" },
    { type: "model", id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-06-01T00:00:00Z" },
    { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z" },
  ],
};

describe("Anthropic models router", () => {
  let mock: MockServer;
  let secretsDir: string;

  beforeEach(async () => {
    mock = new MockServer();
    await mock.start();

    secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-anthropic-secrets-"));
    setSecretStore(new SecretStore({ dir: secretsDir, keychain: fakeKeychain() }));

    resetAnthropicModelsCache();
    setRuntime({ anthropic: { baseUrl: mock.baseUrl } });
  });

  afterEach(async () => {
    await mock.stop();
    resetRuntime();
    resetAnthropicModelsCache();
    fs.rmSync(secretsDir, { recursive: true, force: true });
  });

  it("lists models via the API-key path, sorted current-first", async () => {
    setSecret("ANTHROPIC_API_KEY", "sk-secret");
    mock.respondWith({ status: 200, body: MODELS_PAYLOAD });

    const res = await request(app).get("/api/anthropic/models");

    expect(res.status).toBe(200);
    // Reduced to {id, display_name} and sorted newest release first.
    expect(res.body).toEqual({
      models: [
        { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
        { id: "claude-opus-4-1", display_name: "Claude Opus 4.1" },
      ],
    });

    // The API key was sent as x-api-key with the pinned version — never as a
    // bearer token and never echoed back to the client.
    const [captured] = mock.requests;
    expect(captured.method).toBe("GET");
    expect(captured.url).toContain("/v1/models");
    expect(captured.headers["x-api-key"]).toBe("sk-secret");
    expect(captured.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured.headers.authorization).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("sk-secret");
  });

  it("lists models via the OAuth-bearer path when only the OAuth token is set", async () => {
    setSecret("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");
    mock.respondWith({ status: 200, body: MODELS_PAYLOAD });

    const res = await request(app).get("/api/anthropic/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(3);
    expect(res.body.warning).toBeUndefined();

    // OAuth uses Authorization: Bearer plus the required beta + version headers,
    // and does NOT send x-api-key.
    const [captured] = mock.requests;
    expect(captured.headers.authorization).toBe("Bearer oauth-token");
    expect(captured.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(captured.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured.headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("oauth-token");
  });

  it("prefers the API key when both credentials are set", async () => {
    setSecret("ANTHROPIC_API_KEY", "sk-secret");
    setSecret("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");
    mock.respondWith({ status: 200, body: MODELS_PAYLOAD });

    await request(app).get("/api/anthropic/models");

    const [captured] = mock.requests;
    expect(captured.headers["x-api-key"]).toBe("sk-secret");
    expect(captured.headers.authorization).toBeUndefined();
  });

  it("degrades to an empty list with a warning on an upstream error", async () => {
    setSecret("ANTHROPIC_API_KEY", "sk-secret");
    mock.respondWith({ status: 500, body: { error: "boom" } });

    const res = await request(app).get("/api/anthropic/models");

    // Never 500 the page — a failure is a 200 with empty models + a warning.
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(typeof res.body.warning).toBe("string");
    expect(res.body.warning.length).toBeGreaterThan(0);
  });

  it("degrades to an empty list with a warning when no credential is configured", async () => {
    mock.respondWith({ status: 200, body: MODELS_PAYLOAD });

    const res = await request(app).get("/api/anthropic/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(typeof res.body.warning).toBe("string");
    // No credential means no outbound request is made at all.
    expect(mock.requests).toHaveLength(0);
  });

  it("caches a successful result in-process", async () => {
    setSecret("ANTHROPIC_API_KEY", "sk-secret");
    mock.respondWith({ status: 200, body: MODELS_PAYLOAD });

    const first = await request(app).get("/api/anthropic/models");
    const second = await request(app).get("/api/anthropic/models");

    expect(first.body).toEqual(second.body);
    // The second call is served from cache — the upstream is hit only once.
    expect(mock.requests).toHaveLength(1);
  });
});
