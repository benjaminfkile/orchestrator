import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSystemInfo, type SystemInfo } from "../settings";
import { useLiveRefetch } from "./useLiveRefetch";
import {
  BANNER_KEY_API_KEY,
  BANNER_KEY_HOST_ID,
  SystemStatusBanner,
} from "./SystemStatusBanner";

// The banner fetches system info; stub the settings module so tests never touch
// the real network. Presence-flag semantics belong to the API contract; here we
// only need to feed the banner different snapshots.
vi.mock("../settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settings")>()),
  getSystemInfo: vi.fn(),
}));

// The banner subscribes to `secrets` and `settings` via useLiveRefetch. Capture
// the subscribed callbacks so a test can simulate a live change without
// standing up a real ChangesProvider + EventSource.
vi.mock("./useLiveRefetch", () => ({
  useLiveRefetch: vi.fn(),
}));

const mockGetSystemInfo = vi.mocked(getSystemInfo);
const mockUseLiveRefetch = vi.mocked(useLiveRefetch);

// Handy helper: render the banner behind a router that exposes the current
// location so navigation-target tests can assert where a link routes to.
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="pathname">{location.pathname}</span>;
}

function renderBanner(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SystemStatusBanner />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** A default "everything is fine" fixture; individual tests override fields. */
function systemInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    wisperBaseUrl: "http://localhost:8080",
    wisperHostId: "host-abc",
    wisperMode: "v1",
    wisperApiKeyPresent: true,
    ...overrides,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  mockUseLiveRefetch.mockReset();
  mockGetSystemInfo.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SystemStatusBanner", () => {
  it("renders nothing while system info is still loading", () => {
    mockGetSystemInfo.mockReturnValue(new Promise(() => {}));
    const { container } = renderBanner();
    expect(container.querySelector("[data-testid='system-status-banner']")).toBeNull();
  });

  it("shows the WISPER_API_KEY banner in v1 mode when the key is missing", async () => {
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({ wisperMode: "v1", wisperApiKeyPresent: false }),
    );
    renderBanner();
    // Title identifies the dead-end; body must name the secret verbatim.
    expect(
      await screen.findByText(/leasing is disabled/i),
    ).toBeTruthy();
    expect(screen.getByText("WISPER_API_KEY")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("does not show any banner in dev mode when host is configured", async () => {
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({ wisperMode: "dev", wisperApiKeyPresent: false }),
    );
    const { container } = renderBanner();
    // Wait for the fetch promise to settle so this assertion is not racing state.
    await waitFor(() => expect(mockGetSystemInfo).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='system-status-banner']")).toBeNull();
  });

  it("does not show the API key banner when the key is present in v1 mode", async () => {
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({ wisperMode: "v1", wisperApiKeyPresent: true }),
    );
    const { container } = renderBanner();
    await waitFor(() => expect(mockGetSystemInfo).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='system-status-banner']")).toBeNull();
  });

  it("shows the WISPER_HOST_ID banner when the env var is unset", async () => {
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({ wisperHostId: null, wisperMode: "dev" }),
    );
    renderBanner();
    expect(await screen.findByText(/leasing is idle/i)).toBeTruthy();
    expect(screen.getByText("WISPER_HOST_ID")).toBeTruthy();
  });

  it("shows both banners when both dead-ends are present", async () => {
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({
        wisperHostId: null,
        wisperMode: "v1",
        wisperApiKeyPresent: false,
      }),
    );
    renderBanner();
    expect(await screen.findByText("WISPER_API_KEY")).toBeTruthy();
    expect(screen.getByText("WISPER_HOST_ID")).toBeTruthy();
  });

  it("navigates to the Settings page when the link is clicked", async () => {
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({ wisperMode: "v1", wisperApiKeyPresent: false }),
    );
    renderBanner("/rules");
    await screen.findByText("WISPER_API_KEY");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("pathname").textContent).toBe("/settings");
  });

  it("dismiss hides the banner and persists the choice for the session", async () => {
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({ wisperMode: "v1", wisperApiKeyPresent: false }),
    );
    const { unmount } = renderBanner();
    const dismiss = await screen.findByRole("button", {
      name: /Dismiss: Wisper API key not set/i,
    });
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.queryByText("WISPER_API_KEY")).toBeNull());
    // Session store now records this key so a remount does not resurrect it.
    unmount();
    renderBanner();
    await waitFor(() => expect(mockGetSystemInfo).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("WISPER_API_KEY")).toBeNull();
  });

  it("clears without a reload once the missing secret is saved (live refetch)", async () => {
    // First fetch: key missing → banner shows. When useLiveRefetch fires the
    // `secrets` callback, the next fetch returns the "present" snapshot and
    // the banner disappears without any page reload.
    mockGetSystemInfo
      .mockResolvedValueOnce(
        systemInfo({ wisperMode: "v1", wisperApiKeyPresent: false }),
      )
      .mockResolvedValue(
        systemInfo({ wisperMode: "v1", wisperApiKeyPresent: true }),
      );

    // Capture the callback registered for the "secrets" resource so the test
    // can trigger it after mount. A ref-shaped holder keeps TypeScript's
    // narrowing predictable across the async gap.
    const callbacks: { secrets?: () => void | Promise<void> } = {};
    mockUseLiveRefetch.mockImplementation((resource, refetch) => {
      if (resource === "secrets") callbacks.secrets = refetch;
    });

    renderBanner();
    expect(await screen.findByText("WISPER_API_KEY")).toBeTruthy();

    // Simulate the SSE change bus firing a `secrets` change after a PUT.
    expect(callbacks.secrets).toBeDefined();
    await callbacks.secrets?.();

    await waitFor(() => expect(screen.queryByText("WISPER_API_KEY")).toBeNull());
  });

  it("subscribes to both secrets and settings resources", async () => {
    mockGetSystemInfo.mockResolvedValue(systemInfo());
    renderBanner();
    await waitFor(() => expect(mockUseLiveRefetch).toHaveBeenCalled());
    const resources = mockUseLiveRefetch.mock.calls.map((c) => c[0]);
    expect(resources).toContain("secrets");
    expect(resources).toContain("settings");
  });

  it("stays hidden if the session already dismissed the banner", async () => {
    window.sessionStorage.setItem(
      "orchestrator.systemBanner.dismissed",
      JSON.stringify([BANNER_KEY_API_KEY, BANNER_KEY_HOST_ID]),
    );
    mockGetSystemInfo.mockResolvedValue(
      systemInfo({
        wisperHostId: null,
        wisperMode: "v1",
        wisperApiKeyPresent: false,
      }),
    );
    const { container } = renderBanner();
    await waitFor(() => expect(mockGetSystemInfo).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='system-status-banner']")).toBeNull();
  });
});
