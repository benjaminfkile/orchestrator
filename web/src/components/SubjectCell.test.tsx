import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SubjectFields } from "../dispatches";
import { SubjectCell } from "./SubjectCell";

/** Build a full SubjectFields block; every field defaults to null. */
function fields(overrides: Partial<SubjectFields> = {}): SubjectFields {
  return {
    subject_kind: null,
    subject_ref: null,
    event_type: null,
    subject_title: null,
    subject_url: null,
    subject_type: null,
    ...overrides,
  };
}

describe("SubjectCell", () => {
  it("renders the ADO-style icon for each known work-item type", () => {
    const cases: Array<[string, string]> = [
      ["Bug", "Bug"],
      ["User Story", "User Story"],
      ["Epic", "Epic"],
      ["Task", "Task"],
      ["Initiative", "Initiative"],
    ];
    for (const [type, iconLabel] of cases) {
      const { unmount } = render(
        <SubjectCell
          fields={fields({
            event_type: "ado.workitem.created",
            subject_type: type,
            subject_title: `A ${type}`,
          })}
        />,
      );
      // The tinted glyph carries its type name as a title; an <svg> is drawn.
      const icon = screen.getByTitle(iconLabel);
      expect(icon.querySelector("svg")).toBeTruthy();
      unmount();
    }
  });

  it("falls back to the neutral glyph for an unknown type or source", () => {
    // Unknown subject_type under a known source.
    const { unmount } = render(
      <SubjectCell
        fields={fields({
          event_type: "ado.workitem.created",
          subject_type: "Mystery",
          subject_title: "Unknown kind",
        })}
      />,
    );
    expect(screen.getByTitle("Item").querySelector("svg")).toBeTruthy();
    expect(screen.queryByTitle("Bug")).toBeNull();
    unmount();

    // Known type but a non-ado source: still neutral.
    render(
      <SubjectCell
        fields={fields({
          event_type: "other.thing",
          subject_type: "Bug",
          subject_title: "Not ADO",
        })}
      />,
    );
    expect(screen.getByTitle("Item").querySelector("svg")).toBeTruthy();
  });

  it("wraps BOTH the icon and the title in the external link when a url is present", () => {
    render(
      <SubjectCell
        fields={fields({
          event_type: "ado.workitem.created",
          subject_type: "Bug",
          subject_title: "Fix the widget",
          subject_url: "https://example.test/wi/42",
        })}
      />,
    );
    const link = screen.getByRole("link", { name: "Fix the widget" });
    expect(link.getAttribute("href")).toBe("https://example.test/wi/42");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    // The icon lives inside the same link as the title.
    expect(within(link).getByTitle("Bug")).toBeTruthy();
  });

  it("renders the icon and title unlinked when no url is present", () => {
    render(
      <SubjectCell
        fields={fields({
          event_type: "ado.workitem.created",
          subject_type: "Task",
          subject_title: "No link here",
        })}
      />,
    );
    const title = screen.getByText("No link here");
    expect(title.closest("a")).toBeNull();
    // The icon is still drawn, just not inside a link.
    expect(screen.getByTitle("Task").closest("a")).toBeNull();
  });

  it("renders the event type as a SEPARATE element, never sharing layout with the title", () => {
    render(
      <SubjectCell
        fields={fields({
          event_type: "ado.workitem.created",
          subject_type: "Bug",
          subject_title: "Fix the widget",
          subject_url: "https://example.test/wi/42",
        })}
      />,
    );
    const link = screen.getByRole("link", { name: "Fix the widget" });
    const eventType = screen.getByText("ado.workitem.created");

    // The event type is its own node, outside the title link — the two never
    // occupy the same element (the overlap bug this fixes).
    expect(eventType).not.toBe(link);
    expect(link.contains(eventType)).toBe(false);
    expect(eventType.contains(link)).toBe(false);
    // The title text still lives inside the link.
    expect(within(link).getByText("Fix the widget")).toBeTruthy();
  });

  it("omits the event-type line when showEventType is false", () => {
    render(
      <SubjectCell
        showEventType={false}
        fields={fields({
          event_type: "ado.workitem.created",
          subject_type: "Bug",
          subject_title: "Fix the widget",
          subject_url: "https://example.test/wi/42",
        })}
      />,
    );
    expect(screen.queryByText("ado.workitem.created")).toBeNull();
    expect(screen.getByRole("link", { name: "Fix the widget" })).toBeTruthy();
  });

  it("renders the subject ref as a chip beside — but outside — the title link", () => {
    render(
      <SubjectCell
        fields={fields({
          event_type: "ado.workitem.created",
          subject_type: "Bug",
          subject_ref: "42",
          subject_title: "Fix the widget",
          subject_url: "https://example.test/wi/42",
        })}
      />,
    );
    // The ref chip is shown verbatim as `#42`.
    const chip = screen.getByText("#42");
    expect(chip).toBeTruthy();
    // It lives outside the link, so the link's accessible name stays the title.
    const link = screen.getByRole("link", { name: "Fix the widget" });
    expect(link.contains(chip)).toBe(false);
  });

  it("does NOT add a ref chip when the label is the '<kind> <ref>' fallback", () => {
    // No title: the label already folds in the ref, so no separate `#ref` chip.
    render(
      <SubjectCell
        fields={fields({
          event_type: "ado.workitem.created",
          subject_kind: "workitem",
          subject_ref: "7",
        })}
      />,
    );
    expect(screen.getByText("workitem 7")).toBeTruthy();
    expect(screen.queryByText("#7")).toBeNull();
  });

  it("renders a muted em dash when the subject is entirely unknown", () => {
    render(<SubjectCell fields={fields()} />);
    expect(screen.getByLabelText("No subject").textContent).toBe("—");
  });
});
