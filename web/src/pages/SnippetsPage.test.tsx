import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
  type SnippetRecord,
} from "../snippets";
import { SnippetsPage } from "./SnippetsPage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../snippets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snippets")>()),
  listSnippets: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
}));
// The page registers a live-refetch subscription that requires a ChangesProvider
// in the tree. These unit tests render the page bare, so stub the hook to a
// no-op; the live-stream wiring is covered by useLiveRefetch.test.tsx.
vi.mock("../components/useLiveRefetch", () => ({
  useLiveRefetch: vi.fn(),
}));

const mockList = vi.mocked(listSnippets);
const mockCreate = vi.mocked(createSnippet);
const mockUpdate = vi.mocked(updateSnippet);
const mockDelete = vi.mocked(deleteSnippet);

function snippet(
  overrides: Partial<SnippetRecord> & Pick<SnippetRecord, "id">,
): SnippetRecord {
  return {
    kind: "prompt",
    name: "snippet",
    description: "",
    content: "hello",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

const SNIPPETS: SnippetRecord[] = [
  snippet({ id: 1, kind: "prompt", name: "Greeting", description: "A hello" }),
  snippet({ id: 2, kind: "prompt", name: "Signoff", description: "A goodbye" }),
  snippet({
    id: 3,
    kind: "userdata",
    name: "Provision",
    content: "apt-get install -y jq",
  }),
  snippet({ id: 4, kind: "step", name: "Build", content: "npm run build" }),
];

beforeEach(() => {
  mockList.mockResolvedValue(SNIPPETS);
  mockCreate.mockResolvedValue(snippet({ id: 5 }));
  mockUpdate.mockImplementation((id, patch) =>
    Promise.resolve(snippet({ id, ...patch })),
  );
  mockDelete.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function openCreateDialog() {
  fireEvent.click(screen.getByRole("button", { name: "New snippet" }));
  await screen.findByRole("textbox", { name: "Name" });
}

describe("SnippetsPage", () => {
  it("shows only the active kind's snippets, scoped by the kind filter", async () => {
    render(<SnippetsPage />);
    const table = await screen.findByRole("table", { name: "Snippets" });
    // Default tab is Prompts: the two prompt snippets, not the userdata/step ones.
    expect(within(table).getByText("Greeting")).toBeTruthy();
    expect(within(table).getByText("Signoff")).toBeTruthy();
    expect(within(table).queryByText("Provision")).toBeNull();
    expect(within(table).queryByText("Build")).toBeNull();

    // Switch to Userdata: now only the userdata snippet shows.
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), {
      target: { value: "userdata" },
    });
    await waitFor(() =>
      expect(screen.getByText("Provision")).toBeTruthy(),
    );
    expect(screen.queryByText("Greeting")).toBeNull();
  });

  it("creates a snippet with the active kind from the dialog fields", async () => {
    render(<SnippetsPage />);
    await screen.findByRole("table", { name: "Snippets" });

    // Create under the Steps tab, so the created snippet's kind is "step".
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), {
      target: { value: "step" },
    });
    await openCreateDialog();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "  Test  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "run the tests" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "npm test" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      kind: "step",
      name: "Test",
      description: "run the tests",
      content: "npm test",
    });
  });

  it("blocks save until both name and content are provided", async () => {
    render(<SnippetsPage />);
    await screen.findByRole("table", { name: "Snippets" });
    await openCreateDialog();

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Named" },
    });
    // Name alone is not enough — content is still required.
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "body" },
    });
    expect(save.disabled).toBe(false);
  });

  it("prefills the editor from an existing snippet and updates it", async () => {
    render(<SnippetsPage />);
    await screen.findByRole("table", { name: "Snippets" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const name = (await screen.findByRole("textbox", {
      name: "Name",
    })) as HTMLInputElement;
    expect(name.value).toBe("Greeting");
    expect(
      (screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement)
        .value,
    ).toBe("hello");

    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "hi there" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(1, {
      name: "Greeting",
      description: "A hello",
      content: "hi there",
    });
  });

  it("warns that referencing playbooks fail loudly before deleting", async () => {
    render(<SnippetsPage />);
    await screen.findByRole("table", { name: "Snippets" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText(/Greeting/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/fail loudly/i)).toBeTruthy();
    expect(mockDelete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(1));
  });

  it("filters the visible rows by the search box", async () => {
    render(<SnippetsPage />);
    await screen.findByRole("table", { name: "Snippets" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search snippets" }), {
      target: { value: "goodbye" },
    });
    await waitFor(() => expect(screen.queryByText("Greeting")).toBeNull());
    expect(screen.getByText("Signoff")).toBeTruthy();
  });

  it("truncates the name and description cells with a hover title via the shared style", async () => {
    render(<SnippetsPage />);
    const table = await screen.findByRole("table", { name: "Snippets" });

    // Griffel emits one atomic class per property; the shared truncate style's
    // three rules become three such classes. Ignore the base `fui-*` component
    // class and the `___`-prefixed makeStyles sequence hash (which differs once
    // mergeClasses recombines styles) — the atomic tokens are what's shared.
    const atomicClasses = (el: Element): string[] =>
      el.className
        .split(" ")
        .filter((c) => c && !c.startsWith("fui-") && !c.startsWith("___"));

    // The name cell clips long content to one line (the shared truncate atomics)
    // and exposes the full value on hover via `title`.
    const nameCell = within(table).getByText("Greeting").closest("td");
    expect(nameCell).not.toBeNull();
    expect(nameCell!.getAttribute("title")).toBe("Greeting");
    const truncateClasses = atomicClasses(nameCell!);
    expect(truncateClasses.length).toBeGreaterThan(0);

    // The description cell carries the SAME shared truncate atomics (plus its own
    // muted-color class) and its own hover title.
    const descCell = within(table).getByText("A hello").closest("td");
    expect(descCell).not.toBeNull();
    expect(descCell!.getAttribute("title")).toBe("A hello");
    const descClasses = atomicClasses(descCell!);
    for (const cls of truncateClasses) {
      expect(descClasses).toContain(cls);
    }
  });

  it("surfaces a load error", async () => {
    mockList.mockReset();
    mockList.mockRejectedValueOnce(new Error("boom"));
    render(<SnippetsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});
