import request from "supertest";

import app from "../app";
import { ModuleRegistry } from "../modules/registry";
import { resetRuntime, setRuntime } from "../runtime";

describe("capabilities router", () => {
  afterEach(() => {
    resetRuntime();
  });

  describe("GET /api/capabilities", () => {
    it("lists registered capability ids with their owning module", async () => {
      const registry = new ModuleRegistry();
      registry.register({
        id: "mod.a",
        capabilities: [
          { id: "a.one", fetch: async () => ({ label: "", content: "" }) },
          { id: "a.two", fetch: async () => ({ label: "", content: "" }) },
        ],
      });
      registry.register({
        id: "mod.b",
        capabilities: [
          { id: "b.one", fetch: async () => ({ label: "", content: "" }) },
        ],
      });
      setRuntime({ registry });

      const res = await request(app).get("/api/capabilities");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { id: "a.one", module_id: "mod.a" },
        { id: "a.two", module_id: "mod.a" },
        { id: "b.one", module_id: "mod.b" },
      ]);
    });

    it("returns an empty list when no module system is wired", async () => {
      resetRuntime();
      const res = await request(app).get("/api/capabilities");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
