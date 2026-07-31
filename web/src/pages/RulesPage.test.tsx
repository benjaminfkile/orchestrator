import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRule,
  deleteRule,
  listPlaybooks,
  listRules,
  setRuleEnabled,
  updateRule,
  type PlaybookSummary,
  type RuleRecord,
} from "../rules";
import { getEventSources, getEventTypes } from "../discovery";
import { listNotifiers, type NotifierRecord } from "../notifiers";
import { RulesPage } from "./RulesPage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rules")>()),
  listRules: vi.fn(),
  listPlaybooks: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  setRuleEnabled: vi.fn(),
}));

// The notify-targets editor is fed by the notifiers list; stub the loader.
vi.mock("../notifiers", () => ({
  listNotifiers: vi.fn(),
}));

// The Source/Type editor inputs are facet-fed comboboxes; stub the loaders.
vi.mock("../discovery", () => ({
  getEventSources: vi.fn(),
  getEventTypes: vi.fn(),
}));
// The page registers a live-refetch subscription that requires a ChangesProvider
// in the tree. These unit tests render the page bare, so stub the hook to a
// no-op; the live-stream wiring is covered by useLiveRefetch.test.tsx.
vi.mock("../components/useLiveRefetch", () => ({
  useLiveRefetch: vi.fn(),
}));

const mockListRules = vi.mocked(listRules);
const mockListPlaybooks = vi.mocked(listPlaybooks);
const mockCreateRule = vi.mocked(createRule);
const mockUpdateRule = vi.mocked(updateRule);
const mockDeleteRule = vi.mocked(deleteRule);
const mockSetRuleEnabled = vi.mocked(setRuleEnabled);
const mockListNotifiers = vi.mocked(listNotifiers);
const mockGetEventSources = vi.mocked(getEventSources);
const mockGetEventTypes = vi.mocked(getEventTypes);

function notifier(
  overrides: Partial<NotifierRecord> & Pick<NotifierRecord, "id">,
): NotifierRecord {
  return {
    name: "notifier",
    config: {},
    title_template: "",
    body_template: "",
    enabled: true,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

const NOTIFIERS: NotifierRecord[] = [
  notifier({ id: 200, name: "Inbox alert" }),
  notifier({ id: 201, name: "Desktop toast" }),
];

/**
 * Class names of injected CSS rules that cap a width against the viewport, i.e.
 * `min(<px>, <n>vw)`. The centered editor Dialog's surface caps its max-width
 * this way so it never exceeds a phone viewport. Griffel compiles that into an
 * atomic class; reading it back from the stylesheet is more reliable than
 * getComputedStyle (jsdom's raw cascade doesn't replicate griffel's
 * className-merge conflict resolution).
 */
function viewportWidthClasses(): string[] {
  const classes: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const raw of Array.from(rules ?? [])) {
      const text = raw.cssText;
      if (text.includes("width") && text.includes("vw") && text.includes("min(")) {
        const match = text.match(/^\.([\w-]+)/);
        if (match) classes.push(match[1]);
      }
    }
  }
  return classes;
}

