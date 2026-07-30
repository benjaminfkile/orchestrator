import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybookUsage,
  listPlaybooks,
  listRunners,
  updatePlaybook,
  type PlaybookRecord,
  type PlaybookUsage,
} from "../playbooks";
import {
  getAnthropicModelOptions,
  getCapabilityOptions,
  getImageSuggestions,
  getSecretNames,
  getWisperHostOptions,
} from "../discovery";
import { CLAUDE_CODE_TOOLS, NETWORK_MODES } from "../tools";
import { listSnippets, type SnippetRecord } from "../snippets";
import { PlaybooksPage } from "./PlaybooksPage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../playbooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../playbooks")>()),
  listPlaybooks: vi.fn(),
  listRunners: vi.fn(),
  createPlaybook: vi.fn(),
  updatePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  getPlaybookUsage: vi.fn(),
}));

// The drawer's pickers pull options from the discovery data layer: env
// requirements from GET /api/secrets, Model from GET /api/anthropic/models, and
// Image suggestions from GET /api/settings. (Network + allowed-tools are backed
// by shipped static lists in ../tools and need no mock.)
vi.mock("../discovery", () => ({
  getSecretNames: vi.fn(),
  getAnthropicModelOptions: vi.fn(),
  getImageSuggestions: vi.fn(),
  getCapabilityOptions: vi.fn(),
  getWisperHostOptions: vi.fn(),
}));

// The editor's snippet pickers pull saved snippets from GET /api/snippets.
vi.mock("../snippets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snippets")>()),
  listSnippets: vi.fn(),
}));

// The page registers a live-refetch subscription that requires a ChangesProvider
// in the tree. These unit tests render the page bare, so stub the hook to a
// no-op; the live-stream behavior is covered by PlaybooksPage.live.test.tsx.
vi.mock("../components/useLiveRefetch", () => ({
  useLiveRefetch: vi.fn(),
}));

const mockList = vi.mocked(listPlaybooks);
const mockListRunners = vi.mocked(listRunners);
const mockCreate = vi.mocked(createPlaybook);
const mockUpdate = vi.mocked(updatePlaybook);
const mockDelete = vi.mocked(deletePlaybook);
const mockGetUsage = vi.mocked(getPlaybookUsage);
const mockGetSecretNames = vi.mocked(getSecretNames);

/** Build a usage payload with zeroed counts and no references by default. */
function usage(overrides: Partial<PlaybookUsage> = {}): PlaybookUsage {
  return {
    dispatches: 0,
    runs: 0,
    findings: 0,
    in_flight: 0,
    referencing_rules: [],
    ...overrides,
  };
}
const mockGetModels = vi.mocked(getAnthropicModelOptions);
const mockGetImages = vi.mocked(getImageSuggestions);
const mockGetCapabilities = vi.mocked(getCapabilityOptions);
const mockGetHosts = vi.mocked(getWisperHostOptions);
const mockListSnippets = vi.mocked(listSnippets);

