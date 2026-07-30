import http from "http";
import type { AddressInfo } from "net";

import { WisperApiError } from "./client";
import {
  DEFAULT_CATALOG_CACHE_TTL_MS,
  WisperCatalog,
  parseCatalog,
  type CatalogHost,
} from "./catalog";

/** A representative catalog: two hosts, each offering a couple of images. */
const CATALOG: CatalogHost[] = [
  {
    host_id: "h-1",
    name: "west",
    images: [
      { host_image_id: "img-a", image_ref: "ghcr.io/example/runner:latest" },
      { host_image_id: "img-b", image_ref: "ghcr.io/example/runner:windows" },
    ],
    // The strong host offers every isolation level.
    isolation_levels: ["shared", "sandboxed", "vm"],
    default_isolation: "shared",
  },
  {
    host_id: "h-2",
    name: "east",
    images: [{ host_image_id: "img-c", image_ref: "ghcr.io/example/other:1" }],
    // A weaker host: shared only.
    isolation_levels: ["shared"],
    default_isolation: "shared",
  },
];

describe("WisperCatalog.resolve", () => {
  it("resolves a host by id and an image by ref (happy path)", async () => {
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      fetchCatalog: async () => CATALOG,
    });
    expect(
      await catalog.resolve("h-1", "ghcr.io/example/runner:latest")
    ).toEqual({ host_id: "h-1", host_image_id: "img-a" });
  });

  it("matches a host selector against the host NAME too", async () => {
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      fetchCatalog: async () => CATALOG,
    });
    expect(
      await catalog.resolve("east", "ghcr.io/example/other:1")
    ).toEqual({ host_id: "h-2", host_image_id: "img-c" });
  });

  it("fails with a message naming the selector when the host is unknown/offline", async () => {
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      fetchCatalog: async () => CATALOG,
    });
    const err = await catalog
      .resolve("nope", "ghcr.io/example/runner:latest")
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WisperApiError); // terminal, plain pre-lease error
    expect(err.message).toContain('"nope"');
    expect(err.message).toMatch(/unknown or offline/);
  });

  it("fails naming BOTH sides when the image is not offered by the host", async () => {
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      fetchCatalog: async () => CATALOG,
    });
    const err = await catalog.resolve("west", "ghcr.io/example/other:1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('image "ghcr.io/example/other:1"');
    expect(err.message).toContain('host "west"');
  });

  it("resolves when the host advertises the requested isolation level", async () => {
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      fetchCatalog: async () => CATALOG,
    });
    expect(
      await catalog.resolve("h-1", "ghcr.io/example/runner:latest", "vm")
    ).toEqual({ host_id: "h-1", host_image_id: "img-a" });
  });

  it("fails fast when the host cannot provide the requested isolation, naming both", async () => {
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      fetchCatalog: async () => CATALOG,
    });
    const err = await catalog
      .resolve("east", "ghcr.io/example/other:1", "vm")
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WisperApiError); // terminal, plain pre-lease error
    expect(err.message).toContain('host "east"');
    expect(err.message).toContain('"vm"');
    expect(err.message).toContain("shared"); // lists what the host does offer
  });

  it("defers the isolation check to the server when the host advertises no levels", async () => {
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      // A host with no advertised isolation_levels (older server): no fail-fast.
      fetchCatalog: async () => [
        {
          host_id: "h-x",
          name: "legacy",
          images: [{ host_image_id: "img-x", image_ref: "repo/img:tag" }],
          isolation_levels: [],
          default_isolation: null,
        },
      ],
    });
    expect(await catalog.resolve("legacy", "repo/img:tag", "vm")).toEqual({
      host_id: "h-x",
      host_image_id: "img-x",
    });
  });
});

describe("WisperCatalog caching", () => {
  it("serves a single fetch for repeated resolves within the TTL", async () => {
    let fetches = 0;
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      now: () => 1000,
      fetchCatalog: async () => {
        fetches += 1;
        return CATALOG;
      },
    });
    await catalog.resolve("h-1", "ghcr.io/example/runner:latest");
    await catalog.resolve("h-2", "ghcr.io/example/other:1");
    expect(fetches).toBe(1);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    let fetches = 0;
    let clock = 1000;
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      now: () => clock,
      fetchCatalog: async () => {
        fetches += 1;
        return CATALOG;
      },
    });
    await catalog.resolve("h-1", "ghcr.io/example/runner:latest");
    // Just inside the TTL: still cached.
    clock = 1000 + DEFAULT_CATALOG_CACHE_TTL_MS - 1;
    await catalog.resolve("h-1", "ghcr.io/example/runner:latest");
    expect(fetches).toBe(1);
    // Past the TTL: a fresh fetch.
    clock = 1000 + DEFAULT_CATALOG_CACHE_TTL_MS + 1;
    await catalog.resolve("h-1", "ghcr.io/example/runner:latest");
    expect(fetches).toBe(2);
  });

  it("does NOT cache a failed fetch — the next resolve retries", async () => {
    let attempt = 0;
    const catalog = new WisperCatalog({
      baseUrl: "http://unused",
      now: () => 1000,
      fetchCatalog: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("catalog boom");
        return CATALOG;
      },
    });
    await expect(
      catalog.resolve("h-1", "ghcr.io/example/runner:latest")
    ).rejects.toThrow("catalog boom");
    // The failure was not cached, so the retry fetches again and succeeds.
    expect(
      await catalog.resolve("h-1", "ghcr.io/example/runner:latest")
    ).toEqual({ host_id: "h-1", host_image_id: "img-a" });
    expect(attempt).toBe(2);
  });
});

