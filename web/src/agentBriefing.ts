// Typed data-access helper for the Agent Briefing page: fetches the briefing a
// user pastes into any AI coding agent running on this machine so the agent can
// drive this app's loopback API. Served by `GET /api/agent-briefing`.

import { apiFetch } from "./api";

/** Fetch the agent briefing text. */
export async function getAgentBriefing(): Promise<string> {
  const res = await apiFetch<{ briefing: string }>(`/agent-briefing`);
  return res.briefing;
}