/** Commit a freeform value into a combobox field (typing only applies on blur). */
function setCombo(name: string, value: string) {
  const input = screen.getByRole("combobox", { name });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function rule(overrides: Partial<RuleRecord> & Pick<RuleRecord, "id">): RuleRecord {
  return {
    name: "rule",
    enabled: true,
    match: {},
    dispatch: [],
    notify: [],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

const PLAYBOOKS: PlaybookSummary[] = [
  { id: 100, name: "Researcher" },
  { id: 101, name: "Triage" },
];

const RULES: RuleRecord[] = [
  rule({
    id: 1,
    name: "Active bugs",
    enabled: true,
    match: { source: "ado", type: "work_item.*", criteria: { state: "Active" } },
    dispatch: [{ playbook_id: 100 }],
  }),
  rule({ id: 2, name: "Catch-all", enabled: false, match: {}, dispatch: [] }),
];

beforeEach(() => {
  mockListRules.mockResolvedValue(RULES);
  mockListPlaybooks.mockResolvedValue(PLAYBOOKS);
  mockListNotifiers.mockResolvedValue(NOTIFIERS);
  mockCreateRule.mockResolvedValue(rule({ id: 3 }));
  mockUpdateRule.mockResolvedValue(rule({ id: 1 }));
  mockDeleteRule.mockResolvedValue(undefined);
  mockSetRuleEnabled.mockImplementation((id, enabled) =>
    Promise.resolve(rule({ id, enabled })),
  );
  mockGetEventSources.mockResolvedValue(["ado", "github"]);
  mockGetEventTypes.mockResolvedValue([
    "pull_request.opened",
    "work_item.created",
    "work_item.updated",
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Open the create dialog and wait for its form to mount. */
async function openCreateDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "New rule" }));
  await screen.findByRole("textbox", { name: "Name" });
}

describe("RulesPage", () => {
  it("renders a row per rule with source, type, and target count", async () => {
    render(<RulesPage />);
    const table = await screen.findByRole("table", { name: "Rules" });

    const rows = within(table).getAllByRole("row");
    const first = within(rows[1]).getAllByRole("cell");
    expect(first[1].textContent).toBe("Active bugs");
    expect(first[2].textContent).toBe("ado");
    expect(first[3].textContent).toBe("work_item.*");
    expect(first[4].textContent).toBe("1");

    // A match with no source/type falls back to "any".
    const second = within(rows[2]).getAllByRole("cell");
    expect(second[2].textContent).toBe("any");
    expect(second[3].textContent).toBe("any");
  });

  it("filters client-side across all columns, including stringified criteria JSON", async () => {
    render(<RulesPage />);
    const table = await screen.findByRole("table", { name: "Rules" });
    expect(within(table).getByText("Active bugs")).toBeTruthy();
    expect(within(table).getByText("Catch-all")).toBeTruthy();

    // "state" appears ONLY in the stringified match.criteria ({"state":"Active"}),
    // never in a rendered column — so a hit proves JSON cells are searched.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules" }), {
      target: { value: "state" },
    });
    await waitFor(() => {
      expect(screen.queryByText("Catch-all")).toBeNull();
    });
    expect(screen.getByText("Active bugs")).toBeTruthy();

    // Multi-term AND: "state" (criteria) + "work_item" (type column) both hit
    // only the first rule.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules" }), {
      target: { value: "state work_item" },
    });
    await waitFor(() => {
      expect(screen.getByText("Active bugs")).toBeTruthy();
    });
    expect(screen.queryByText("Catch-all")).toBeNull();

    // A term that matches no single row empties the table.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules" }), {
      target: { value: "state catch" },
    });
    await waitFor(() => {
      expect(screen.getByText("No rules match your search.")).toBeTruthy();
    });

    // Clearing restores the full list.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules" }), {
      target: { value: "" },
    });
    await waitFor(() => {
      expect(screen.getByText("Catch-all")).toBeTruthy();
    });
    expect(screen.getByText("Active bugs")).toBeTruthy();
  });

  it("wraps the table in a horizontally scrollable container", async () => {
    render(<RulesPage />);
    const table = await screen.findByRole("table", { name: "Rules" });
    const wrap = table.parentElement as HTMLElement;
    expect(getComputedStyle(wrap).overflowX).toBe("auto");
  });

  it("caps the editor dialog width to the viewport", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await openCreateDrawer();
    // The centered Dialog surface caps its max-width at min(<px>, <n>vw) so it
    // never exceeds a phone viewport. Griffel compiles that to an atomic class;
    // confirm the rule is emitted and applied to the open dialog's surface.
    const capClasses = viewportWidthClasses();
    expect(capClasses.length).toBeGreaterThan(0);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(capClasses.some((c) => dialog.classList.contains(c))).toBe(true);
  });

  it("reflects each rule's enabled state in its toggle", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });

    const enabled = screen.getByRole("switch", { name: "Enable Active bugs" });
    const disabled = screen.getByRole("switch", { name: "Enable Catch-all" });
    expect((enabled as HTMLInputElement).checked).toBe(true);
    expect((disabled as HTMLInputElement).checked).toBe(false);
  });

  it("disables a rule via the disable endpoint when toggled off", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });

    fireEvent.click(screen.getByRole("switch", { name: "Enable Active bugs" }));
    await waitFor(() =>
      expect(mockSetRuleEnabled).toHaveBeenCalledWith(1, false),
    );
  });

  it("enables a rule via the enable endpoint when toggled on", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });

    fireEvent.click(screen.getByRole("switch", { name: "Enable Catch-all" }));
    await waitFor(() => expect(mockSetRuleEnabled).toHaveBeenCalledWith(2, true));
  });

  it("shows an inline error and blocks save on invalid criteria JSON", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Criteria (JSON)" }), {
      target: { value: "{ not json" },
    });

    // A parse error is surfaced inline and Save is disabled. (Match the parse
    // message specifically so it doesn't collide with the "Criteria (JSON)"
    // field label.)
    await screen.findByText(/at position/i);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it("rejects criteria that is valid JSON but not an object", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Criteria (JSON)" }), {
      target: { value: "[1, 2, 3]" },
    });

    expect(screen.getByText("Criteria must be a JSON object")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("requires a name before saving", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await openCreateDrawer();

    // Empty name → Save disabled.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Name is required")).toBeTruthy();
  });

  it("creates a rule with the assembled payload shape", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "  My rule  " },
    });
    // Type is a freeform combobox that still accepts the `prefix.*` wildcard.
    setCombo("Source", "ado");
    setCombo("Type", "work_item.*");
    fireEvent.change(screen.getByRole("textbox", { name: "Criteria (JSON)" }), {
      target: { value: '{ "state": "Active" }' },
    });

    // Add a dispatch target and pick a playbook from the dropdown.
    fireEvent.click(screen.getByRole("button", { name: "Add target" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Target 1 playbook" }),
      { target: { value: "100" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateRule).toHaveBeenCalledTimes(1));
    expect(mockCreateRule).toHaveBeenCalledWith({
      name: "My rule",
      match: { source: "ado", type: "work_item.*", criteria: { state: "Active" } },
      dispatch: [{ playbook_id: 100 }],
      notify: [],
    });
  });

  it("attaches selected notify targets to the created rule", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await waitFor(() => expect(mockListNotifiers).toHaveBeenCalled());
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Alerting rule" },
    });

    // Add a notify target and pick a notifier from the dropdown.
    fireEvent.click(screen.getByRole("button", { name: "Add notify target" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Notify target 1 notifier" }),
      { target: { value: "201" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateRule).toHaveBeenCalledTimes(1));
    expect(mockCreateRule).toHaveBeenCalledWith({
      name: "Alerting rule",
      match: {},
      dispatch: [],
      notify: [{ notifier_id: 201 }],
    });
  });

  it("prefills notify targets when editing a rule that has them", async () => {
    mockListRules.mockReset();
    mockListRules.mockResolvedValue([
      rule({ id: 5, name: "With notify", notify: [{ notifier_id: 200 }] }),
    ]);

    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Name" });

    const select = (await screen.findByRole("combobox", {
      name: "Notify target 1 notifier",
    })) as HTMLSelectElement;
    expect(select.value).toBe("200");
  });

  it("suggests known sources and types from the facets endpoint", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await openCreateDrawer();
    await waitFor(() => expect(mockGetEventSources).toHaveBeenCalled());
    await waitFor(() => expect(mockGetEventTypes).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("combobox", { name: "Source" }));
    expect(await screen.findByRole("option", { name: "ado" })).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "Type" }));
    expect(
      await screen.findByRole("option", { name: "work_item.updated" }),
    ).toBeTruthy();

    // Opening a dropdown inside the modal Dialog must render inline (inlinePopup)
    // and must NOT blank the surface: the dialog and its form stay on screen.
    // (Portaling the listbox to <body> was a real bug that hid the whole form.)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
  });

  it("omits empty match fields and drops unselected targets from the payload", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Bare" },
    });
    // Add a target but leave it on the placeholder (playbook_id 0).
    fireEvent.click(screen.getByRole("button", { name: "Add target" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateRule).toHaveBeenCalledTimes(1));
    expect(mockCreateRule).toHaveBeenCalledWith({
      name: "Bare",
      match: {},
      dispatch: [],
      notify: [],
    });
  });

  it("edits an existing rule, prefilling the form and PATCHing it", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const name = (await screen.findByRole("textbox", {
      name: "Name",
    })) as HTMLInputElement;
    expect(name.value).toBe("Active bugs");
    expect(
      (screen.getByRole("combobox", { name: "Source" }) as HTMLInputElement)
        .value,
    ).toBe("ado");
    expect(
      (screen.getByRole("textbox", { name: "Criteria (JSON)" }) as HTMLTextAreaElement)
        .value,
    ).toContain('"state": "Active"');

    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateRule).toHaveBeenCalledTimes(1));
    expect(mockUpdateRule).toHaveBeenCalledWith(1, {
      name: "Renamed",
      match: { source: "ado", type: "work_item.*", criteria: { state: "Active" } },
      dispatch: [{ playbook_id: 100 }],
      notify: [],
    });
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it("deletes a rule only after confirming in the dialog", async () => {
    render(<RulesPage />);
    await screen.findByRole("table", { name: "Rules" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    // Confirm dialog shows the rule name; nothing deleted yet.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Active bugs/)).toBeTruthy();
    expect(mockDeleteRule).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockDeleteRule).toHaveBeenCalledWith(1));
  });

  it("surfaces a load error", async () => {
    mockListRules.mockReset();
    mockListRules.mockRejectedValueOnce(new Error("boom"));

    render(<RulesPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});
