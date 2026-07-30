import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listPlaybooks,
  listRunners,
  type PlaybookRecord,
} from "../playbooks";
import {
  getAnthropicModelOptions,
  getCapabilityOptions,
  getImageSuggestions,
  getSecretNames,
} from "../discovery";
import { listSnippets } from "../snippets";
import {
  subscribeChangeStream,
  type ChangeStreamHandlers,
} from "../changes";
import { ChangesProvider } from "../components/ChangesProvider";
import { PlaybooksPage } from "./PlaybooksPage";

// The page's only inputs are its data-layer calls; mock them wholesale.
vi.mock("../playbooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../playbooks")>()),
  listPlaybooks: vi.fn(),
  listRunners: vi.fn(),
}));
vi.mock("../discovery", () => ({
  getSecretNames: vi.fn(),
  getAnthropicModelOptions: vi.fn(),
  getImageSuggestions: vi.fn(),
  getCapabilityOptions: vi.fn(),
}));
vi.mock("../snippets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snippets")>()),
  listSnippets: vi.fn(),
}));
// Mock the change stream so the test can push a `playbooks` change frame.
vi.mock("../changes", () => ({
  subscribeChangeStream: vi.fn(),
}));

const mockList = vi.mocked(listPlaybooks);
const mockListRunners = vi.mocked(listRunners);
const mockGetSecretNames = vi.mocked(getSecretNames);
const mockGetModels = vi.mocked(getAnthropicModelOptions);
const mockGetImages = vi.mocked(getImageSuggestions);
const mockGetCapabilities = vi.mocked(getCapabilityOptions);
const mockListSnippets = vi.mocked(listSnippets);
const mockSubscribe = vi.mocked(subscribeChangeStream);

let handlers: ChangeStreamHandlers | null = null;

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
  playbook({ id: 1, name: "Researcher" }),
  playbook({ id: 2, name: "Triage" }),
];

beforeEach(() => {
  handlers = null;
  mockList.mockResolvedValue(PLAYBOOKS);
  mockListRunners.mockResolvedValue(["claude-code"]);
  mockGetSecretNames.mockResolvedValue([]);
  mockGetModels.mockResolvedValue([]);
  mockGetImages.mockResolvedValue([]);
  mockGetCapabilities.mockResolvedValue([]);
  mockListSnippets.mockResolvedValue([]);
  mockSubscribe.mockImplementation((h) => {
    handlers = h;
    return vi.fn();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ChangesProvider>
        <PlaybooksPage />
      </ChangesProvider>
    </FluentProvider>,
  );
}

describe("PlaybooksPage live refresh", () => {
  it("refetches when 'playbooks' fires and keeps the search input value", async () => {
    renderPage();
    await screen.findByText("Researcher");
    expect(mockList).toHaveBeenCalledTimes(1);

    // The user is mid-search: type a query into the table's search box.
    const search = screen.getByRole("searchbox", { name: "Search playbooks" });
    fireEvent.change(search, { target: { value: "Research" } });
    expect((search as HTMLInputElement).value).toBe("Research");

    // A `playbooks` change arrives on the stream: the list silently refetches.
    handlers?.onChange({ resource: "playbooks", ts: 0 });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));

    // The in-progress search value is preserved across the background refetch.
    expect((search as HTMLInputElement).value).toBe("Research");
    expect(screen.getByText("Researcher")).toBeTruthy();
  });

  it("ignores changes for an unrelated resource", async () => {
    renderPage();
    await screen.findByText("Researcher");
    expect(mockList).toHaveBeenCalledTimes(1);

    handlers?.onChange({ resource: "rules", ts: 0 });
    // Give any (unwanted) refetch a chance to fire before asserting none did.
    await Promise.resolve();
    expect(mockList).toHaveBeenCalledTimes(1);
  });
});
