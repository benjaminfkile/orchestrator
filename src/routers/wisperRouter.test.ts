import http from "http";
import type { AddressInfo } from "net";
import fs from "fs";
import os from "os";
import path from "path";

import request from "supertest";

import app from "../app";
import { resetRuntime, setRuntime } from "../runtime";
import { SecretStore, setSecret, setSecretStore, type Keychain } from "../secrets";

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
 * A tiny HTTP server standing in for the wisper-api. It records every request
 * (so a test can assert the bearer token was sent server-side) and answers with
 * a queued response, defaulting to 500 when the queue is empty.
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
      this.requests.push({ method: req.method, url: req.url, headers: req.headers });
      const next = this.responses.shift() ?? { status: 500 };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(next.body === undefined ? "" : JSON.stringify(next.body));
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

/** A catalog payload with two hosts (one offline) and priced images. */
const CATALOG_PAYLOAD = {
  hosts: [
    {
      host_id: "h-linux",
      name: "Linux box",
      os: "linux",
      online: true,
      images: [
        { host_image_id: "i-1", image_ref: "ghcr.io/acme/runner:latest", price_cents_per_min: 3 },
      ],
    },
    {
      host_id: "h-win",
      name: "Windows box",
      os: "windows",
      online: false,
      images: [{ id: "i-2", name: "mcr.io/win:1", price_cents_per_min: 7 }],
    },
  ],
};

describe("wisper hosts router", () => {
  let mock: MockServer;
  let secretsDir: string;

  beforeEach(async () => {
    mock = new MockServer();
    await mock.start();

    secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wisper-secrets-"));
    setSecretStore(new SecretStore({ dir: secretsDir, keychain: fakeKeychain() }));
  });

  afterEach(async () => {
    await mock.stop();
    resetRuntime();
    fs.rmSync(secretsDir, { recursive: true, force: true });
  });

  it("proxies the v1 catalog server-side; the API key never reaches the client", async () => {
    setSecret("WISPER_API_KEY", "wck_live_secret");
    setRuntime({ wisperHosts: { mode: "v1", baseUrl: mock.baseUrl } });
    mock.respondWith({ status: 200, body: CATALOG_PAYLOAD });

    const res = await request(app).get("/api/wisper/hosts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hosts: [
        {
          id: "h-linux",
          name: "Linux box",
          os: "linux",
          online: true,
          images: [
            { id: "i-1", name: "ghcr.io/acme/runner:latest", price_cents_per_min: 3 },
          ],
        },
        {
          id: "h-win",
          name: "Windows box",
          os: "windows",
          online: false,
          images: [{ id: "i-2", name: "mcr.io/win:1", price_cents_per_min: 7 }],
        },
      ],
    });

    // The bearer token was sent to the upstream server-side...
    const [captured] = mock.requests;
    expect(captured.method).toBe("GET");
    expect(captured.url).toContain("/v1/catalog");
    expect(captured.headers.authorization).toBe("Bearer wck_live_secret");
    // ...and the key value is never echoed back to the browser.
    expect(JSON.stringify(res.body)).not.toContain("wck_live_secret");
  });

  it("returns a single synthetic host for WISPER_HOST_ID in dev mode (no fetch)", async () => {
    setRuntime({ wisperHosts: { mode: "dev", hostId: "host-abc", baseUrl: mock.baseUrl } });

    const res = await request(app).get("/api/wisper/hosts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hosts: [{ id: "host-abc", name: "host-abc", os: null, online: true, images: [] }],
    });
    // Dev mode has no catalog — no outbound request is made.
    expect(mock.requests).toHaveLength(0);
  });

  it("degrades to an empty list with a warning when no API key is configured", async () => {
    setRuntime({ wisperHosts: { mode: "v1", baseUrl: mock.baseUrl } });

    const res = await request(app).get("/api/wisper/hosts");

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual([]);
    expect(typeof res.body.warning).toBe("string");
    expect(res.body.warning.length).toBeGreaterThan(0);
    // A missing key fails before any request is sent.
    expect(mock.requests).toHaveLength(0);
  });

  it("degrades to an empty list with a warning on an upstream error", async () => {
    setSecret("WISPER_API_KEY", "wck_live_secret");
    setRuntime({ wisperHosts: { mode: "v1", baseUrl: mock.baseUrl } });
    mock.respondWith({ status: 500, body: { error: { message: "boom" } } });

    const res = await request(app).get("/api/wisper/hosts");

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual([]);
    expect(typeof res.body.warning).toBe("string");
    expect(res.body.warning.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain("wck_live_secret");
  });
});
