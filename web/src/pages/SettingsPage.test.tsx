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
  getConfigExport,
  getSettings,
  getSystemInfo,
  importConfig,
  listSecrets,
  putSecret,
  putSetting,
  type ImportPlan,
} from "../settings";
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
  getConfigExport: vi.fn(),
  importConfig: vi.fn(),
}));

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
const mockGetConfigExport = vi.mocked(getConfigExport);
const mockImportConfig = vi.mocked(importConfig);

/** A representative import plan the mocked importConfig returns. */
function samplePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    mode: "merge",
    dry_run: true,
    applied: false,
    playbooks: [{ key: "researcher", action: "create" }],
    rules: [{ key: "bugs-to-researcher", action: "create" }],
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
  mockGetConfigExport.mockResolvedValue({ kind: "orchestrator-config-export" });
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

  it("downloads the export document via the export button", async () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    // Anchor clicks would otherwise try to navigate in jsdom.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<SettingsPage />);
    await screen.findByRole("table", { name: "Secrets" });

    fireEvent.click(
      screen.getByRole("button", { name: "Export configuration" }),
    );
    await waitFor(() => expect(mockGetConfigExport).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
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
