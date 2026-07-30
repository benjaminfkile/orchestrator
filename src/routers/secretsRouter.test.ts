import fs from "fs";
import os from "os";
import path from "path";

import request from "supertest";

import app from "../app";
import { SecretStore, setSecretStore, type Keychain } from "../secrets";

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

describe("secrets router", () => {
  beforeEach(() => {
    // A fresh store per test: temp-dir file + in-memory keychain, so nothing
    // leaks to the real user-data dir or OS keychain.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-secrets-router-"));
    setSecretStore(new SecretStore({ dir, keychain: fakeKeychain() }));
  });

  describe("GET /api/secrets", () => {
    it("returns names only, never values", async () => {
      await request(app)
        .put("/api/secrets")
        .send({ key: "ADO_PAT", value: "super-secret" });
      const res = await request(app).get("/api/secrets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ keys: ["ADO_PAT"] });
      // The secret value appears nowhere in the response body.
      expect(JSON.stringify(res.body)).not.toContain("super-secret");
    });

    it("starts empty", async () => {
      const res = await request(app).get("/api/secrets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ keys: [] });
    });
  });

  describe("PUT /api/secrets", () => {
    it("stores a secret and echoes the name only (write-only)", async () => {
      const res = await request(app)
        .put("/api/secrets")
        .send({ key: "TOKEN", value: "the-value" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: "TOKEN" });
      expect(res.body).not.toHaveProperty("value");
      expect(JSON.stringify(res.body)).not.toContain("the-value");
    });

    it("upserts an existing secret", async () => {
      await request(app).put("/api/secrets").send({ key: "K", value: "v1" });
      await request(app).put("/api/secrets").send({ key: "K", value: "v2" });
      const res = await request(app).get("/api/secrets");
      expect(res.body.keys).toEqual(["K"]);
    });

    it("400s when key or value is missing", async () => {
      expect((await request(app).put("/api/secrets").send({ key: "K" })).status).toBe(
        400
      );
      expect(
        (await request(app).put("/api/secrets").send({ value: "v" })).status
      ).toBe(400);
    });
  });

  describe("DELETE /api/secrets/:key", () => {
    it("removes a secret", async () => {
      await request(app).put("/api/secrets").send({ key: "K", value: "v" });
      const del = await request(app).delete("/api/secrets/K");
      expect(del.status).toBe(204);
      const res = await request(app).get("/api/secrets");
      expect(res.body.keys).toEqual([]);
    });

    it("is idempotent for an absent key", async () => {
      const del = await request(app).delete("/api/secrets/nope");
      expect(del.status).toBe(204);
    });
  });
});
