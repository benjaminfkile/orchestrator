import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backfillModule,
  getModuleConfig,
  listModules,
  putModuleConfig,
  type AdoModuleConfig,
  type ModuleStatus,
} from "../modules";
import {
  getAdoAreaPaths,
  getAdoIdentities,
  getAdoIterations,
  getAdoOrgs,
  getAdoProjects,
  getAdoStates,
  getAdoWorkItemTypes,
  getSecretNames,
} from "../discovery";
import { ModulesPage } from "./ModulesPage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules")>()),
  listModules: vi.fn(),
  getModuleConfig: vi.fn(),
  putModuleConfig: vi.fn(),
  backfillModule: vi.fn(),
}));

// Every picker pulls its options from the discovery data layer.
vi.mock("../discovery", () => ({
  getSecretNames: vi.fn(),
  getAdoOrgs: vi.fn(),
  getAdoProjects: vi.fn(),
  getAdoWorkItemTypes: vi.fn(),
  getAdoStates: vi.fn(),
  getAdoAreaPaths: vi.fn(),
  getAdoIterations: vi.fn(),
  getAdoIdentities: vi.fn(),
}));

const mockListModules = vi.mocked(listModules);
const mockGetModuleConfig = vi.mocked(getModuleConfig);
const mockPutModuleConfig = vi.mocked(putModuleConfig);
const mockBackfillModule = vi.mocked(backfillModule);
const mockGetSecretNames = vi.mocked(getSecretNames);
const mockGetAdoOrgs = vi.mocked(getAdoOrgs);
const mockGetAdoProjects = vi.mocked(getAdoProjects);
const mockGetAdoWorkItemTypes = vi.mocked(getAdoWorkItemTypes);
const mockGetAdoStates = vi.mocked(getAdoStates);
const mockGetAdoAreaPaths = vi.mocked(getAdoAreaPaths);
const mockGetAdoIterations = vi.mocked(getAdoIterations);
const mockGetAdoIdentities = vi.mocked(getAdoIdentities);

const MODULES: ModuleStatus[] = [
  {
    id: "ado",
    producers: [
      {
        producerId: "ado.workitem",
        trigger: { kind: "interval", seconds: 60 },
        lastTickAt: 1_700_000_000_000,
        lastError: "boom while polling",
        nextFireAt: 1_700_000_060_000,
      },
    ],
  },
];

function setConfig(config: AdoModuleConfig | null) {
  mockGetModuleConfig.mockResolvedValue({ module_id: "ado", config });
}

