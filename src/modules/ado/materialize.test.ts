import type { ADOWorkItem } from "./client";
import { ADO_EVENT_MANUAL, buildManualEvent } from "./materialize";
import { ADO_EVENT_SOURCE, ADO_SUBJECT_KIND } from "./poller";
import { buildWorkItemPayload, toWorkItemView } from "./workItemPayload";

function workItem(id: number): ADOWorkItem {
  return {
    id,
    url: `https://dev.azure.com/o/p/_apis/wit/workItems/${id}`,
    relations: [],
    fields: {
      "System.Title": "Ship it",
      "System.State": "Active",
      "System.WorkItemType": "Bug",
      "System.AreaPath": "Proj\\Web",
      "System.IterationPath": "Proj\\Sprint 2",
      "System.AssignedTo": { uniqueName: "ada@contoso.com" },
      "System.Tags": "urgent; regression",
      "System.ChangedDate": "2026-07-15T10:00:00Z",
    },
  };
}

describe("ado materialize", () => {
  it("builds a manual event with the poller-identical payload and no dedupe_key", () => {
    const item = workItem(77);
    const event = buildManualEvent(item);

    expect(event).toEqual({
      source: ADO_EVENT_SOURCE,
      type: ADO_EVENT_MANUAL,
      subject_kind: ADO_SUBJECT_KIND,
      subject_ref: "77",
      payload: buildWorkItemPayload(toWorkItemView(item)),
    });
    // A manual materialize must always insert, so it carries no dedupe_key.
    expect(event.dedupe_key).toBeUndefined();
    // The type is the only place the intent word appears.
    expect(event.type).toBe("ado.workitem.manual");
  });
});
