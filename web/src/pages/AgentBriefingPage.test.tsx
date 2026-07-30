import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentBriefingPage } from "./AgentBriefingPage";

vi.mock("../agentBriefing", () => ({
  getAgentBriefing: vi.fn(),
}));

import { getAgentBriefing } from "../agentBriefing";

const mockGet = vi.mocked(getAgentBriefing);

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentBriefingPage", () => {
  it("fetches and renders the briefing with a copy button", async () => {
    mockGet.mockResolvedValue("# Driving orchestrator\nBase URL: /api");
    render(<AgentBriefingPage />);

    expect(
      screen.getByRole("heading", { name: "Agent Briefing", level: 1 }),
    ).toBeTruthy();
    // Copy is disabled until the briefing arrives.
    const copy = screen.getByRole("button", { name: "Copy briefing" });
    expect(copy.hasAttribute("disabled")).toBe(true);

    await waitFor(() =>
      expect(screen.getByText(/Driving orchestrator/)).toBeTruthy(),
    );
    expect(copy.hasAttribute("disabled")).toBe(false);
  });

  it("copies the briefing to the clipboard", async () => {
    mockGet.mockResolvedValue("the briefing text");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AgentBriefingPage />);
    await waitFor(() =>
      expect(screen.getByText("the briefing text")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy briefing" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy(),
    );
    expect(writeText).toHaveBeenCalledWith("the briefing text");
  });

  it("shows an error when the fetch fails", async () => {
    mockGet.mockRejectedValue(new Error("boom"));
    render(<AgentBriefingPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });
});
