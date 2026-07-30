import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNotifier,
  deleteNotifier,
  listNotifiers,
  updateNotifier,
  type NotifierRecord,
} from "../notifiers";
import { NotifiersPage } from "./NotifiersPage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../notifiers", () => ({
  listNotifiers: vi.fn(),
  createNotifier: vi.fn(),
  updateNotifier: vi.fn(),
  deleteNotifier: vi.fn(),
}));

const mockList = vi.mocked(listNotifiers);
const mockCreate = vi.mocked(createNotifier);
const mockUpdate = vi.mocked(updateNotifier);
const mockDelete = vi.mocked(deleteNotifier);

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
  notifier({ id: 1, name: "First alert" }),
  notifier({
    id: 2,
    name: "Second alert",
    enabled: false,
    title_template: "{{event.type}}",
  }),
];

beforeEach(() => {
  mockList.mockResolvedValue(NOTIFIERS);
  mockCreate.mockResolvedValue(notifier({ id: 3 }));
  mockUpdate.mockImplementation((id, patch) =>
    Promise.resolve(notifier({ id, ...patch })),
  );
  mockDelete.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function openCreateDialog() {
  fireEvent.click(screen.getByRole("button", { name: "New notifier" }));
  await screen.findByRole("textbox", { name: "Name" });
}

describe("NotifiersPage", () => {
  it("renders a row per notifier with its name and enabled state", async () => {
    render(<NotifiersPage />);
    const table = await screen.findByRole("table", { name: "Notifiers" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByText("First alert")).toBeTruthy();
    expect(
      (within(rows[1]).getByRole("switch") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(rows[2]).getByRole("switch") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("has no kind selector or URL template field: a notification is just a notification", async () => {
    render(<NotifiersPage />);
    await screen.findByRole("table", { name: "Notifiers" });
    await openCreateDialog();

    expect(screen.queryByRole("combobox", { name: "Kind" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "URL template" })).toBeNull();
  });

  it("creates a notifier from the title/body templates", async () => {
    render(<NotifiersPage />);
    await screen.findByRole("table", { name: "Notifiers" });
    await openCreateDialog();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "  My alert  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Title template" }), {
      target: { value: "{{event.type}}" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      name: "My alert",
      title_template: "{{event.type}}",
      body_template: "",
      enabled: true,
    });
  });

  it("blocks save until a name is provided", async () => {
    render(<NotifiersPage />);
    await screen.findByRole("table", { name: "Notifiers" });
    await openCreateDialog();

    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Name is required")).toBeTruthy();
  });

  it("prefills the editor from an existing notifier", async () => {
    render(<NotifiersPage />);
    await screen.findByRole("table", { name: "Notifiers" });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    const name = (await screen.findByRole("textbox", {
      name: "Name",
    })) as HTMLInputElement;
    expect(name.value).toBe("Second alert");
    expect(
      (screen.getByRole("textbox", {
        name: "Title template",
      }) as HTMLInputElement).value,
    ).toBe("{{event.type}}");
  });

  it("toggles a notifier's enabled flag via the API", async () => {
    render(<NotifiersPage />);
    const table = await screen.findByRole("table", { name: "Notifiers" });
    const rows = within(table).getAllByRole("row");

    fireEvent.click(within(rows[1]).getByRole("switch"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(1, { enabled: false }),
    );
  });

  it("deletes a notifier only after confirming", async () => {
    render(<NotifiersPage />);
    await screen.findByRole("table", { name: "Notifiers" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/First alert/)).toBeTruthy();
    expect(mockDelete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(1));
  });

  it("surfaces a load error", async () => {
    mockList.mockReset();
    mockList.mockRejectedValueOnce(new Error("boom"));
    render(<NotifiersPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});
