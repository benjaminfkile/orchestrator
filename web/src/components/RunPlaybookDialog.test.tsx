import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { createDispatch } from "../dispatches";
import { materializeWorkItem, searchWorkItems } from "../discovery";
import { listPlaybooks } from "../playbooks";
import { RunPlaybookDialog } from "./RunPlaybookDialog";

// Mock the three data-layer modules the dialog touches.
vi.mock("../dispatches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dispatches")>()),
  createDispatch: vi.fn(),
}));
vi.mock("../discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../discovery")>()),
  searchWorkItems: vi.fn(),
  materializeWorkItem: vi.fn(),
}));
vi.mock("../playbooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../playbooks")>()),
  listPlaybooks: vi.fn(),
}));

const mockCreateDispatch = vi.mocked(createDispatch);
const mockSearchWorkItems = vi.mocked(searchWorkItems);
const mockMaterializeWorkItem = vi.mocked(materializeWorkItem);
const mockListPlaybooks = vi.mocked(listPlaybooks);

const ROW = {
  id: 42,
  title: "Login broken",
  work_item_type: "Bug",
  state: "Active",
  area_path: "Alpha\\Web",
  iteration_path: "Alpha\\Sprint 1",
  assignee: "ada@contoso.com",
  url: "https://dev.azure.com/contoso/Alpha/_workitems/edit/42",
};

const PLAYBOOKS = [
  { id: 5, name: "Researcher" },
  { id: 6, name: "Reviewer" },
  // The picker only reads id/name; the rest of the record is irrelevant here.
] as unknown as Awaited<ReturnType<typeof listPlaybooks>>;

beforeEach(() => {
  mockListPlaybooks.mockResolvedValue(PLAYBOOKS);
  mockSearchWorkItems.mockResolvedValue([ROW]);
  mockMaterializeWorkItem.mockResolvedValue({ id: 100 } as Awaited<
    ReturnType<typeof materializeWorkItem>
  >);
  mockCreateDispatch.mockResolvedValue({ id: 9 } as Awaited<
    ReturnType<typeof createDispatch>
  >);
});

afterEach(() => vi.clearAllMocks());

describe("RunPlaybookDialog — search mode (Queue)", () => {
  it("searches, selects a work item, picks a playbook, and runs", async () => {
    const onDispatched = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <RunPlaybookDialog
        open
        onOpenChange={onOpenChange}
        onDispatched={onDispatched}
      />,
    );

    // Wait for the playbook list to load into the picker.
    await screen.findByRole("option", { name: "Researcher" });

    // Debounced search fires after typing.
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search work items" }),
      { target: { value: "login" } },
    );
    await waitFor(() =>
      expect(mockSearchWorkItems).toHaveBeenCalledWith("login"),
    );

    // Pick the result and a playbook.
    const radio = await screen.findByRole("radio", { name: /Login broken/ });
    fireEvent.click(radio);
    fireEvent.change(screen.getByRole("combobox", { name: "Playbook" }), {
      target: { value: "5" },
    });

    const run = screen.getByRole("button", { name: "Run" });
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(run);

    // Materialize the work item, then dispatch on the returned event id.
    await waitFor(() =>
      expect(mockMaterializeWorkItem).toHaveBeenCalledWith(42),
    );
    await waitFor(() => expect(mockCreateDispatch).toHaveBeenCalledWith(100, 5));
    expect(onDispatched).toHaveBeenCalledWith({ id: 9 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps Run disabled until both a work item and a playbook are chosen", async () => {
    render(<RunPlaybookDialog open onOpenChange={vi.fn()} />);
    await screen.findByRole("option", { name: "Researcher" });

    // No selection yet: Run is disabled.
    expect(
      (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // A playbook alone is not enough without a work item.
    fireEvent.change(screen.getByRole("combobox", { name: "Playbook" }), {
      target: { value: "5" },
    });
    expect(
      (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("RunPlaybookDialog — event mode (Events)", () => {
  it("dispatches on the existing event with no materialize step", async () => {
    const onDispatched = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <RunPlaybookDialog
        open
        event={{ id: 3, label: "ado.workitem 42" }}
        onOpenChange={onOpenChange}
        onDispatched={onDispatched}
      />,
    );

    // No work-item search in event mode.
    expect(
      screen.queryByRole("textbox", { name: "Search work items" }),
    ).toBeNull();

    fireEvent.change(
      await screen.findByRole("combobox", { name: "Playbook" }),
      { target: { value: "6" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(mockCreateDispatch).toHaveBeenCalledWith(3, 6));
    expect(mockMaterializeWorkItem).not.toHaveBeenCalled();
    expect(onDispatched).toHaveBeenCalledWith({ id: 9 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a backend error and keeps the dialog open", async () => {
    mockCreateDispatch.mockRejectedValueOnce(
      new ApiError("event not found", 404),
    );
    const onOpenChange = vi.fn();
    render(
      <RunPlaybookDialog
        open
        event={{ id: 3 }}
        onOpenChange={onOpenChange}
        onDispatched={vi.fn()}
      />,
    );

    fireEvent.change(
      await screen.findByRole("combobox", { name: "Playbook" }),
      { target: { value: "5" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("event not found");
    // The dialog was not asked to close on failure.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
