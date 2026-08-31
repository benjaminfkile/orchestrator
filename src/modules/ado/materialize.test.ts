import type { ADOPullRequest, ADOWorkItem } from "./client";
import {
  ADO_EVENT_MANUAL,
  ADO_PR_EVENT_MANUAL,
  buildManualEvent,
  buildManualPullRequestEvent,
} from "./materialize";
import { ADO_EVENT_SOURCE, ADO_SUBJECT_KIND } from "./poller";
import { ADO_PR_SUBJECT_KIND, buildPullRequestPayload } from "./pr";
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

function pullRequest(id: number): ADOPullRequest {
  return {
    pullRequestId: id,
    title: "Fix login",
    status: "active",
    isDraft: false,
    sourceRefName: "refs/heads/feature/login",
    targetRefName: "refs/heads/main",
    sourceCommit: "abc123",
    createdBy: { uniqueName: "ada@contoso.com", displayName: "Ada Lovelace" },
    repository: {
      id: "repo-guid",
      name: "web",
      remoteUrl: "https://dev.azure.com/o/p/_git/web",
    },
    reviewers: [],
    url: `https://dev.azure.com/o/p/_apis/git/pullRequests/${id}`,
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

  it("builds a manual PR event with the poller-identical base payload and no dedupe_key", () => {
    const pr = pullRequest(101);
    const event = buildManualPullRequestEvent(
      pr,
      "https://dev.azure.com/o/p/_git/web"
    );

    expect(event).toEqual({
      source: ADO_EVENT_SOURCE,
      type: ADO_PR_EVENT_MANUAL,
      subject_kind: ADO_PR_SUBJECT_KIND,
      subject_ref: "101",
      payload: buildPullRequestPayload(pr, "https://dev.azure.com/o/p/_git/web"),
    });
    // A manual materialize must always insert, so it carries no dedupe_key.
    expect(event.dedupe_key).toBeUndefined();
    // The type is the only place the intent word appears.
    expect(event.type).toBe("ado.pullrequest.manual");
  });
});