function snippet(
  overrides: Partial<SnippetRecord> & Pick<SnippetRecord, "id" | "kind" | "name">,
): SnippetRecord {
  return {
    description: "",
    content: "",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

const SNIPPETS: SnippetRecord[] = [
  snippet({ id: 10, kind: "prompt", name: "intro", content: "Be concise." }),
  snippet({ id: 11, kind: "prompt", name: "outro", content: "Sign off." }),
  snippet({
    id: 12,
    kind: "userdata",
    name: "provision",
    content: "apt-get install -y jq",
  }),
  snippet({ id: 13, kind: "step", name: "build", content: "npm run build" }),
];

function playbook(
  overrides: Partial<PlaybookRecord> & Pick<PlaybookRecord, "id">,
): PlaybookRecord {
  return {
    name: "pb",
    image: "img:latest",
    host: null,
    isolation: null,
    ttl_seconds: 3600,
    resources: {},
    network: "open",
    userdata_template: "",
    prompt_template: "",
    runner: "claude-code",
    runner_config: {},
    env_requirements: [],
    granted_capabilities: [],
    steps: [],
    output_kind: "findings",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

const PLAYBOOKS: PlaybookRecord[] = [
  playbook({
    id: 1,
    name: "Researcher",
    image: "ghcr.io/acme/runner:latest",
    ttl_seconds: 1800,
    network: "open",
    resources: { cpus: 2, memory_mb: 2048 },
    runner: "claude-code",
    runner_config: { model: "claude-opus-4-8", allowed_tools: ["Bash", "Read"] },
    env_requirements: ["ADO_PAT"],
    steps: [{ phase: "pre", label: "install", command_template: "npm ci" }],
    prompt_template: "Investigate {{payload.title}}",
    userdata_template: "echo {{env.ADO_PAT}}",
  }),
  playbook({ id: 2, name: "Triage", network: "none" }),
];

beforeEach(() => {
  mockList.mockResolvedValue(PLAYBOOKS);
  mockListRunners.mockResolvedValue(["claude-code", "script"]);
  mockCreate.mockResolvedValue(playbook({ id: 3 }));
  mockUpdate.mockResolvedValue(playbook({ id: 1 }));
  mockDelete.mockResolvedValue(undefined);
  mockGetUsage.mockResolvedValue(usage());
  mockListSnippets.mockResolvedValue(SNIPPETS);
  // Default to the ADO_PAT existing so the edit prefill shows no warning; tests
  // that exercise freeform / unknown names override this per-case.
  mockGetSecretNames.mockResolvedValue(["ADO_PAT"]);
  mockGetModels.mockResolvedValue([
    { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ]);
  mockGetImages.mockResolvedValue([
    { value: "setting:default_lease_image", label: "setting:default_lease_image (setting)" },
    { value: "ghcr.io/acme/default:latest" },
  ]);
  mockGetCapabilities.mockResolvedValue([
    { value: "ado.get_work_item", label: "ado.get_work_item (ado)" },
    { value: "ado.query_work_items", label: "ado.query_work_items (ado)" },
  ]);
  mockGetHosts.mockResolvedValue([
    { value: "h-linux", label: "Linux box — linux" },
    { value: "h-win", label: "Windows box — windows" },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Open the create dialog and wait for its form to mount. */
async function openCreateDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "New playbook" }));
  await screen.findByRole("textbox", { name: "Name" });
}

/**
 * Class names of injected CSS rules that cap a width against the viewport, i.e.
 * `min(<px>, <n>vw)`. The centered editor Dialog's surface caps its (max-)width
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

/** Type a freeform value into a multi-select AsyncCombobox and commit with Enter. */
function addComboTag(ariaLabel: string, value: string) {
  const input = screen.getByRole("combobox", { name: ariaLabel });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

/** Type a freeform value into a single-select AsyncCombobox and commit on blur. */
function setCombobox(ariaLabel: string, value: string) {
  const input = screen.getByRole("combobox", { name: ariaLabel });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("PlaybooksPage", () => {
  it("renders a row per playbook with image, network, ttl, and step count", async () => {
    render(<PlaybooksPage />);
    const table = await screen.findByRole("table", { name: "Playbooks" });

    const rows = within(table).getAllByRole("row");
    const first = within(rows[1]).getAllByRole("cell");
    expect(first[0].textContent).toBe("Researcher");
    expect(first[1].textContent).toBe("ghcr.io/acme/runner:latest");
    expect(first[2].textContent).toBe("open");
    expect(first[3].textContent).toBe("1800");
    expect(first[4].textContent).toBe("1");
  });

  it("starts in the loaded order, then sorts by a clicked column with a toggle + aria-sort", async () => {
    render(<PlaybooksPage />);
    const table = await screen.findByRole("table", { name: "Playbooks" });

    const nameOrder = () =>
      within(table)
        .getAllByRole("row")
        .slice(1) // drop the header row
        .map((row) => within(row).getAllByRole("cell")[0].textContent);

    // No time/id column renders, so the table keeps the backend's load order
    // (newest first) until a header is clicked — no indicator yet.
    expect(nameOrder()).toEqual(["Researcher", "Triage"]);

    // Network ascending: "none" (Triage) sorts before "open" (Researcher).
    const network = within(table).getByRole("columnheader", { name: /Network/ });
    fireEvent.click(network);
    await waitFor(() => expect(nameOrder()).toEqual(["Triage", "Researcher"]));
    expect(network.getAttribute("aria-sort")).toBe("ascending");

    // Re-clicking the active column flips it to descending.
    fireEvent.click(network);
    await waitFor(() => expect(nameOrder()).toEqual(["Researcher", "Triage"]));
    expect(network.getAttribute("aria-sort")).toBe("descending");
  });

  it("wraps the table in a horizontally scrollable container", async () => {
    render(<PlaybooksPage />);
    const table = await screen.findByRole("table", { name: "Playbooks" });
    const wrap = table.parentElement as HTMLElement;
    expect(getComputedStyle(wrap).overflowX).toBe("auto");
  });

  it("caps the editor dialog width to the viewport", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();
    // The centered Dialog surface caps its width at min(<px>, <n>vw); confirm the
    // rule is emitted and applied to the open dialog's surface element.
    const capClasses = viewportWidthClasses();
    expect(capClasses.length).toBeGreaterThan(0);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(capClasses.some((c) => dialog.classList.contains(c))).toBe(true);
  });

  it("shows the substitution hint in the dialog", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    expect(screen.getByText(/Available substitutions/)).toBeTruthy();
    expect(screen.getByText(/\{\{payload\.<path>\}\}/)).toBeTruthy();
  });

  it("requires a name and image before saving", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    // A fresh draft has no name or image → Save disabled.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Name is required")).toBeTruthy();
    expect(screen.getByText("Image is required")).toBeTruthy();
  });

  it("blocks save on a non-positive ttl", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "New" },
    });
    setCombobox("Image", "img");
    fireEvent.change(screen.getByRole("spinbutton", { name: "TTL (seconds)" }), {
      target: { value: "0" },
    });

    expect(screen.getByText("A positive integer is required")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a playbook with the fully assembled payload", async () => {
    // Empty store so a typed env name commits as a freeform value.
    mockGetSecretNames.mockResolvedValue([]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "  My playbook  " },
    });
    setCombobox("Image", "img:1");
    // The Host picker commits its value into the payload as playbook.host.
    setCombobox("Host", "h-linux");
    fireEvent.change(screen.getByRole("spinbutton", { name: "TTL (seconds)" }), {
      target: { value: "900" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "CPUs" }), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Memory (MB)" }), {
      target: { value: "512" },
    });
    setCombobox("Model", "claude-opus-4-8");

    // Allowed tools + env requirements are both freeform multi-select pickers;
    // typed values commit with Enter. ("custom-tool" is not in the curated list,
    // so it exercises the freeform path deterministically.)
    addComboTag("Allowed tools", "custom-tool");
    addComboTag("Env requirements", "ADO_PAT");

    // Add a step and fill it in.
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Step 1 phase" }), {
      target: { value: "collect" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Step 1 label" }), {
      target: { value: "gather" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Step 1 command" }), {
      target: { value: "cat out.txt" },
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt template" }), {
      target: { value: "Do {{payload.title}}" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Userdata template" }),
      { target: { value: "setup {{env.ADO_PAT}}" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      name: "My playbook",
      image: "img:1",
      host: "h-linux",
      isolation: null,
      ttl_seconds: 900,
      resources: { cpus: 2, memory_mb: 512 },
      network: "open",
      runner: "claude-code",
      runner_config: {
        model: "claude-opus-4-8",
        allowed_tools: ["custom-tool"],
      },
      env_requirements: ["ADO_PAT"],
      granted_capabilities: [],
      steps: [{ phase: "collect", label: "gather", command_template: "cat out.txt" }],
      prompt_template: "Do {{payload.title}}",
      userdata_template: "setup {{env.ADO_PAT}}",
    });
  });

  it("sends an empty runner_config when model and allowed_tools are left empty", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Bare" },
    });
    setCombobox("Image", "img");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      name: "Bare",
      image: "img",
      // No host chosen → cleared to the configured default.
      host: null,
      // No isolation chosen → cleared to the server default.
      isolation: null,
      ttl_seconds: 3600,
      resources: {},
      network: "open",
      runner: "claude-code",
      runner_config: {},
      env_requirements: [],
      granted_capabilities: [],
      steps: [],
      prompt_template: "",
      userdata_template: "",
    });
  });

  it("edits an existing playbook, prefilling the form and PATCHing it", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const name = (await screen.findByRole("textbox", {
      name: "Name",
    })) as HTMLInputElement;
    expect(name.value).toBe("Researcher");
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Image" }) as HTMLInputElement)
          .value,
      ).toBe("ghcr.io/acme/runner:latest"),
    );
    expect(
      (screen.getByRole("spinbutton", { name: "CPUs" }) as HTMLInputElement)
        .value,
    ).toBe("2");
    expect(
      (screen.getByRole("textbox", { name: "Prompt template" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Investigate {{payload.title}}");
    // Existing tag values are prefilled and rendered.
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("ADO_PAT")).toBeTruthy();

    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const [id, patch] = mockUpdate.mock.calls[0];
    expect(id).toBe(1);
    expect(patch.name).toBe("Renamed");
    expect(patch.runner).toBe("claude-code");
    expect(patch.runner_config).toEqual({
      model: "claude-opus-4-8",
      allowed_tools: ["Bash", "Read"],
    });
    expect(patch.steps).toEqual([
      { phase: "pre", label: "install", command_template: "npm ci" },
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("prefills the Host picker from the record and round-trips it on save", async () => {
    // A playbook pinned to a specific host: the editor must load it into the
    // Host picker (labelled with the host's os) and carry it back on PATCH.
    mockList.mockResolvedValue([
      playbook({ id: 7, name: "Pinned", host: "h-win" }),
    ]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await screen.findByRole("textbox", { name: "Name" });

    // The Host picker is backed by GET /api/wisper/hosts; the stored selector is
    // prefilled and relabelled with its os once the option list loads.
    await waitFor(() => expect(mockGetHosts).toHaveBeenCalled());
    const host = screen.getByRole("combobox", { name: "Host" }) as HTMLInputElement;
    await waitFor(() => expect(host.value).toBe("Windows box — windows"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const [id, patch] = mockUpdate.mock.calls[0];
    expect(id).toBe(7);
    // The stored host is carried through unchanged.
    expect(patch.host).toBe("h-win");
  });

  it("stores a typed Host selector on the created playbook", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Hosted" },
    });
    setCombobox("Image", "img");
    // The picker is freeform: a host id not (yet) in the fetched list still
    // commits verbatim as playbook.host.
    setCombobox("Host", "custom-host");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0].host).toBe("custom-host");
  });

  it("stores the chosen isolation level on the created playbook", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Isolated" },
    });
    setCombobox("Image", "img");
    fireEvent.change(screen.getByRole("combobox", { name: "Isolation" }), {
      target: { value: "vm" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0].isolation).toBe("vm");
  });

  it("prefills the Isolation dropdown from the record and round-trips it", async () => {
    mockList.mockResolvedValue([
      playbook({ id: 9, name: "Pinned", isolation: "sandboxed" }),
    ]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await screen.findByRole("textbox", { name: "Name" });
    const isolation = screen.getByRole("combobox", {
      name: "Isolation",
    }) as HTMLSelectElement;
    expect(isolation.value).toBe("sandboxed");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0][1].isolation).toBe("sandboxed");
  });

  it("clears playbook.host to null when the Host picker is emptied", async () => {
    mockList.mockResolvedValue([
      playbook({ id: 8, name: "Pinned", host: "h-win" }),
    ]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await screen.findByRole("textbox", { name: "Name" });
    const host = screen.getByRole("combobox", { name: "Host" }) as HTMLInputElement;
    await waitFor(() => expect(host.value).toBe("Windows box — windows"));

    // Emptying the field commits a blank, which the payload sends as null
    // (clear back to the configured default host).
    setCombobox("Host", "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0][1].host).toBeNull();
  });

  it("warns with the cascade counts and deletes only after confirming", async () => {
    mockGetUsage.mockResolvedValue(
      usage({ dispatches: 4, runs: 4, findings: 9 }),
    );
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    const dialog = await screen.findByRole("dialog");
    // The dialog fetches /usage for THIS playbook and spells out what will go.
    await waitFor(() => expect(mockGetUsage).toHaveBeenCalledWith(1));
    await within(dialog).findByText(/and its run history/i);
    expect(within(dialog).getByText(/4 dispatches/)).toBeTruthy();
    expect(within(dialog).getByText(/9 findings/)).toBeTruthy();
    expect(mockDelete).not.toHaveBeenCalled();

    const confirm = await within(dialog).findByRole("button", {
      name: "Delete playbook + history",
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(1));
  });

  it("lists referencing rules that will stop dispatching", async () => {
    mockGetUsage.mockResolvedValue(
      usage({
        dispatches: 1,
        runs: 1,
        findings: 0,
        referencing_rules: [
          { id: 10, name: "Nightly triage" },
          { id: 11, name: "PR builds" },
        ],
      }),
    );
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    const dialog = await screen.findByRole("dialog");

    await within(dialog).findByText(/stop dispatching it/i);
    expect(within(dialog).getByText("Nightly triage")).toBeTruthy();
    expect(within(dialog).getByText("PR builds")).toBeTruthy();
    // Confirm is still enabled — referencing rules do not block a delete.
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Delete playbook + history",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("disables confirm and explains when dispatches are in flight", async () => {
    mockGetUsage.mockResolvedValue(
      usage({ dispatches: 5, runs: 5, findings: 3, in_flight: 2 }),
    );
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    const dialog = await screen.findByRole("dialog");

    await within(dialog).findByText(/still in flight/i);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Delete playbook + history",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("surfaces a racing 409 in-flight error inline", async () => {
    mockDelete.mockRejectedValueOnce(
      new ApiError("playbook has 1 in-flight dispatches", 409),
    );

    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    const dialog = await screen.findByRole("dialog");
    const confirm = await within(dialog).findByRole("button", {
      name: "Delete playbook + history",
    });
    fireEvent.click(confirm);

    // The dialog stays open and shows a friendly, actionable message rather
    // than the raw error; the confirm button is replaced by a Close action.
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("in-flight dispatches");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", {
        name: "Delete playbook + history",
      }),
    ).toBeNull();
  });

  it("backs Model/Network/Image/allowed-tools with pickers, all freeform", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    // Model + Image pickers fetch their suggestions from the data layer;
    // Network + allowed-tools use shipped static lists (no fetch).
    await waitFor(() => expect(mockGetModels).toHaveBeenCalled());
    await waitFor(() => expect(mockGetImages).toHaveBeenCalled());

    // All four fields are now comboboxes rather than plain inputs.
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Network" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Image" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Allowed tools" })).toBeTruthy();

    // Opening a dropdown inside the modal Dialog renders inline (inlinePopup) and
    // must NOT blank the surface — the dialog and its form stay on screen.
    // (Portaling the listbox to <body> was a real bug that hid the whole form.)
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    expect(
      await screen.findByRole("option", { name: "Claude Opus 4.8" }),
    ).toBeTruthy();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();

    // Network defaults to the "open" enum value.
    expect(
      (screen.getByRole("combobox", { name: "Network" }) as HTMLInputElement)
        .value,
    ).toBe("open");

    // The allowed-tools + network pickers are backed by shipped static lists.
    expect(NETWORK_MODES).toEqual(["open", "none"]);
    expect(CLAUDE_CODE_TOOLS).toEqual(
      expect.arrayContaining(["Bash", "Read", "Edit", "Write", "Grep"]),
    );

    // Freeform is preserved everywhere: a model id not in the fetched list, a
    // tool not in the curated static list, and the image sentinel all commit.
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Freeformed" },
    });
    setCombobox("Image", "setting:default_lease_image");
    setCombobox("Model", "custom-model-1");
    addComboTag("Allowed tools", "CustomTool");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.runner_config).toEqual({
      model: "custom-model-1",
      allowed_tools: ["CustomTool"],
    });
    expect(payload.image).toBe("setting:default_lease_image");
    expect(payload.network).toBe("open");
  });

  it("feeds the env-requirements picker from GET /api/secrets", async () => {
    mockGetSecretNames.mockResolvedValue(["ADO_PAT", "OTHER_SECRET"]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    // The multi-select picker loads its options from the secrets endpoint on
    // mount, and env-requirements is now a combobox rather than a plain input.
    await waitFor(() => expect(mockGetSecretNames).toHaveBeenCalled());
    expect(
      screen.getByRole("combobox", { name: "Env requirements" }),
    ).toBeTruthy();
    // No warning for a store that already contains the (here empty) requirements.
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("grants capabilities with an optional JSON config, persisted as granted_capabilities", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    // The picker loads its option list from GET /api/capabilities on mount.
    await waitFor(() => expect(mockGetCapabilities).toHaveBeenCalled());
    expect(
      screen.getByRole("combobox", { name: "Granted capabilities" }),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Grants" },
    });
    setCombobox("Image", "img");

    // Grant two capabilities via the freeform multi-select. (Selecting a listed
    // option isn't drivable here — Fluent's multi-select popup doesn't open under
    // jsdom — but the picker's freeform path is the same commit path, and the
    // option list itself is exercised in discovery.test.ts.)
    addComboTag("Granted capabilities", "custom.query");
    addComboTag("Granted capabilities", "custom.other");

    // Give the first one a JSON config; leave the second one config-less.
    fireEvent.change(
      screen.getByRole("textbox", { name: "custom.query config" }),
      { target: { value: '{ "org": "contoso" }' } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0].granted_capabilities).toEqual([
      { capability_id: "custom.query", config: { org: "contoso" } },
      { capability_id: "custom.other" },
    ]);
  });

  it("blocks save on an invalid capability config JSON", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "BadConfig" },
    });
    setCombobox("Image", "img");
    addComboTag("Granted capabilities", "custom.query");

    fireEvent.change(
      screen.getByRole("textbox", { name: "custom.query config" }),
      { target: { value: "{ not json" } },
    );

    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // A JSON array is a valid parse but not an object → still rejected.
    fireEvent.change(
      screen.getByRole("textbox", { name: "custom.query config" }),
      { target: { value: "[1, 2]" } },
    );
    expect(screen.getByText("Config must be a JSON object")).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("prefills granted capabilities and their config when editing", async () => {
    mockList.mockResolvedValue([
      playbook({
        id: 5,
        name: "Granted",
        granted_capabilities: [
          { capability_id: "ado.get_work_item", config: { org: "contoso" } },
          { capability_id: "custom.capability" },
        ],
      }),
    ]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Name" });

    // Both grants are rendered as tags; the configured one prefills its JSON.
    const config = (await screen.findByRole("textbox", {
      name: "ado.get_work_item config",
    })) as HTMLTextAreaElement;
    expect(JSON.parse(config.value)).toEqual({ org: "contoso" });
    const bare = screen.getByRole("textbox", {
      name: "custom.capability config",
    }) as HTMLTextAreaElement;
    expect(bare.value).toBe("");
  });

  it("warns on an env requirement that is not in the secret store", async () => {
    // Edit a playbook whose env requirement (ADO_PAT) is absent from the store.
    mockGetSecretNames.mockResolvedValue(["OTHER_SECRET"]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await screen.findByRole("textbox", { name: "Name" });

    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("ADO_PAT");
    expect(note.textContent).toContain("Not yet in the secret store");
  });

  it("populates the runner picker from GET /api/runners, defaulting to claude-code", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    await waitFor(() => expect(mockListRunners).toHaveBeenCalled());
    const runner = screen.getByRole("combobox", {
      name: "Runner",
    }) as HTMLSelectElement;
    // Defaults to claude-code, and every fetched id is an option.
    expect(runner.value).toBe("claude-code");
    const optionValues = within(runner)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).toEqual(["claude-code", "script"]);

    // claude-code shows its model/allowed-tools config, not the script/raw forms.
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Allowed tools" })).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Command template" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Runner config" })).toBeNull();
  });

  it("shows the script runner's command form and saves runner + runner_config", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Scripted" },
    });
    setCombobox("Image", "img");

    fireEvent.change(screen.getByRole("combobox", { name: "Runner" }), {
      target: { value: "script" },
    });

    // The claude-code fields are gone; the script command textarea is shown, and
    // the prompt template is now labelled optional.
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Allowed tools" }),
    ).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Prompt template (optional)" }),
    ).toBeTruthy();
    const command = screen.getByRole("textbox", { name: "Command template" });
    fireEvent.change(command, {
      target: { value: "curl -sf {{payload.url}} > out.txt" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.runner).toBe("script");
    expect(payload.runner_config).toEqual({
      command_template: "curl -sf {{payload.url}} > out.txt",
    });
  });

  it("falls back to a raw JSON editor for an unknown runner and validates it", async () => {
    mockListRunners.mockResolvedValue(["claude-code", "script", "custom-runner"]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();
    await waitFor(() => expect(mockListRunners).toHaveBeenCalled());

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Custom" },
    });
    setCombobox("Image", "img");
    fireEvent.change(screen.getByRole("combobox", { name: "Runner" }), {
      target: { value: "custom-runner" },
    });

    // Neither built-in form renders; the raw JSON fallback does.
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Command template" }),
    ).toBeNull();
    const raw = screen.getByRole("textbox", { name: "Runner config" });

    // Invalid JSON blocks save and shows an inline error.
    fireEvent.change(raw, { target: { value: "{ not json" } });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();

    // A valid JSON object commits verbatim as the opaque runner_config.
    fireEvent.change(raw, { target: { value: '{ "endpoint": "https://x" }' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.runner).toBe("custom-runner");
    expect(payload.runner_config).toEqual({ endpoint: "https://x" });
  });

  it("prefills the script runner's command template when editing", async () => {
    mockList.mockResolvedValue([
      playbook({
        id: 7,
        name: "Scripted",
        runner: "script",
        runner_config: { command_template: "make build" },
      }),
    ]);
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Name" });

    expect(
      (screen.getByRole("combobox", { name: "Runner" }) as HTMLSelectElement)
        .value,
    ).toBe("script");
    const command = (await screen.findByRole("textbox", {
      name: "Command template",
    })) as HTMLTextAreaElement;
    expect(command.value).toBe("make build");
  });

  it("inserts a prompt snippet as a {{snippet.<name>}} token at the caret", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    const prompt = screen.getByRole("textbox", {
      name: "Prompt template",
    }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "AB" } });
    // Place the caret between A and B so the token must splice, not append.
    prompt.setSelectionRange(1, 1);

    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "intro" }));

    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", {
          name: "Prompt template",
        }) as HTMLTextAreaElement).value,
      ).toBe("A{{snippet.intro}}B"),
    );
  });

  // Regression for #379: the Insert-snippet menu used to portal its popup to
  // <body>, outside the modal Dialog's surface. The dialog's focus trap treated
  // that as a dismissal and blanked the whole editor. With `<Menu inline>` the
  // popup stays in the dialog DOM, so opening it (and picking an item) must
  // leave the form mounted and the dialog open.
  it("keeps the editor dialog open when the snippet menu is used", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    const prompt = screen.getByRole("textbox", {
      name: "Prompt template",
    }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "hi" } });
    prompt.setSelectionRange(2, 2);

    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }));

    // The menu opened AND the dialog's form content is still in the document.
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual(["intro", "outro"]);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Prompt template" })).toBeTruthy();

    // Picking a name splices the token and the dialog stays open (the Name
    // field is still there to prove the surface didn't unmount).
    fireEvent.click(screen.getByRole("menuitem", { name: "outro" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", {
          name: "Prompt template",
        }) as HTMLTextAreaElement).value,
      ).toBe("hi{{snippet.outro}}"),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
  });

  it("stores a whole userdata snippet reference and previews its content", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "PB" },
    });
    setCombobox("Image", "img:1");

    fireEvent.change(screen.getByRole("combobox", { name: "Userdata source" }), {
      target: { value: "snippet:provision" },
    });

    // The textarea flips to a read-only preview of the referenced snippet.
    const preview = screen.getByRole("textbox", {
      name: "Userdata template",
    }) as HTMLTextAreaElement;
    expect(preview.readOnly).toBe(true);
    expect(preview.value).toBe("apt-get install -y jq");
    expect(screen.getByText(/edit it on the snippets page/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0].userdata_template).toBe(
      "snippet:provision",
    );
  });

  it("restores inline userdata editing when switching back to Custom", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    const source = screen.getByRole("combobox", { name: "Userdata source" });
    fireEvent.change(source, { target: { value: "snippet:provision" } });
    expect(
      (screen.getByRole("textbox", {
        name: "Userdata template",
      }) as HTMLTextAreaElement).readOnly,
    ).toBe(true);

    fireEvent.change(source, { target: { value: "custom" } });
    const editable = screen.getByRole("textbox", {
      name: "Userdata template",
    }) as HTMLTextAreaElement;
    expect(editable.readOnly).toBe(false);
    // The cleared textarea is editable again.
    fireEvent.change(editable, { target: { value: "echo hi" } });
    expect(
      (screen.getByRole("textbox", {
        name: "Userdata template",
      }) as HTMLTextAreaElement).value,
    ).toBe("echo hi");
  });

  it("references a whole step snippet from a step row's command source", async () => {
    render(<PlaybooksPage />);
    await screen.findByRole("table", { name: "Playbooks" });
    await openCreateDrawer();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "PB" },
    });
    setCombobox("Image", "img:1");

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Step 1 command source" }),
      { target: { value: "snippet:build" } },
    );

    // The command flips to a read-only preview; the label stays editable.
    const cmd = screen.getByRole("textbox", {
      name: "Step 1 command",
    }) as HTMLTextAreaElement;
    expect(cmd.readOnly).toBe(true);
    expect(cmd.value).toBe("npm run build");
    fireEvent.change(screen.getByRole("textbox", { name: "Step 1 label" }), {
      target: { value: "compile" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0].steps).toEqual([
      { phase: "pre", label: "compile", command_template: "snippet:build" },
    ]);
  });
});
