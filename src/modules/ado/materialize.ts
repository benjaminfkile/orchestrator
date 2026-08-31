/**
 * On-demand single-item materialize: turn ONE fetched Azure DevOps entity (a
 * work item or a pull request) into a generic event, shaped EXACTLY like a poll
 * tick's, so a playbook can be dispatched against it manually.
 *
 * This is the one place the manual event `type` strings live. Each helper reuses
 * the poller's payload builder ({@link buildWorkItemPayload}, {@link
 * buildPullRequestPayload}) so a materialized event is byte-for-byte the same
 * shape a first-seen poll would emit; only the `type` and the absence of a
 * `dedupe_key` differ. Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md), the
 * intent word appears only in these event-type strings; no code branches on
 * them. READ-ONLY: the caller fetches the item with a read; nothing here writes
 * to ADO.
 */

import type { NewEvent } from "../../interfaces";
import type { ADOPullRequest, ADOWorkItem } from "./client";
import { ADO_EVENT_SOURCE, ADO_SUBJECT_KIND } from "./poller";
import {
  ADO_PR_SUBJECT_KIND,
  buildPullRequestPayload,
} from "./pr";
import { buildWorkItemPayload, toWorkItemView } from "./workItemPayload";

/**
 * Event `type` for a manually-materialized work item. Distinct from the poller's
 * diff-driven types so rules can target manual runs specifically; the poller
 * never emits it.
 */
export const ADO_EVENT_MANUAL = "ado.workitem.manual";

/**
 * Event `type` for a manually-materialized pull request. Distinct from the
 * pull-request poller's diff-driven types so rules can target manual runs
 * specifically; the poller never emits it.
 */
export const ADO_PR_EVENT_MANUAL = "ado.pullrequest.manual";

/**
 * Build the {@link NewEvent} for materializing `item`. Carries NO `dedupe_key`
 * (a manual materialize must always insert) and the same payload the poller
 * builds. The caller records it through the normal intake with rule matching
 * skipped.
 */
export function buildManualEvent(item: ADOWorkItem): NewEvent {
  return {
    source: ADO_EVENT_SOURCE,
    type: ADO_EVENT_MANUAL,
    subject_kind: ADO_SUBJECT_KIND,
    subject_ref: String(item.id),
    payload: buildWorkItemPayload(toWorkItemView(item)),
  };
}

/**
 * Build the {@link NewEvent} for materializing `pr`, given its resolved HTTPS
 * clone URL (the value the poller stamps into `repo_remote_url`). Carries NO
 * `dedupe_key` (a manual materialize must always insert) and the same base
 * payload the poller emits for every PR event. The caller records it through
 * the normal intake with rule matching skipped.
 */
export function buildManualPullRequestEvent(
  pr: ADOPullRequest,
  remoteUrl: string
): NewEvent {
  return {
    source: ADO_EVENT_SOURCE,
    type: ADO_PR_EVENT_MANUAL,
    subject_kind: ADO_PR_SUBJECT_KIND,
    subject_ref: String(pr.pullRequestId),
    payload: buildPullRequestPayload(pr, remoteUrl),
  };
}
