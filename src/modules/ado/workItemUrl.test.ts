import { isWorkItemApiUrl, toWorkItemWebUrl } from "./workItemUrl";

describe("toWorkItemWebUrl", () => {
  it("rewrites a dev.azure.com API url to the web-UI edit url", () => {
    expect(
      toWorkItemWebUrl("https://dev.azure.com/org/proj/_apis/wit/workItems/42")
    ).toBe("https://dev.azure.com/org/proj/_workitems/edit/42");
  });

  it("rewrites when the project segment is a GUID (as ADO emits)", () => {
    expect(
      toWorkItemWebUrl(
        "https://dev.azure.com/org/6f9b1c2d-0000-4a11-bbbb-abcdef012345/_apis/wit/workItems/7"
      )
    ).toBe(
      "https://dev.azure.com/org/6f9b1c2d-0000-4a11-bbbb-abcdef012345/_workitems/edit/7"
    );
  });

  it("rewrites an on-prem collection host url, preserving the host/collection/project", () => {
    expect(
      toWorkItemWebUrl(
        "https://tfs.contoso.local/DefaultCollection/MyProject/_apis/wit/workItems/1234"
      )
    ).toBe(
      "https://tfs.contoso.local/DefaultCollection/MyProject/_workitems/edit/1234"
    );
  });

  it("rewrites a legacy visualstudio.com url", () => {
    expect(
      toWorkItemWebUrl(
        "https://myorg.visualstudio.com/MyProject/_apis/wit/workItems/99"
      )
    ).toBe("https://myorg.visualstudio.com/MyProject/_workitems/edit/99");
  });

  it("is case-insensitive on the ADO-capitalized workItems segment", () => {
    expect(
      toWorkItemWebUrl("https://dev.azure.com/o/p/_apis/wit/workitems/5")
    ).toBe("https://dev.azure.com/o/p/_workitems/edit/5");
  });

  it("preserves a trailing query string on the API url", () => {
    expect(
      toWorkItemWebUrl(
        "https://dev.azure.com/o/p/_apis/wit/workItems/8?api-version=7.0"
      )
    ).toBe("https://dev.azure.com/o/p/_workitems/edit/8?api-version=7.0");
  });

  it("leaves a non-matching url unchanged", () => {
    const other = "https://dev.azure.com/o/p/_apis/git/pullRequests/12";
    expect(toWorkItemWebUrl(other)).toBe(other);
    const already = "https://dev.azure.com/o/p/_workitems/edit/3";
    expect(toWorkItemWebUrl(already)).toBe(already);
    expect(toWorkItemWebUrl("not a url")).toBe("not a url");
  });
});

describe("isWorkItemApiUrl", () => {
  it("recognizes only the work-item REST API shape", () => {
    expect(
      isWorkItemApiUrl("https://dev.azure.com/o/p/_apis/wit/workItems/42")
    ).toBe(true);
    expect(
      isWorkItemApiUrl("https://myorg.visualstudio.com/P/_apis/wit/workitems/9")
    ).toBe(true);
    expect(
      isWorkItemApiUrl("https://dev.azure.com/o/p/_workitems/edit/42")
    ).toBe(false);
    expect(
      isWorkItemApiUrl("https://dev.azure.com/o/p/_apis/git/pullRequests/12")
    ).toBe(false);
    expect(isWorkItemApiUrl("")).toBe(false);
  });
});