beforeEach(() => {
  mockListModules.mockResolvedValue(MODULES);
  setConfig(null);
  mockPutModuleConfig.mockResolvedValue({ module_id: "ado", config: {} });
  mockGetSecretNames.mockResolvedValue(["ado_pat"]);
  // Single-candidate discovery by default so the org→project cascade autofills.
  mockGetAdoOrgs.mockResolvedValue(["contoso"]);
  mockGetAdoProjects.mockResolvedValue(["Platform"]);
  mockGetAdoWorkItemTypes.mockResolvedValue(["Bug", "Task"]);
  mockGetAdoStates.mockResolvedValue(["Active", "New"]);
  mockGetAdoAreaPaths.mockResolvedValue(["Platform", "Platform\\Backend"]);
  mockGetAdoIterations.mockResolvedValue(["Platform\\Sprint 1"]);
  mockGetAdoIdentities.mockResolvedValue([
    { value: "alice@contoso.com", label: "Alice" },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Grab a combobox input by its accessible name. */
function combobox(name: string): HTMLInputElement {
  return screen.getByRole("combobox", { name }) as HTMLInputElement;
}

describe("ModulesPage", () => {
  it("renders the ADO producer status", async () => {
    render(<ModulesPage />);
    const status = await screen.findByTestId("ado-status");
    expect(status.textContent).toContain("every 60s");
    expect(status.textContent).toContain("boom while polling");
  });

  it("renders the Datadog card beside ADO when the module is registered", async () => {
    mockListModules.mockResolvedValue([
      ...MODULES,
      {
        id: "datadog",
        producers: [
          {
            producerId: "datadog.logwatch",
            trigger: { kind: "interval", seconds: 60 },
            lastTickAt: null,
            lastError: null,
            nextFireAt: null,
          },
        ],
      },
    ]);
    render(<ModulesPage />);
    // Both module cards render side by side.
    expect(await screen.findByText("Azure DevOps")).toBeTruthy();
    expect(await screen.findByText("Datadog")).toBeTruthy();
    expect(await screen.findByTestId("datadog-status")).toBeTruthy();
  });

  it("hides the Datadog card when the module is not registered", async () => {
    render(<ModulesPage />);
    await screen.findByText("Azure DevOps");
    expect(screen.queryByText("Datadog")).toBeNull();
  });

  it("autofills org then project when discovery returns a single candidate", async () => {
    render(<ModulesPage />);

    // Org is discovered and, being the only one, auto-selected…
    await waitFor(() => expect(combobox("Organization").value).toBe("contoso"));
    // …which cascades into loading + auto-selecting the sole project…
    await waitFor(() => expect(combobox("Project").value).toBe("Platform"));
    expect(mockGetAdoProjects).toHaveBeenCalledWith("contoso");
    // …which cascades into loading the project's types/areas/states.
    await waitFor(() =>
      expect(mockGetAdoWorkItemTypes).toHaveBeenCalledWith("contoso", "Platform"),
    );
    expect(mockGetAdoAreaPaths).toHaveBeenCalledWith("contoso", "Platform");
    await waitFor(() => expect(mockGetAdoStates).toHaveBeenCalled());
  });

  it("loads a chosen org's projects when the org is picked manually", async () => {
    mockGetAdoOrgs.mockResolvedValue(["contoso", "fabrikam"]);
    mockGetAdoProjects.mockResolvedValue(["Alpha", "Beta"]);
    render(<ModulesPage />);

    const org = await screen.findByRole("combobox", { name: "Organization" });
    fireEvent.click(org);
    fireEvent.click(await screen.findByRole("option", { name: "fabrikam" }));

    await waitFor(() =>
      expect(mockGetAdoProjects).toHaveBeenCalledWith("fabrikam"),
    );
  });

  it("reloads states scoped to a selected work-item type", async () => {
    render(<ModulesPage />);
    await waitFor(() => expect(combobox("Project").value).toBe("Platform"));
    // Until a type is chosen, states are unioned across every discovered type.
    await waitFor(() =>
      expect(mockGetAdoStates).toHaveBeenCalledWith("contoso", "Platform", "Task"),
    );
    expect(mockGetAdoStates).toHaveBeenCalledWith("contoso", "Platform", "Bug");

    // Narrow to a single type; states reload for that type alone.
    mockGetAdoStates.mockClear();
    const types = combobox("Work item types");
    fireEvent.focus(types);
    fireEvent.change(types, { target: { value: "Feature" } });
    fireEvent.keyDown(types, { key: "Enter" });

    await waitFor(() =>
      expect(mockGetAdoStates).toHaveBeenCalledWith(
        "contoso",
        "Platform",
        "Feature",
      ),
    );
    expect(mockGetAdoStates).not.toHaveBeenCalledWith(
      "contoso",
      "Platform",
      "Task",
    );
  });

  it("prefills the form from the stored config", async () => {
    mockGetAdoOrgs.mockResolvedValue(["contoso", "fabrikam"]);
    mockGetAdoProjects.mockResolvedValue(["Platform", "Other"]);
    // Empty identity options so the people tag shows the raw stored value
    // rather than a discovered display-name label.
    mockGetAdoIdentities.mockResolvedValue([]);
    setConfig({
      org: "contoso",
      project: "Platform",
      pat_secret_ref: "ado_pat",
      enabled: true,
      interval_seconds: 120,
      watched: {
        assignee_mode: "people",
        people: ["alice@contoso.com"],
        states: ["Active"],
        area_paths: ["Platform\\Backend"],
        iteration: "current",
      },
    });

    render(<ModulesPage />);
    await waitFor(() => expect(combobox("Organization").value).toBe("contoso"));
    expect(combobox("Project").value).toBe("Platform");
    expect(
      (screen.getByRole("spinbutton", {
        name: "Poll interval (seconds)",
      }) as HTMLInputElement).value,
    ).toBe("120");
    expect(
      (screen.getByRole("switch", { name: "Enabled" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    // Multi-select values render as tags.
    expect(screen.getByText("alice@contoso.com")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Platform\\Backend")).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: "Specific people" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByRole("switch", {
        name: "Current iteration only",
      }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("hides the People picker unless assignee mode is 'people'", async () => {
    mockGetAdoOrgs.mockResolvedValue(["contoso", "fabrikam"]);
    setConfig({ watched: { assignee_mode: "any" } });
    render(<ModulesPage />);
    await screen.findByRole("combobox", { name: "Organization" });
    expect(screen.queryByRole("combobox", { name: "People" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Specific people" }));
    expect(screen.getByRole("combobox", { name: "People" })).toBeTruthy();
  });

  it("saves the assembled config via PUT", async () => {
    // Empty option lists so each freeform Enter commits a fresh tag (a typed
    // value that already matches a loaded option is left to dropdown selection).
    mockGetAdoStates.mockResolvedValue([]);
    mockGetAdoAreaPaths.mockResolvedValue([]);
    render(<ModulesPage />);
    // Org/project autofill; wait for the cascade to settle.
    await waitFor(() => expect(combobox("Project").value).toBe("Platform"));

    // PAT is a freeform picker; a typed value commits on blur.
    const pat = combobox("PAT secret name");
    fireEvent.focus(pat);
    fireEvent.change(pat, { target: { value: "ado_pat" } });
    fireEvent.blur(pat);

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Poll interval (seconds)" }),
      { target: { value: "90" } },
    );

    fireEvent.click(screen.getByRole("radio", { name: "Specific people" }));
    const people = combobox("People");
    fireEvent.focus(people);
    fireEvent.change(people, { target: { value: "bob@contoso.com" } });
    fireEvent.keyDown(people, { key: "Enter" });

    const states = combobox("States");
    fireEvent.focus(states);
    fireEvent.change(states, { target: { value: "Active" } });
    fireEvent.keyDown(states, { key: "Enter" });

    const areas = combobox("Area paths");
    fireEvent.focus(areas);
    fireEvent.change(areas, { target: { value: "Platform\\Backend" } });
    fireEvent.keyDown(areas, { key: "Enter" });

    fireEvent.click(
      screen.getByRole("switch", { name: "Current iteration only" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockPutModuleConfig).toHaveBeenCalledTimes(1));
    expect(mockPutModuleConfig).toHaveBeenCalledWith("ado", {
      org: "contoso",
      project: "Platform",
      pat_secret_ref: "ado_pat",
      enabled: true,
      interval_seconds: 90,
      watched: {
        assignee_mode: "people",
        people: ["bob@contoso.com"],
        states: ["Active"],
        area_paths: ["Platform\\Backend"],
        iteration: "current",
      },
    });
  });

  it("omits people/states/area/iteration when left empty", async () => {
    // Multiple orgs → no autofill → fields stay empty; enter org/project by hand.
    mockGetAdoOrgs.mockResolvedValue(["contoso", "fabrikam"]);
    render(<ModulesPage />);
    await screen.findByRole("combobox", { name: "Organization" });

    const org = combobox("Organization");
    fireEvent.focus(org);
    fireEvent.change(org, { target: { value: "contoso" } });
    fireEvent.blur(org);

    const project = combobox("Project");
    fireEvent.focus(project);
    fireEvent.change(project, { target: { value: "Platform" } });
    fireEvent.blur(project);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockPutModuleConfig).toHaveBeenCalledTimes(1));
    expect(mockPutModuleConfig).toHaveBeenCalledWith("ado", {
      org: "contoso",
      project: "Platform",
      pat_secret_ref: "",
      enabled: false,
      watched: { assignee_mode: "any" },
    });
  });

  it("still saves typed values when discovery fails (degrades gracefully)", async () => {
    // Every discovery read rejects — pickers surface the error inline but stay
    // freeform, and the form still saves.
    mockGetAdoOrgs.mockRejectedValue(new Error("network down"));
    mockGetAdoProjects.mockRejectedValue(new Error("network down"));
    mockGetAdoWorkItemTypes.mockRejectedValue(new Error("network down"));
    mockGetAdoStates.mockRejectedValue(new Error("network down"));
    mockGetAdoAreaPaths.mockRejectedValue(new Error("network down"));
    mockGetAdoIterations.mockRejectedValue(new Error("network down"));
    mockGetAdoIdentities.mockRejectedValue(new Error("network down"));

    render(<ModulesPage />);
    await screen.findByRole("combobox", { name: "Organization" });

    // The inline degrade notice from the failed org picker is present.
    expect(
      (await screen.findAllByText(/Couldn't load options/)).length,
    ).toBeGreaterThan(0);

    const org = combobox("Organization");
    fireEvent.focus(org);
    fireEvent.change(org, { target: { value: "contoso" } });
    fireEvent.blur(org);

    const project = combobox("Project");
    fireEvent.focus(project);
    fireEvent.change(project, { target: { value: "Platform" } });
    fireEvent.blur(project);

    const states = combobox("States");
    fireEvent.focus(states);
    fireEvent.change(states, { target: { value: "Active" } });
    fireEvent.keyDown(states, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockPutModuleConfig).toHaveBeenCalledTimes(1));
    expect(mockPutModuleConfig).toHaveBeenCalledWith("ado", {
      org: "contoso",
      project: "Platform",
      pat_secret_ref: "",
      enabled: false,
      watched: { assignee_mode: "any", states: ["Active"] },
    });
  });

  it("warns when the current-iteration filter can't match (no iterations)", async () => {
    mockGetAdoIterations.mockResolvedValue([]);
    setConfig({
      org: "contoso",
      project: "Platform",
      watched: { assignee_mode: "any", iteration: "current" },
    });
    render(<ModulesPage />);
    expect(await screen.findByTestId("iteration-warn")).toBeTruthy();
  });

  it("does not warn about iterations when the project has some", async () => {
    mockGetAdoIterations.mockResolvedValue(["Platform\\Sprint 1"]);
    setConfig({
      org: "contoso",
      project: "Platform",
      watched: { assignee_mode: "any", iteration: "current" },
    });
    render(<ModulesPage />);
    await screen.findByRole("combobox", { name: "Organization" });
    await waitFor(() => expect(mockGetAdoIterations).toHaveBeenCalled());
    expect(screen.queryByTestId("iteration-warn")).toBeNull();
  });

  it("offers the fetched secret names in the PAT picker", async () => {
    mockGetSecretNames.mockResolvedValue(["ado_pat", "other_secret"]);
    render(<ModulesPage />);
    const pat = await screen.findByRole("combobox", { name: "PAT secret name" });

    await waitFor(() => expect(mockGetSecretNames).toHaveBeenCalled());
    fireEvent.click(pat);
    expect(
      await screen.findByRole("option", { name: "ado_pat" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "other_secret" })).toBeTruthy();
  });

  it("warns when the referenced PAT secret name is not in the store", async () => {
    mockGetSecretNames.mockResolvedValue(["other_secret"]);
    setConfig({
      org: "contoso",
      project: "Platform",
      pat_secret_ref: "missing_pat",
      watched: { assignee_mode: "any" },
    });
    render(<ModulesPage />);
    await screen.findByRole("combobox", { name: "PAT secret name" });

    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("missing_pat");
    expect(note.textContent).toContain("isn't in the secret store");
  });

  it("does not warn when the referenced PAT secret name exists", async () => {
    mockGetSecretNames.mockResolvedValue(["ado_pat"]);
    setConfig({
      org: "contoso",
      project: "Platform",
      pat_secret_ref: "ado_pat",
      watched: { assignee_mode: "any" },
    });
    render(<ModulesPage />);
    await screen.findByRole("combobox", { name: "PAT secret name" });
    await waitFor(() => expect(mockGetSecretNames).toHaveBeenCalled());

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("surfaces a load error", async () => {
    mockListModules.mockReset();
    mockListModules.mockRejectedValueOnce(new Error("nope"));
    render(<ModulesPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nope");
  });

  describe("backfill", () => {
    it("dry-runs, confirms the count, then applies and shows the result", async () => {
      mockBackfillModule
        .mockResolvedValueOnce({ candidates: 3, emitted: 0 }) // dry run
        .mockResolvedValueOnce({ candidates: 3, emitted: 3 }); // apply
      render(<ModulesPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Backfill" }));

      // Step 1: dry run, no limit.
      await waitFor(() =>
        expect(mockBackfillModule).toHaveBeenCalledWith("ado", {
          dryRun: true,
          limit: undefined,
        }),
      );
      // Confirm dialog shows the emit count.
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toContain("This will emit 3 events");

      // Step 2: apply.
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(mockBackfillModule).toHaveBeenCalledWith("ado", {
          dryRun: false,
          limit: undefined,
        }),
      );
      expect(
        (await screen.findByRole("status")).textContent,
      ).toContain("Emitted 3 of 3 candidates");
    });

    it("carries the limit into both the dry-run count and the apply", async () => {
      mockBackfillModule
        .mockResolvedValueOnce({ candidates: 5, emitted: 0 }) // dry run
        .mockResolvedValueOnce({ candidates: 5, emitted: 2 }); // apply
      render(<ModulesPage />);

      fireEvent.change(
        await screen.findByRole("spinbutton", { name: "Backfill limit" }),
        { target: { value: "2" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Backfill" }));

      await waitFor(() =>
        expect(mockBackfillModule).toHaveBeenCalledWith("ado", {
          dryRun: true,
          limit: 2,
        }),
      );
      // The count reflects the limit, not the full candidate set.
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toContain("This will emit 2 events");

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(mockBackfillModule).toHaveBeenCalledWith("ado", {
          dryRun: false,
          limit: 2,
        }),
      );
    });

    it("cancelling the confirm dialog emits nothing", async () => {
      mockBackfillModule.mockResolvedValueOnce({ candidates: 3, emitted: 0 });
      render(<ModulesPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Backfill" }));
      await screen.findByRole("dialog");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // Only the dry run ran; no apply call was made.
      expect(mockBackfillModule).toHaveBeenCalledTimes(1);
    });

    it("surfaces a backfill refusal without opening the dialog", async () => {
      mockBackfillModule.mockRejectedValueOnce(
        new Error("ado backfill requires the module to be enabled"),
      );
      render(<ModulesPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Backfill" }));
      await waitFor(() =>
        expect(
          screen.getByText(/backfill requires the module to be enabled/),
        ).toBeTruthy(),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
