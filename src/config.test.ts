import path from "path";

import { ConfigError, loadConfig, userDataDir } from "./config";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(3007);
    expect(cfg.wisperBaseUrl).toBe("http://localhost:8080");
    expect(cfg.dbPath).toBeUndefined();
    expect(cfg.wisperHostId).toBeUndefined();
    expect(cfg.wisperCreateLeaseTimeoutMs).toBe(150000);
    expect(cfg.wisperExecTimeoutMs).toBeUndefined();
    expect(cfg.wisperMode).toBe("dev");
    expect(cfg.isWisperConfigured()).toBe(false);
  });

  it("reads valid overrides", () => {
    const cfg = loadConfig({
      PORT: "4000",
      ORCH_DB_PATH: "/tmp/orch.sqlite",
      WISPER_BASE_URL: "https://wisper.example:9000",
      WISPER_HOST_ID: "host-1",
      WISPER_CREATE_LEASE_TIMEOUT_MS: "300000",
      WISPER_EXEC_TIMEOUT_MS: "90000",
    });
    expect(cfg.port).toBe(4000);
    expect(cfg.dbPath).toBe("/tmp/orch.sqlite");
    expect(cfg.wisperBaseUrl).toBe("https://wisper.example:9000");
    expect(cfg.wisperHostId).toBe("host-1");
    expect(cfg.wisperCreateLeaseTimeoutMs).toBe(300000);
    expect(cfg.wisperExecTimeoutMs).toBe(90000);
    expect(cfg.isWisperConfigured()).toBe(true);
  });

  it("treats blank/whitespace values as unset", () => {
    const cfg = loadConfig({
      PORT: "  ",
      ORCH_DB_PATH: "   ",
      WISPER_BASE_URL: "",
      WISPER_HOST_ID: "  ",
      WISPER_CREATE_LEASE_TIMEOUT_MS: "   ",
      WISPER_EXEC_TIMEOUT_MS: "",
    });
    expect(cfg.port).toBe(3007);
    expect(cfg.dbPath).toBeUndefined();
    expect(cfg.wisperBaseUrl).toBe("http://localhost:8080");
    expect(cfg.wisperCreateLeaseTimeoutMs).toBe(150000);
    expect(cfg.wisperExecTimeoutMs).toBeUndefined();
    expect(cfg.isWisperConfigured()).toBe(false);
  });

  describe("WISPER_MODE", () => {
    it("defaults to dev when unset or blank", () => {
      expect(loadConfig({}).wisperMode).toBe("dev");
      expect(loadConfig({ WISPER_MODE: "  " }).wisperMode).toBe("dev");
    });

    it("reads v1", () => {
      expect(loadConfig({ WISPER_MODE: "v1" }).wisperMode).toBe("v1");
    });

    it("fails fast on an unknown mode", () => {
      expect(() => loadConfig({ WISPER_MODE: "prod" })).toThrow(ConfigError);
      expect(() => loadConfig({ WISPER_MODE: "prod" })).toThrow(/Invalid WISPER_MODE/);
    });
  });

  describe("wisper timeout knobs fall back on invalid values", () => {
    it("falls back to the default for a non-numeric value", () => {
      const cfg = loadConfig({
        WISPER_CREATE_LEASE_TIMEOUT_MS: "60s",
        WISPER_EXEC_TIMEOUT_MS: "abc",
      });
      expect(cfg.wisperCreateLeaseTimeoutMs).toBe(150000);
      // WISPER_EXEC_TIMEOUT_MS is now an OPTIONAL override; a malformed value
      // becomes undefined so the executor's remaining-TTL default applies.
      expect(cfg.wisperExecTimeoutMs).toBeUndefined();
    });

    it("falls back to the default for a non-positive value", () => {
      const cfg = loadConfig({
        WISPER_CREATE_LEASE_TIMEOUT_MS: "0",
        WISPER_EXEC_TIMEOUT_MS: "-5",
      });
      expect(cfg.wisperCreateLeaseTimeoutMs).toBe(150000);
      expect(cfg.wisperExecTimeoutMs).toBeUndefined();
    });
  });

  it("does not crash when WISPER_HOST_ID is unset (required only at use)", () => {
    const cfg = loadConfig({ WISPER_BASE_URL: "http://localhost:8080" });
    expect(cfg.isWisperConfigured()).toBe(false);
  });

  describe("fails fast on malformed values", () => {
    it("rejects a non-numeric PORT", () => {
      expect(() => loadConfig({ PORT: "80abc" })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: "80abc" })).toThrow(/Invalid PORT/);
    });

    it("rejects an out-of-range PORT", () => {
      expect(() => loadConfig({ PORT: "0" })).toThrow(/between 1 and 65535/);
      expect(() => loadConfig({ PORT: "70000" })).toThrow(/between 1 and 65535/);
    });

    it("rejects a non-URL WISPER_BASE_URL", () => {
      expect(() => loadConfig({ WISPER_BASE_URL: "not a url" })).toThrow(
        ConfigError
      );
      expect(() => loadConfig({ WISPER_BASE_URL: "not a url" })).toThrow(
        /Invalid WISPER_BASE_URL/
      );
    });

    it("rejects a non-http(s) WISPER_BASE_URL", () => {
      expect(() => loadConfig({ WISPER_BASE_URL: "ftp://host/x" })).toThrow(
        /Invalid WISPER_BASE_URL/
      );
    });
  });

  describe("plaintext http to non-loopback hosts", () => {
    it("refuses http:// to a non-loopback host by default", () => {
      expect(() =>
        loadConfig({ WISPER_BASE_URL: "http://10.0.0.5:8080" })
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({ WISPER_BASE_URL: "http://10.0.0.5:8080" })
      ).toThrow(/Refusing WISPER_BASE_URL/);
      expect(() =>
        loadConfig({ WISPER_BASE_URL: "http://wisper.example:8080" })
      ).toThrow(/https:\/\//);
    });

    it("still allows http:// to loopback hosts", () => {
      expect(
        loadConfig({ WISPER_BASE_URL: "http://localhost:8080" }).wisperBaseUrl
      ).toBe("http://localhost:8080");
      expect(
        loadConfig({ WISPER_BASE_URL: "http://127.0.0.1:8080" }).wisperBaseUrl
      ).toBe("http://127.0.0.1:8080");
      expect(
        loadConfig({ WISPER_BASE_URL: "http://[::1]:8080" }).wisperBaseUrl
      ).toBe("http://[::1]:8080");
    });

    it("downgrades the refusal to a warning when WISPER_ALLOW_INSECURE_HTTP is set", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const flag of ["1", "true"]) {
          warn.mockClear();
          expect(
            loadConfig({
              WISPER_BASE_URL: "http://10.0.0.5:8080",
              WISPER_ALLOW_INSECURE_HTTP: flag,
            }).wisperBaseUrl
          ).toBe("http://10.0.0.5:8080");
          expect(warn).toHaveBeenCalled();
        }
      } finally {
        warn.mockRestore();
      }
    });

    it("leaves https:// to non-loopback hosts unchanged", () => {
      expect(
        loadConfig({ WISPER_BASE_URL: "https://wisper.example:9000" })
          .wisperBaseUrl
      ).toBe("https://wisper.example:9000");
    });
  });
});

describe("userDataDir", () => {
  const original = process.env.ORCH_DATA_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.ORCH_DATA_DIR;
    else process.env.ORCH_DATA_DIR = original;
  });

  it("returns ORCH_DATA_DIR verbatim when set (no orchestrator suffix)", () => {
    process.env.ORCH_DATA_DIR = path.join("/tmp", "orch-state");
    expect(userDataDir()).toBe(path.join("/tmp", "orch-state"));
  });

  it("treats a blank ORCH_DATA_DIR as unset", () => {
    process.env.ORCH_DATA_DIR = "   ";
    expect(userDataDir().endsWith(path.sep + "orchestrator")).toBe(true);
  });

  it("falls back to an OS user-data path with an orchestrator subdir when unset", () => {
    delete process.env.ORCH_DATA_DIR;
    const resolved = userDataDir();
    expect(resolved.endsWith(path.sep + "orchestrator")).toBe(true);
  });
});
