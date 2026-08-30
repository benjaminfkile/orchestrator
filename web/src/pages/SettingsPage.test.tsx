import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSecret,
  getSettings,
  getSystemInfo,
  importConfig,
  listSecrets,
  postConfigExport,
  putSecret,
  putSetting,
  type ImportPlan,
} from "../settings";
import { listPlaybooks } from "../playbooks";
import { listRules } from "../rules";
import { listSnippets } from "../snippets";
import { listNotifiers } from "../notifiers";
import { getAdoMe } from "../discovery";
import { SettingsPage } from "./SettingsPage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settings")>()),
  getSystemInfo: vi.fn(),
  getSettings: vi.fn(),
  listSecrets: vi.fn(),
  putSetting: vi.fn(),
  putSecret: vi.fn(),
  deleteSecret: vi.fn(),
  postConfigExport: vi.fn(),
  importConfig: vi.fn(),
}));

vi.mock("../playbooks", () => ({ listPlaybooks: vi.fn() }));
vi.mock("../rules", () => ({ listRules: vi.fn() }));
vi.mock("../snippets", () => ({ listSnippets: vi.fn() }));
vi.mock("../notifiers", () => ({ listNotifiers: vi.fn() }));

vi.mock("../discovery", () => ({
  getAdoMe: vi.fn(),
}));

// The page registers live-refetch subscriptions that require a ChangesProvider
// in the tree. These unit tests render the page bare, so stub the hook to a
// no-op; the live-stream behavior is covered elsewhere.
vi.mock("../components/useLiveRefetch", () => ({
  useLiveRefetch: vi.fn(),
}));

const mockGetSystemInfo = vi.mocked(getSystemInfo);
const mockGetSettings = vi.mocked(getSettings);
const mockListSecrets = vi.mocked(listSecrets);
const mockPutSetting = vi.mocked(putSetting);
const mockPutSecret = vi.mocked(putSecret);
const mockDeleteSecret = vi.mocked(deleteSecret);
const mockGetAdoMe = vi.mocked(getAdoMe);
const mockPostConfigExport = vi.mocked(postConfigExport);
const mockImportConfig = vi.mocked(importConfig);
const mockListPlaybooks = vi.mocked(listPlaybooks);
const mockListRules = vi.mocked(listRules);
const mockListSnippets = vi.mocked(listSnippets);
const mockListNotifiers = vi.mocked(listNotifiers);

