// Typed data-access helpers for the Rules page. These wrap the generic
// `apiFetch` in named, strongly-typed calls so the page stays declarative and
// tests can mock this module wholesale. `/api/rules` exposes CRUD plus dedicated
// enable/disable endpoints; the create/edit drawer's playbook dropdown is fed by
// the summary slice of `/api/playbooks`.

import { apiFetch } from "./api";

/**
 * A rule's match predicate. `source`/`type` are event-field matchers (`type`
 * supports a trailing `.*` prefix wildcard); `criteria` is an opaque structural
 * constraint evaluated by the backend rules engine. Every field is optional —
 * an empty match matches every event.
 */
export interface RuleMatch {
  source?: string;
  type?: string;
  criteria?: Record<string, unknown>;
}

/**
 * A single dispatch target: which playbook to run and the optional opaque
 * bindings forwarded to it.
 */
export interface RuleDispatchTarget {
  playbook_id: number;
  bindings?: Record<string, unknown>;
}

/**
 * A single notify target: which notifier to deliver through when the rule
 * matches. Notify targets are additive to (and independent of) dispatch targets.
 */
export interface RuleNotifyTarget {
  notifier_id: number;
}

/** A rule record as returned by `GET /api/rules`, newest-first by id ascending. */
export interface RuleRecord {
  id: number;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  dispatch: RuleDispatchTarget[];
  notify: RuleNotifyTarget[];
  created_at: number;
  updated_at: number;
}

/** Fields sent when creating a rule. `enabled` defaults to true server-side. */
export interface NewRule {
  name: string;
  enabled?: boolean;
  match?: RuleMatch;
  dispatch?: RuleDispatchTarget[];
  notify?: RuleNotifyTarget[];
}

/** Fields sent when updating a rule. Any omitted field is left unchanged. */
export interface RuleUpdate {
  name?: string;
  enabled?: boolean;
  match?: RuleMatch;
  dispatch?: RuleDispatchTarget[];
  notify?: RuleNotifyTarget[];
}

/** The slice of a playbook the dispatch-targets dropdown needs. */
export interface PlaybookSummary {
  id: number;
  name: string;
}

/** List all rules ordered by id ascending. */
export function listRules(): Promise<RuleRecord[]> {
  return apiFetch<RuleRecord[]>(`/rules`);
}

/** Create a rule; resolves to the stored record. */
export function createRule(rule: NewRule): Promise<RuleRecord> {
  return apiFetch<RuleRecord>(`/rules`, { method: "POST", body: rule });
}

/** Apply a partial update to a rule; resolves to the updated record. */
export function updateRule(id: number, patch: RuleUpdate): Promise<RuleRecord> {
  return apiFetch<RuleRecord>(`/rules/${id}`, { method: "PATCH", body: patch });
}

/** Delete a rule by id. Resolves once the backend returns 204. */
export function deleteRule(id: number): Promise<void> {
  return apiFetch<void>(`/rules/${id}`, { method: "DELETE" });
}

/**
 * Flip a rule's `enabled` flag via its dedicated endpoint. Resolves to the
 * updated record.
 */
export function setRuleEnabled(
  id: number,
  enabled: boolean,
): Promise<RuleRecord> {
  return apiFetch<RuleRecord>(`/rules/${id}/${enabled ? "enable" : "disable"}`, {
    method: "POST",
  });
}

/** Fetch all playbooks used to populate the dispatch-targets dropdown. */
export function listPlaybooks(): Promise<PlaybookSummary[]> {
  return apiFetch<PlaybookSummary[]>(`/playbooks`);
}
