import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { getSetting, setSetting } from "../db/settings";
import { resetRuntime, setRuntime } from "../runtime";

import { KNOWN_SETTING_KEYS } from "./settingsRouter";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-settings-router-"));
  return path.join(dir, "test.sqlite");
}

describe("settings router", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("GET /api/settings", () => {
    it("returns every stored setting as a map", async () => {
      await setSetting("dispatch_max_attempts", "5", db);
      await setSetting("identity_me", "me@example.com", db);
      const res = await request(app).get("/api/settings");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        dispatch_max_attempts: "5",
        identity_me: "me@example.com",
      });
    });

    it("is an empty object when nothing is stored", async () => {
      const res = await request(app).get("/api/settings");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });
  });

  describe("PUT /api/settings", () => {
    it("upserts a known setting key", async () => {
      const key = KNOWN_SETTING_KEYS[0];
      const res = await request(app)
        .put("/api/settings")
        .send({ key, value: "7" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key, value: "7" });
      expect(await getSetting(key, undefined, db)).toBe("7");
    });

    it("accepts an empty-string value", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send({ key: "identity_me", value: "" });
      expect(res.status).toBe(200);
      expect(await getSetting("identity_me", undefined, db)).toBe("");
    });

    it("400s on an unknown setting key", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send({ key: "not_a_real_setting", value: "x" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s when value is not a string", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send({ key: "dispatch_max_attempts", value: 5 });
      expect(res.status).toBe(400);
    });

    it("400s when key is missing", async () => {
      const res = await request(app).put("/api/settings").send({ value: "x" });
      expect(res.status).toBe(400);
    });

    it("accepts the default_lease_image key", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send({ key: "default_lease_image", value: "ghcr.io/example/img:1" });
      expect(res.status).toBe(200);
      expect(await getSetting("default_lease_image", undefined, db)).toBe(
        "ghcr.io/example/img:1"
      );
    });

    it("whitelists dispatch_max_chain_depth and round-trips it", async () => {
      expect(KNOWN_SETTING_KEYS).toContain("dispatch_max_chain_depth");
      await request(app)
        .put("/api/settings")
        .send({ key: "dispatch_max_chain_depth", value: "5" })
        .expect(200);
      expect(await getSetting("dispatch_max_chain_depth", undefined, db)).toBe(
        "5"
      );
    });

    it("whitelists the run-budget gate keys and round-trips them", async () => {
      const budgetKeys = [
        "run_budget_per_hour",
        "run_budget_window_minutes",
        "token_budget_per_window",
      ];
      // All three are known keys so the whitelist accepts them...
      for (const key of budgetKeys) {
        expect(KNOWN_SETTING_KEYS).toContain(key);
      }
      // ...and each round-trips through PUT then GET.
      await request(app)
        .put("/api/settings")
        .send({ key: "run_budget_per_hour", value: "10" })
        .expect(200);
      await request(app)
        .put("/api/settings")
        .send({ key: "run_budget_window_minutes", value: "300" })
        .expect(200);
      await request(app)
        .put("/api/settings")
        .send({ key: "token_budget_per_window", value: "500000" })
        .expect(200);

      const res = await request(app).get("/api/settings");
      expect(res.body).toMatchObject({
        run_budget_per_hour: "10",
        run_budget_window_minutes: "300",
        token_budget_per_window: "500000",
      });
    });

    it("whitelists run_retention_max and round-trips it", async () => {
      expect(KNOWN_SETTING_KEYS).toContain("run_retention_max");
      await request(app)
        .put("/api/settings")
        .send({ key: "run_retention_max", value: "500" })
        .expect(200);
      expect(await getSetting("run_retention_max", undefined, db)).toBe("500");
    });
  });

  describe("GET /api/settings/system", () => {
    afterEach(() => {
      resetRuntime();
    });

    it("returns the wisper base URL, hostId, mode, and key presence from config", async () => {
      // Inject a resolver that finds no key so the assertion below never depends
      // on whether the developer's real secret store holds a wisper API key.
      setRuntime({ wisperHosts: { resolveApiKey: () => undefined } });
      const res = await request(app).get("/api/settings/system");
      expect(res.status).toBe(200);
      expect(typeof res.body.wisperBaseUrl).toBe("string");
      expect(res.body).toHaveProperty("wisperHostId");
      // Mode defaults to "dev" and key presence is a boolean, never a value.
      expect(res.body.wisperMode).toBe("dev");
      expect(typeof res.body.wisperApiKeyPresent).toBe("boolean");
      expect(res.body.wisperApiKeyPresent).toBe(false);
    });

    it("reports the API key as present (boolean only) when the secret resolves", async () => {
      // Inject the key-resolution seam so the endpoint reports presence without
      // touching a real secret store — and assert the value never leaks.
      setRuntime({ wisperHosts: { resolveApiKey: () => "wck_live_secret" } });
      const res = await request(app).get("/api/settings/system");
      expect(res.status).toBe(200);
      expect(res.body.wisperApiKeyPresent).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain("wck_live_secret");
    });
  });
});
