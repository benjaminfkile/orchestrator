import express from "express";
import request from "supertest";

import agentBriefingRouter from "./agentBriefingRouter";
import { getConfig } from "../config";
import { agentBriefing } from "../services/agentBriefing";

function makeApp() {
  const app = express();
  app.use("/api/agent-briefing", agentBriefingRouter);
  return app;
}

describe("GET /api/agent-briefing", () => {
  it("returns the briefing rendered with the booted port", async () => {
    const res = await request(makeApp()).get("/api/agent-briefing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ briefing: agentBriefing(getConfig().port) });
  });

  it("stamps the given port into the base URL", () => {
    expect(agentBriefing(3007)).toContain("http://127.0.0.1:3007/api");
    expect(agentBriefing(4400)).toContain("http://127.0.0.1:4400/api");
  });

  it("briefs the operational surface an agent needs", () => {
    // Spot-check the load-bearing sections so an accidental truncation or a
    // careless edit that drops a section fails loudly.
    const briefing = agentBriefing(3007);
    for (const marker of [
      "http://127.0.0.1:3007/api",
      "/api/rules",
      "/api/playbooks",
      "/api/dispatches",
      "/api/notifiers",
      "/api/secrets",
      "/api/snippets",
      "/api/modules/datadog/config",
      "/api/events/facets",
      "/api/config/export",
      "NOTES_TO_SAVE",
      "run.started",
      "run.completed",
      "run_budget_per_hour",
      "{{payload.",
      "{{snippet.",
      "ado.workitem.manual",
    ]) {
      expect(briefing).toContain(marker);
    }
  });
});
