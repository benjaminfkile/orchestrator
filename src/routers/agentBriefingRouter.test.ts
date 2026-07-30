import express from "express";
import request from "supertest";

import agentBriefingRouter from "./agentBriefingRouter";
import { AGENT_BRIEFING } from "../services/agentBriefing";

function makeApp() {
  const app = express();
  app.use("/api/agent-briefing", agentBriefingRouter);
  return app;
}

describe("GET /api/agent-briefing", () => {
  it("returns the briefing", async () => {
    const res = await request(makeApp()).get("/api/agent-briefing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ briefing: AGENT_BRIEFING });
  });

  it("briefs the operational surface an agent needs", () => {
    // Spot-check the load-bearing sections so an accidental truncation or a
    // careless edit that drops a section fails loudly.
    for (const marker of [
      "http://127.0.0.1:3007/api",
      "/api/rules",
      "/api/playbooks",
      "/api/dispatches",
      "/api/notifiers",
      "/api/secrets",
      "/api/snippets",
      "/api/modules/datadog/config",
      "NOTES_TO_SAVE",
      "run.completed",
      "{{payload.",
      "{{snippet.",
    ]) {
      expect(AGENT_BRIEFING).toContain(marker);
    }
  });
});