/** A representative import plan the mocked importConfig returns. */
function samplePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    mode: "merge",
    dry_run: true,
    applied: false,
    playbooks: [{ key: "researcher", action: "create" }],
    rules: [{ key: "bugs-to-researcher", action: "create" }],
    notifiers: [{ key: "desktop", action: "create" }],
    snippets: [{ key: "prompt:house-style", action: "create" }],
    modules: [{ key: "ado", action: "create" }],
    settings: [{ key: "default_lease_image", action: "create" }],
    missing_secrets: [{ name: "GIT_TOKEN", used_by: ["playbook:researcher"] }],
    post_import_checklist: {
      secrets_to_create: ["GIT_TOKEN"],
      identity_me: "me@example.com",
      modules_to_review: ["ado"],
      default_lease_image: "ghcr.io/example/runner:1",
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockGetSystemInfo.mockResolvedValue({
    wisperBaseUrl: "http://localhost:8080",
    wisperHostId: "host-abc",
    wisperMode: "dev",
    wisperApiKeyPresent: false,
  });
  mockGetSettings.mockResolvedValue({
    event_dedupe_cooldown_seconds: "60",
    identity_me: "me@example.com",
  });
  mockListSecrets.mockResolvedValue(["ado_pat"]);
  mockPutSetting.mockImplementation((key, value) =>
    Promise.resolve({ key, value }),
  );
  mockPutSecret.mockImplementation((key) => Promise.resolve({ key }));
  mockDeleteSecret.mockResolvedValue(undefined);
  mockGetAdoMe.mockResolvedValue({
    uniqueName: "resolved@contoso.com",
    displayName: "Resolved User",
  });
  mockPostConfigExport.mockResolvedValue({
    document: { kind: "orchestrator-config-export" },
    warnings: [],
  });
  mockListPlaybooks.mockResolvedValue([
    // Just the fields the dialog reads. The client type is broader.
    { name: "pb-a" },
    { name: "pb-b" },
  ] as never);
  mockListRules.mockResolvedValue([{ name: "r-a" }] as never);
  mockListSnippets.mockResolvedValue([
    { kind: "prompt", name: "s-a" },
  ] as never);
  mockListNotifiers.mockResolvedValue([{ name: "n-a" }] as never);
  mockImportConfig.mockImplementation((_doc, mode, dryRun) =>
    Promise.resolve(samplePlan({ mode, dry_run: dryRun, applied: !dryRun })),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPage", () => {
  it("displays the read-only host info", async () => {
    render(<SettingsPage />);
    expect(await screen.findByText("http://localhost:8080")).toBeTruthy();
    expect(screen.getByText("host-abc")).toBeTruthy();
  });

  it("shows the wisper client mode and API key presence", async () => {
    render(<SettingsPage />);
    // Mode label + value from GET /api/settings/system.
    expect(await screen.findByText("Wisper mode")).toBeTruthy();
    expect(screen.getByText("dev")).toBeTruthy();
    // Key presence is a flag only — the default fixture has it absent.
    expect(screen.getByText("Wisper API key")).toBeTruthy();
    expect(screen.getByText("not set")).toBeTruthy();
  });

  it("reports the wisper API key as set when present (never the value)", async () => {
    mockGetSystemInfo.mockResolvedValue({
      wisperBaseUrl: "http://localhost:8080",
      wisperHostId: "host-abc",
      wisperMode: "v1",
      wisperApiKeyPresent: true,
    });
    render(<SettingsPage />);
    expect(await screen.findByText("v1")).toBeTruthy();
    expect(screen.getByText("set")).toBeTruthy();
  });

  it("prefills the editable settings from the map", async () => {
    render(<SettingsPage />);
    const cooldown = (await screen.findByRole("spinbutton", {
      name: "Dedupe cooldown (seconds)",
    })) as HTMLInputElement;
    expect(cooldown.value).toBe("60");
    expect(
      (screen.getByRole("textbox", { name: "Identity (me)" }) as HTMLInputElement)
        .value,
    ).toBe("me@example.com");
  });

  it("keeps Save disabled until a setting changes, then PUTs only changed keys", async () => {
    render(<SettingsPage />);
    await screen.findByRole("spinbutton", {
      name: "Dedupe cooldown (seconds)",
    });

    const save = screen.getByRole("button", { name: "Save settings" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Dedupe cooldown (seconds)" }),
      { target: { value: "300" } },
    );
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(mockPutSetting).toHaveBeenCalledTimes(1));
    expect(mockPutSetting).toHaveBeenCalledWith(
      "event_dedupe_cooldown_seconds",
      "300",
    );
  });

  it("can edit the default lease image setting", async () => {
    render(<SettingsPage />);
    const image = (await screen.findByRole("textbox", {
      name: "Default lease image",
    })) as HTMLInputElement;
    fireEvent.change(image, { target: { value: "ghcr.io/example/img:2" } });

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(mockPutSetting).toHaveBeenCalledWith(
        "default_lease_image",
        "ghcr.io/example/img:2",
      ),
    );
  });

  it("can edit the run history retention setting", async () => {
    render(<SettingsPage />);
    const retention = (await screen.findByRole("spinbutton", {
      name: "Run history retention (max)",
    })) as HTMLInputElement;
    // The hint documents the default and the 0-disables semantics.
    expect(screen.getByText(/Default 2000/)).toBeTruthy();
    expect(screen.getByText(/0 or negative disables pruning/)).toBeTruthy();

    fireEvent.change(retention, { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(mockPutSetting).toHaveBeenCalledWith("run_retention_max", "500"),
    );
  });

  it("shows an inline callout in the Secrets section when v1 mode is missing WISPER_API_KEY", async () => {
    mockGetSystemInfo.mockResolvedValue({
      wisperBaseUrl: "http://localhost:8080",
      wisperHostId: "host-abc",
      wisperMode: "v1",
      wisperApiKeyPresent: false,
    });
    render(<SettingsPage />);
    // The callout names the secret verbatim so the user knows exactly what to add.
    const alert = await screen.findByLabelText("Wisper API key required");
    expect(within(alert).getByText("WISPER_API_KEY")).toBeTruthy();
    // Presence-only: no configured state indicator when the key is missing.
    expect(screen.queryByTestId("wisper-api-key-configured")).toBeNull();
  });

  it("shows a subtle confirmation in the Secrets section when the key is present", async () => {
    mockGetSystemInfo.mockResolvedValue({
      wisperBaseUrl: "http://localhost:8080",
      wisperHostId: "host-abc",
      wisperMode: "v1",
      wisperApiKeyPresent: true,
    });
    render(<SettingsPage />);
    const confirmation = await screen.findByTestId("wisper-api-key-configured");
    expect(confirmation.textContent).toContain("WISPER_API_KEY");
    // Value-safe: neither the callout nor confirmation ever fetches a value —
    // it only renders the flag the system endpoint exposes.
    expect(screen.queryByLabelText("Wisper API key required")).toBeNull();
  });

  it("does not show either callout in dev mode (leasing has no key requirement)", async () => {
    mockGetSystemInfo.mockResolvedValue({
      wisperBaseUrl: "http://localhost:8080",
      wisperHostId: "host-abc",
      wisperMode: "dev",
      wisperApiKeyPresent: false,
    });
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });
    expect(screen.queryByLabelText("Wisper API key required")).toBeNull();
    expect(screen.queryByTestId("wisper-api-key-configured")).toBeNull();
  });

  it("lists stored secret names", async () => {
    render(<SettingsPage />);
    const table = await screen.findByRole("table", { name: "Secrets" });
    expect(within(table).getByText("ado_pat")).toBeTruthy();
  });

  it("uses a write-only password input for the secret value", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });
    const value = screen.getByLabelText("Value") as HTMLInputElement;
    expect(value.type).toBe("password");
  });

  it("adds/updates a secret through the write-only form", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    const add = screen.getByRole("button", { name: "Add / update secret" });
    // Disabled until both a name and a value are present.
    expect((add as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "new_secret" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "s3cr3t" },
    });
    expect((add as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(add);
    await waitFor(() =>
      expect(mockPutSecret).toHaveBeenCalledWith("new_secret", "s3cr3t"),
    );
    // The value field is cleared after a successful write.
    await waitFor(() =>
      expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe(""),
    );
  });

  it("deletes a secret only after confirming", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.click(screen.getByRole("button", { name: "Delete ado_pat" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ado_pat/)).toBeTruthy();
    expect(mockDeleteSecret).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockDeleteSecret).toHaveBeenCalledWith("ado_pat"));
  });

  it("prefills identity_me from ADO but keeps the field editable", async () => {
    render(<SettingsPage />);
    const identity = (await screen.findByRole("textbox", {
      name: "Identity (me)",
    })) as HTMLInputElement;
    expect(identity.value).toBe("me@example.com");

    fireEvent.click(screen.getByRole("button", { name: "Resolve from ADO" }));
    await waitFor(() => expect(mockGetAdoMe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(identity.value).toBe("resolved@contoso.com"));

    // Still freeform: the user can type over the resolved value.
    fireEvent.change(identity, { target: { value: "hand@typed.com" } });
    expect(identity.value).toBe("hand@typed.com");

    // The resolved value is a pending change that Save persists.
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(mockPutSetting).toHaveBeenCalledWith("identity_me", "hand@typed.com"),
    );
  });

  it("falls back to displayName when ADO omits uniqueName", async () => {
    mockGetAdoMe.mockResolvedValueOnce({ displayName: "Display Only" });
    render(<SettingsPage />);
    const identity = (await screen.findByRole("textbox", {
      name: "Identity (me)",
    })) as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "Resolve from ADO" }));
    await waitFor(() => expect(identity.value).toBe("Display Only"));
  });

  it("shows an inline error when ADO resolution fails", async () => {
    mockGetAdoMe.mockRejectedValueOnce(
      new Error("ADO PAT secret is missing or unset"),
    );
    render(<SettingsPage />);
    const identity = (await screen.findByRole("textbox", {
      name: "Identity (me)",
    })) as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "Resolve from ADO" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("missing or unset");
    // The existing value is left untouched on failure.
    expect(identity.value).toBe("me@example.com");
  });

  it("surfaces a load error", async () => {
    mockGetSettings.mockReset();
    mockGetSettings.mockRejectedValueOnce(new Error("kaboom"));
    render(<SettingsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("kaboom");
  });

  it("opens the export dialog listing every group and downloads via the filtered POST", async () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.click(
      screen.getByRole("button", { name: "Export configuration" }),
    );

    // Each group shows up with a count and every entry as a checkbox.
    await screen.findByText("Playbooks (2)");
    expect(screen.getByText("Rules (1)")).toBeTruthy();
    expect(screen.getByText("Snippets (1)")).toBeTruthy();
    expect(screen.getByText("Notifiers (1)")).toBeTruthy();
    // Every entry starts checked. Uncheck one of each group.
    fireEvent.click(screen.getByRole("checkbox", { name: "pb-b" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "r-a" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "prompt: s-a" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "n-a" }));

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(mockPostConfigExport).toHaveBeenCalledWith({
        playbooks: ["pb-b"],
        rules: ["r-a"],
        snippets: ["prompt:s-a"],
        notifiers: ["n-a"],
      }),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("check-all/none per group flips every entry in that group at once", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.click(
      screen.getByRole("button", { name: "Export configuration" }),
    );

    const playbooksGroup = await screen.findByRole("group", {
      name: "Playbooks",
    });
    const pbA = within(playbooksGroup).getByRole("checkbox", {
      name: "pb-a",
    }) as HTMLInputElement;
    const pbB = within(playbooksGroup).getByRole("checkbox", {
      name: "pb-b",
    }) as HTMLInputElement;
    // Both start checked.
    expect(pbA.checked).toBe(true);
    expect(pbB.checked).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Uncheck all Playbooks" }),
    );
    expect(pbA.checked).toBe(false);
    expect(pbB.checked).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Check all Playbooks" }),
    );
    expect(pbA.checked).toBe(true);
    expect(pbB.checked).toBe(true);
  });

  it("renders response warnings before the download completes", async () => {
    mockPostConfigExport.mockResolvedValueOnce({
      document: { kind: "orchestrator-config-export" },
      warnings: [
        {
          rule: "still-here",
          kind: "dispatch",
          target: "gone",
          message: 'rule "still-here" dispatches to excluded playbook "gone"',
        },
      ],
    });
    const createObjectURL = vi.fn(() => "blob:mock");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });
    fireEvent.click(
      screen.getByRole("button", { name: "Export configuration" }),
    );
    await screen.findByText("Playbooks (2)");
    fireEvent.click(screen.getByRole("checkbox", { name: "pb-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    const warnBar = await screen.findByLabelText("Export warnings");
    expect(warnBar.textContent).toContain("still-here");
    expect(warnBar.textContent).toContain("gone");

    vi.unstubAllGlobals();
  });

  it("requires a dry-run preview before Apply is enabled", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    const preview = screen.getByRole("button", { name: "Preview import" });
    const apply = screen.getByRole("button", { name: "Apply import" });
    // Both start disabled/inactive: no document pasted, no plan previewed.
    expect((preview as HTMLButtonElement).disabled).toBe(true);
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Import document" }), {
      target: { value: '{"kind":"orchestrator-config-export"}' },
    });
    expect((preview as HTMLButtonElement).disabled).toBe(false);
    // Apply stays disabled until a plan has been previewed.
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(preview);
    await waitFor(() =>
      expect(mockImportConfig).toHaveBeenCalledWith(
        { kind: "orchestrator-config-export" },
        "merge",
        true,
      ),
    );
    // The plan is shown and Apply becomes available.
    expect(await screen.findByRole("region", { name: "Import plan" })).toBeTruthy();
    await waitFor(() =>
      expect((apply as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("shows the dry-run plan and checklist, then applies on the second click", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.change(screen.getByRole("textbox", { name: "Import document" }), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));

    const region = await screen.findByRole("region", { name: "Import plan" });
    // Dry-run banner and per-object actions render.
    expect(region.textContent).toContain("Dry-run plan");
    expect(region.textContent).toContain("researcher");
    // The missing-secrets checklist and post-import steps are present.
    expect(region.textContent).toContain("GIT_TOKEN");
    expect(region.textContent).toContain("Post-import checklist");
    expect(region.textContent).toContain("ghcr.io/example/runner:1");

    // Explicit Apply click performs the real (non-dry-run) import.
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
    await waitFor(() =>
      expect(mockImportConfig).toHaveBeenLastCalledWith({}, "merge", false),
    );
    expect(await screen.findByText("Imported")).toBeTruthy();
  });

  it("renders the Notifiers group in the dry-run plan alongside the other groups", async () => {
    // Cover every plan group so a missing render surfaces as a diff, not a silent gap.
    mockImportConfig.mockImplementationOnce((_doc, mode, dryRun) =>
      Promise.resolve(
        samplePlan({
          mode,
          dry_run: dryRun,
          applied: !dryRun,
          notifiers: [
            { key: "desktop", action: "create" },
            { key: "email-oncall", action: "overwrite" },
          ],
        }),
      ),
    );

    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.change(screen.getByRole("textbox", { name: "Import document" }), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));

    const region = await screen.findByRole("region", { name: "Import plan" });
    // The Notifiers group title carries a per-plan count like every other group.
    expect(region.textContent).toContain("Notifiers (2)");
    expect(region.textContent).toContain("desktop");
    expect(region.textContent).toContain("email-oncall");
    // Adjacent groups still render; the notifiers row is additive, not a swap.
    expect(region.textContent).toContain("Playbooks (1)");
    expect(region.textContent).toContain("Rules (1)");
    expect(region.textContent).toContain("Snippets (1)");
    expect(region.textContent).toContain("Modules (1)");
    expect(region.textContent).toContain("Settings (1)");
  });

  it("renders an empty Notifiers group when the plan has none", async () => {
    // A plan with no notifier changes still shows the group (with a 0 count) so
    // the dry-run cannot silently hide the section.
    mockImportConfig.mockImplementationOnce((_doc, mode, dryRun) =>
      Promise.resolve(
        samplePlan({ mode, dry_run: dryRun, applied: !dryRun, notifiers: [] }),
      ),
    );

    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.change(screen.getByRole("textbox", { name: "Import document" }), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));

    const region = await screen.findByRole("region", { name: "Import plan" });
    expect(region.textContent).toContain("Notifiers (0)");
  });

  it("passes overwrite mode through and re-requires a preview after a mode change", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.change(screen.getByRole("textbox", { name: "Import document" }), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByRole("region", { name: "Import plan" });

    // Switching mode invalidates the previewed plan: it disappears and Apply is
    // disabled again until a fresh preview.
    fireEvent.click(screen.getByRole("radio", { name: "Overwrite collisions" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Import plan" })).toBeNull(),
    );
    const apply = screen.getByRole("button", { name: "Apply import" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    await waitFor(() =>
      expect(mockImportConfig).toHaveBeenLastCalledWith({}, "overwrite", true),
    );
  });

  it("shows an error on malformed JSON without calling the API", async () => {
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.change(screen.getByRole("textbox", { name: "Import document" }), {
      target: { value: "{not json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("valid JSON");
    expect(mockImportConfig).not.toHaveBeenCalled();
  });

  it("surfaces a server import error (e.g. a dangling reference)", async () => {
    mockImportConfig.mockRejectedValueOnce(
      new Error('rule "x" dispatches to playbook "gone"'),
    );
    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.change(screen.getByRole("textbox", { name: "Import document" }), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("gone");
    expect(screen.queryByRole("region", { name: "Import plan" })).toBeNull();
  });
});
