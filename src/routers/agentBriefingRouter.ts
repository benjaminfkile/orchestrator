import express from "express";

import { AGENT_BRIEFING } from "../services/agentBriefing";

/**
 * `/api/agent-briefing` — the agent briefing.
 *
 *   GET /   ->  { briefing: string }
 *
 * The same text the "Agent Briefing" page renders: a paste-into-any-AI-agent
 * briefing describing how to operate this app over its loopback API. The
 * content lives in src/services/agentBriefing.ts and MUST be kept in sync with
 * the operational surface (see the maintenance note there and in the README).
 */
const agentBriefingRouter = express.Router();

agentBriefingRouter.get("/", (_req, res) => {
  res.status(200).json({ briefing: AGENT_BRIEFING });
});

export default agentBriefingRouter;
