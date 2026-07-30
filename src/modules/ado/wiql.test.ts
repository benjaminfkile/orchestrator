import { buildWatchedWiql } from "./wiql";

/**
 * Golden-string tests. WIQL is a wire format, so every assertion pins the exact
 * text produced — a change in spacing, clause order, or escaping is a change in
 * behavior and must be intentional.
 */
describe("buildWatchedWiql", () => {
  const SELECT = "SELECT [System.Id] FROM WorkItems";
  const ORDER = "ORDER BY [System.ChangedDate] DESC";

  describe("assignee modes", () => {
    it("me → @Me clause", () => {
      expect(buildWatchedWiql({ assignee_mode: "me" })).toBe(
        `${SELECT} WHERE [System.AssignedTo] = @Me ${ORDER}`,
      );
    });

    it("any → no assignee clause and no WHERE at all", () => {
      expect(buildWatchedWiql({ assignee_mode: "any" })).toBe(
        `${SELECT} ${ORDER}`,
      );
    });

    it("people (single) → parenthesised single equality", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "people", people: ["a@x.com"] }),
      ).toBe(
        `${SELECT} WHERE ([System.AssignedTo] = 'a@x.com') ${ORDER}`,
      );
    });

    it("people (multiple) → OR of equalities", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "people",
          people: ["a@x.com", "b@x.com"],
        }),
      ).toBe(
        `${SELECT} WHERE ([System.AssignedTo] = 'a@x.com' OR [System.AssignedTo] = 'b@x.com') ${ORDER}`,
      );
    });

    it("people with empty array → no assignee clause", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "people", people: [] }),
      ).toBe(`${SELECT} ${ORDER}`);
    });

    it("people with omitted people → no assignee clause", () => {
      expect(buildWatchedWiql({ assignee_mode: "people" })).toBe(
        `${SELECT} ${ORDER}`,
      );
    });
  });

  describe("work_item_types clause", () => {
    it("single type → parenthesised single equality", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", work_item_types: ["Bug"] }),
      ).toBe(`${SELECT} WHERE ([System.WorkItemType] = 'Bug') ${ORDER}`);
    });

    it("multiple types → OR group", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          work_item_types: ["Bug", "User Story"],
        }),
      ).toBe(
        `${SELECT} WHERE ([System.WorkItemType] = 'Bug' OR [System.WorkItemType] = 'User Story') ${ORDER}`,
      );
    });

    it("empty types array → no clause", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", work_item_types: [] }),
      ).toBe(`${SELECT} ${ORDER}`);
    });

    it("escapes a quote in a type literal", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", work_item_types: ["O'Type"] }),
      ).toBe(`${SELECT} WHERE ([System.WorkItemType] = 'O''Type') ${ORDER}`);
    });
  });

  describe("states clause", () => {
    it("single state", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", states: ["Active"] }),
      ).toBe(`${SELECT} WHERE ([System.State] = 'Active') ${ORDER}`);
    });

    it("multiple states → OR group", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          states: ["Active", "New"],
        }),
      ).toBe(
        `${SELECT} WHERE ([System.State] = 'Active' OR [System.State] = 'New') ${ORDER}`,
      );
    });

    it("empty states array → no clause", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", states: [] }),
      ).toBe(`${SELECT} ${ORDER}`);
    });

    it("state_mode include is identical to the default", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          states: ["Active", "New"],
          state_mode: "include",
        }),
      ).toBe(
        `${SELECT} WHERE ([System.State] = 'Active' OR [System.State] = 'New') ${ORDER}`,
      );
    });

    it("state_mode exclude (single) → NOT IN with one literal", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          states: ["Closed"],
          state_mode: "exclude",
        }),
      ).toBe(`${SELECT} WHERE [System.State] NOT IN ('Closed') ${ORDER}`);
    });

    it("state_mode exclude → NOT IN comma-separated literals (Contoso open set)", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          states: ["Closed", "Done", "Removed", "Resolved"],
          state_mode: "exclude",
        }),
      ).toBe(
        `${SELECT} WHERE [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ${ORDER}`,
      );
    });

    it("state_mode exclude with empty states → no clause", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          states: [],
          state_mode: "exclude",
        }),
      ).toBe(`${SELECT} ${ORDER}`);
    });

    it("state_mode exclude escapes embedded quotes", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          states: ["O'Done", "Won't Fix"],
          state_mode: "exclude",
        }),
      ).toBe(
        `${SELECT} WHERE [System.State] NOT IN ('O''Done', 'Won''t Fix') ${ORDER}`,
      );
    });
  });

  describe("area paths clause", () => {
    it("single area path uses UNDER", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", area_paths: ["Proj\\Team"] }),
      ).toBe(
        `${SELECT} WHERE ([System.AreaPath] UNDER 'Proj\\Team') ${ORDER}`,
      );
    });

    it("multiple area paths → OR of UNDER", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          area_paths: ["Proj\\A", "Proj\\B"],
        }),
      ).toBe(
        `${SELECT} WHERE ([System.AreaPath] UNDER 'Proj\\A' OR [System.AreaPath] UNDER 'Proj\\B') ${ORDER}`,
      );
    });
  });

  describe("iteration clause", () => {
    it("current → @CurrentIteration", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", iteration: "current" }),
      ).toBe(
        `${SELECT} WHERE [System.IterationPath] = @CurrentIteration ${ORDER}`,
      );
    });

    it("null iteration → no clause", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", iteration: null }),
      ).toBe(`${SELECT} ${ORDER}`);
    });

    it("current_for_team → team-scoped @CurrentIteration with bracketed project", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          iteration: { current_for_team: "Contoso\\Alpha" },
        }),
      ).toBe(
        `${SELECT} WHERE [System.IterationPath] = @CurrentIteration('[Contoso]\\Alpha') ${ORDER}`,
      );
    });

    it("current_for_team with a multi-segment team path keeps trailing segments", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          iteration: { current_for_team: "Contoso\\Area\\Sub Team" },
        }),
      ).toBe(
        `${SELECT} WHERE [System.IterationPath] = @CurrentIteration('[Contoso]\\Area\\Sub Team') ${ORDER}`,
      );
    });

    it("current_for_team with no backslash brackets the whole value", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          iteration: { current_for_team: "Contoso" },
        }),
      ).toBe(
        `${SELECT} WHERE [System.IterationPath] = @CurrentIteration('[Contoso]') ${ORDER}`,
      );
    });

    it("current_for_team escapes embedded quotes in the literal", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          iteration: { current_for_team: "O'Proj\\O'Team" },
        }),
      ).toBe(
        `${SELECT} WHERE [System.IterationPath] = @CurrentIteration('[O''Proj]\\O''Team') ${ORDER}`,
      );
    });

    it("explicit path → [System.IterationPath] UNDER the quoted path", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          iteration: { path: "Alpha\\Backlog" },
        }),
      ).toBe(
        `${SELECT} WHERE [System.IterationPath] UNDER 'Alpha\\Backlog' ${ORDER}`,
      );
    });

    it("explicit path escapes embedded quotes in the literal", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          iteration: { path: "O'Proj\\Backlog" },
        }),
      ).toBe(
        `${SELECT} WHERE [System.IterationPath] UNDER 'O''Proj\\Backlog' ${ORDER}`,
      );
    });
  });

  describe("tags clause", () => {
    it("single tag → CONTAINS", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", tags: ["urgent"] }),
      ).toBe(`${SELECT} WHERE [System.Tags] CONTAINS 'urgent' ${ORDER}`);
    });

    it("multiple tags → AND of CONTAINS, one clause each", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "any",
          tags: ["urgent", "customer"],
        }),
      ).toBe(
        `${SELECT} WHERE [System.Tags] CONTAINS 'urgent' AND [System.Tags] CONTAINS 'customer' ${ORDER}`,
      );
    });

    it("empty tags array → no clause", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", tags: [] }),
      ).toBe(`${SELECT} ${ORDER}`);
    });

    it("escapes a quote in a tag literal", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", tags: ["O'Tag"] }),
      ).toBe(`${SELECT} WHERE [System.Tags] CONTAINS 'O''Tag' ${ORDER}`);
    });
  });

  describe("quote escaping", () => {
    it("doubles embedded single quotes in a person literal", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "people", people: ["O'Brien"] }),
      ).toBe(
        `${SELECT} WHERE ([System.AssignedTo] = 'O''Brien') ${ORDER}`,
      );
    });

    it("doubles multiple embedded quotes in a state literal", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", states: ["a'b'c"] }),
      ).toBe(`${SELECT} WHERE ([System.State] = 'a''b''c') ${ORDER}`);
    });

    it("escapes a quote in an area path literal", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any", area_paths: ["Proj\\O'Team"] }),
      ).toBe(
        `${SELECT} WHERE ([System.AreaPath] UNDER 'Proj\\O''Team') ${ORDER}`,
      );
    });
  });

  describe("clause combination", () => {
    it("me + states + area_paths + iteration in fixed order", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "me",
          states: ["Active"],
          area_paths: ["Proj\\Team"],
          iteration: "current",
        }),
      ).toBe(
        `${SELECT} WHERE [System.AssignedTo] = @Me` +
          ` AND ([System.State] = 'Active')` +
          ` AND ([System.AreaPath] UNDER 'Proj\\Team')` +
          ` AND [System.IterationPath] = @CurrentIteration` +
          ` ${ORDER}`,
      );
    });

    it("people + states combined", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "people",
          people: ["a@x.com", "b@x.com"],
          states: ["Active", "Resolved"],
        }),
      ).toBe(
        `${SELECT} WHERE ([System.AssignedTo] = 'a@x.com' OR [System.AssignedTo] = 'b@x.com')` +
          ` AND ([System.State] = 'Active' OR [System.State] = 'Resolved')` +
          ` ${ORDER}`,
      );
    });

    it("all new clauses in fixed order (types, exclude states, area, team iteration, tags)", () => {
      expect(
        buildWatchedWiql({
          assignee_mode: "me",
          work_item_types: ["Bug", "Task"],
          states: ["Closed", "Done", "Removed", "Resolved"],
          state_mode: "exclude",
          area_paths: ["Contoso\\Alpha"],
          iteration: { current_for_team: "Contoso\\Alpha" },
          tags: ["urgent", "customer"],
        }),
      ).toBe(
        `${SELECT} WHERE [System.AssignedTo] = @Me` +
          ` AND ([System.WorkItemType] = 'Bug' OR [System.WorkItemType] = 'Task')` +
          ` AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')` +
          ` AND ([System.AreaPath] UNDER 'Contoso\\Alpha')` +
          ` AND [System.IterationPath] = @CurrentIteration('[Contoso]\\Alpha')` +
          ` AND [System.Tags] CONTAINS 'urgent' AND [System.Tags] CONTAINS 'customer'` +
          ` ${ORDER}`,
      );
    });
  });

  describe("project scoping", () => {
    it("project option → leading [System.TeamProject] clause", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any" }, { project: "projectA" }),
      ).toBe(`${SELECT} WHERE [System.TeamProject] = 'projectA' ${ORDER}`);
    });

    it("project is the FIRST clause, ahead of every configured filter", () => {
      expect(
        buildWatchedWiql(
          {
            assignee_mode: "me",
            states: ["Active"],
          },
          { project: "projectA" },
        ),
      ).toBe(
        `${SELECT} WHERE [System.TeamProject] = 'projectA'` +
          ` AND [System.AssignedTo] = @Me` +
          ` AND ([System.State] = 'Active')` +
          ` ${ORDER}`,
      );
    });

    it("an empty/omitted project leaves the query project-agnostic", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any" }, { project: "" }),
      ).toBe(`${SELECT} ${ORDER}`);
      expect(buildWatchedWiql({ assignee_mode: "any" }, {})).toBe(
        `${SELECT} ${ORDER}`,
      );
    });

    it("escapes a quote in the project name", () => {
      expect(
        buildWatchedWiql({ assignee_mode: "any" }, { project: "O'Proj" }),
      ).toBe(`${SELECT} WHERE [System.TeamProject] = 'O''Proj' ${ORDER}`);
    });
  });
});
