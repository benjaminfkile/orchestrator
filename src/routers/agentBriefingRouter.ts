import express from "express";

import { getConfig } from "../config";
import { agentBriefing } from "../services/agentBriefing";

/**
 * `/api/agent-briefing` — the agent briefing.
 *
 *   GET /   ->  { briefing: string }
 *
 * The same text the "Agent Briefing" page renders: a paste-into-any-AI-agent
 * briefing describing how to operate this app over its loopback API. The
 * content lives in src/services/agentBriefing.ts and MUST be kept in sync with
 * the operational surface (see the maintenance note there and in the README).
 * Rendered with the port this server actually booted on, so the base URL the
 * pasted-in agent sees is always the one that reaches this instance.
 */
const agentBriefingRouter = express.Router();

agentBriefingRouter.get("/", (_req, res) => {
  res.status(200).json({ briefing: agentBriefing(getConfig().port) });
});

export default agentBriefingRouter;
