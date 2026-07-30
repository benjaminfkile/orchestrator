/**
 * On-demand single-work-item materialize — turn ONE fetched Azure DevOps work
 * item into a generic event, shaped EXACTLY like a poll tick's, so a playbook
 * can be dispatched against it manually.
 *
 * This is the one place the manual event `type` string lives. It reuses the
 * poller's payload builder ({@link buildWorkItemPayload}) so a materialized event
 * is byte-for-byte the same shape a first-seen poll would emit — only the `type`
 * and the absence of a `dedupe_key` differ. Per the ARCHITECTURE PRINCIPLE (see
 * CLAUDE.md), the intent word appears only in this event-type string; no code
 * branches on it. READ-ONLY: the caller fetches the item with a read; nothing
 * here writes to ADO.
 */

import type { NewEvent } from "../../interfaces";
import type { ADOWorkItem } from "./client";
import { ADO_EVENT_SOURCE, ADO_SUBJECT_KIND } from "./poller";
import { buildWorkItemPayload, toWorkItemView } from "./workItemPayload";

/**
 * Event `type` for a manually-materialized work item. Distinct from the poller's
 * diff-driven types so rules can target manual runs specifically; the poller
 * never emits it.
 */
export const ADO_EVENT_MANUAL = "ado.workitem.manual";

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