describe("parseCatalog", () => {
  it("tolerates field-name variation (id / name / ref) and skips malformed entries", () => {
    const hosts = parseCatalog(
      JSON.stringify({
        hosts: [
          {
            id: "h-9",
            name: "alt",
            images: [
              { id: "im-9", ref: "repo/img:tag" },
              { host_image_id: "im-10", name: "repo/named:tag" },
              { image_ref: "no-id-so-skipped" },
              "not-an-object",
            ],
          },
          { name: "no-id-host-skipped" },
        ],
      })
    );
    expect(hosts).toEqual([
      {
        host_id: "h-9",
        name: "alt",
        images: [
          { host_image_id: "im-9", image_ref: "repo/img:tag" },
          { host_image_id: "im-10", image_ref: "repo/named:tag" },
        ],
        // Absent in the source, so normalized to an empty list / null.
        isolation_levels: [],
        default_isolation: null,
      },
    ]);
  });

  it("accepts a bare top-level array of hosts", () => {
    const hosts = parseCatalog(
      JSON.stringify([{ host_id: "h-1", name: "west", images: [] }])
    );
    expect(hosts).toEqual([
      {
        host_id: "h-1",
        name: "west",
        images: [],
        isolation_levels: [],
        default_isolation: null,
      },
    ]);
  });

  it("parses isolation_levels and default_isolation, dropping non-string levels", () => {
    const hosts = parseCatalog(
      JSON.stringify([
        {
          host_id: "h-1",
          name: "west",
          images: [],
          isolation_levels: ["shared", "vm", 7, null],
          default_isolation: "shared",
        },
      ])
    );
    expect(hosts[0].isolation_levels).toEqual(["shared", "vm"]);
    expect(hosts[0].default_isolation).toBe("shared");
  });

  it("throws a terminal WisperApiError on non-JSON", () => {
    const err = (() => {
      try {
        parseCatalog("<html>nope</html>");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WisperApiError);
    expect((err as WisperApiError).retryable).toBe(false);
  });
});

/** A tiny http server that answers one queued response, capturing the request. */
class CatalogMock {
  private server!: http.Server;
  private status = 200;
  private body: unknown = { hosts: [] };
  lastAuth?: string | string[];
  lastUrl?: string;
  baseUrl = "";

  respondWith(status: number, body: unknown): void {
    this.status = status;
    this.body = body;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.lastAuth = req.headers.authorization;
      this.lastUrl = req.url;
      res.writeHead(this.status, { "content-type": "application/json" });
      res.end(typeof this.body === "string" ? this.body : JSON.stringify(this.body));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

describe("WisperCatalog HTTP fetch", () => {
  let mock: CatalogMock;
  beforeEach(async () => {
    mock = new CatalogMock();
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  it("GETs /v1/catalog with a bearer token and resolves", async () => {
    mock.respondWith(200, {
      hosts: [
        {
          host_id: "h-1",
          name: "west",
          images: [{ host_image_id: "img-a", image_ref: "repo/img:tag" }],
        },
      ],
    });
    const catalog = new WisperCatalog({
      baseUrl: mock.baseUrl,
      resolveApiKey: () => "wck_live_key",
      timeoutMs: 2000,
    });

    expect(await catalog.resolve("west", "repo/img:tag")).toEqual({
      host_id: "h-1",
      host_image_id: "img-a",
    });
    expect(mock.lastUrl).toBe("/v1/catalog");
    expect(mock.lastAuth).toBe("Bearer wck_live_key");
  });

  it("maps a 401 to a terminal, key-naming auth error", async () => {
    mock.respondWith(401, { error: { code: "invalid_api_key", message: "no" } });
    const catalog = new WisperCatalog({
      baseUrl: mock.baseUrl,
      resolveApiKey: () => "wck_live_key",
      timeoutMs: 2000,
    });

    const err = await catalog.resolve("west", "repo/img:tag").catch((e) => e);
    expect(err).toBeInstanceOf(WisperApiError);
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("WISPER_API_KEY");
  });

  it("raises the key-naming error before any request when the key is unset", async () => {
    const catalog = new WisperCatalog({
      baseUrl: mock.baseUrl,
      resolveApiKey: () => undefined,
      timeoutMs: 2000,
    });

    const err = await catalog.resolve("west", "repo/img:tag").catch((e) => e);
    expect(err).toBeInstanceOf(WisperApiError);
    expect(err.code).toBe("missing_api_key");
    expect(mock.lastUrl).toBeUndefined();
  });
});
