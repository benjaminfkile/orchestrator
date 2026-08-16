import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { NAV_ITEMS } from "./nav";

// The index route renders the Queue page, which loads data on mount. Stub the
// data layer so the shell tests stay hermetic (no real network) and focus on
// routing/nav rather than queue behavior — that lives in QueuePage.test.tsx.
vi.mock("./dispatches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dispatches")>()),
  listDispatches: vi.fn().mockResolvedValue([]),
  listEvents: vi.fn().mockResolvedValue([]),
  listPlaybooks: vi.fn().mockResolvedValue([]),
  retryDispatch: vi.fn().mockResolvedValue(undefined),
}));

// The Events route loads its own data layer on mount; stub it too so the shell
// tests never touch the network. Behavior is covered in EventsPage.test.tsx.
vi.mock("./events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./events")>()),
  listEvents: vi.fn().mockResolvedValue([]),
}));

// The Rules route loads its own data layer on mount; stub it too so the shell
// tests never touch the network. Behavior is covered in RulesPage.test.tsx.
vi.mock("./rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rules")>()),
  listRules: vi.fn().mockResolvedValue([]),
  listPlaybooks: vi.fn().mockResolvedValue([]),
}));

// The Playbooks route loads its own data layer on mount; stub it too so the
// shell tests never touch the network. Behavior lives in PlaybooksPage.test.tsx.
vi.mock("./playbooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./playbooks")>()),
  listPlaybooks: vi.fn().mockResolvedValue([]),
}));

// The Modules route loads its own data layer on mount; stub it too. Behavior
// lives in ModulesPage.test.tsx.
vi.mock("./modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules")>()),
  listModules: vi.fn().mockResolvedValue([]),
  getModuleConfig: vi.fn().mockResolvedValue({ module_id: "ado", config: null }),
}));

// The Settings route loads its own data layer on mount; stub it too. Behavior
// lives in SettingsPage.test.tsx. The default snapshot is a fully-configured
// v1 install so the app-wide SystemStatusBanner stays silent for the shell
// tests below (its own tests exercise the warning states).
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  getSystemInfo: vi.fn().mockResolvedValue({
    wisperBaseUrl: "http://localhost:8080",
    wisperHostId: "host-abc",
    wisperMode: "v1",
    wisperApiKeyPresent: true,
  }),
  getSettings: vi.fn().mockResolvedValue({}),
  listSecrets: vi.fn().mockResolvedValue([]),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

// Install a matchMedia stub where the responsive breakpoint reports the given
// match state. `(prefers-color-scheme: dark)` (used by ThemeProvider) always
// reports no-match so these tests exercise layout, not theme resolution.
function installMatchMedia(narrow: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" ? narrow : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

describe("App shell", () => {
  it("renders a nav link for every page", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: item.label })).toBeTruthy();
    }
  });

  it("renders the Queue page at the index route", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: "Queue", level: 1 })).toBeTruthy();
  });

  it("renders the correct page for a deep-linked route", async () => {
    renderAt("/settings");
    expect(
      screen.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeTruthy();
    // Let the Settings page's mocked initial load settle so its state update
    // lands inside act() rather than after the test body returns.
    await screen.findByText("http://localhost:8080");
  });

  it("switches the routed content when a nav link is clicked", async () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: "Queue", level: 1 })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Rules" }));
    expect(screen.getByRole("heading", { name: "Rules", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Queue", level: 1 })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Playbooks" }));
    expect(
      screen.getByRole("heading", { name: "Playbooks", level: 1 }),
    ).toBeTruthy();
    // Let the Playbooks page's mocked initial load settle so its state update
    // lands inside act() rather than after the test body returns.
    await screen.findByText("No playbooks configured.");
  });

  it("cycles the theme preference via the nav toggle", () => {
    window.localStorage.clear();
    renderAt("/");
    // Default preference is "system" (no persisted value, matchMedia absent).
    const toggle = screen.getByRole("button", { name: /^Theme: System/ });
    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: /^Theme: Light/ }),
    ).toBeTruthy();
    expect(window.localStorage.getItem("orchestrator.theme")).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: /^Theme: Light/ }));
    expect(screen.getByRole("button", { name: /^Theme: Dark/ })).toBeTruthy();
  });

  it("marks the active nav link with aria-current", async () => {
    renderAt("/events");
    const active = screen.getByRole("link", { name: "Events" });
    expect(active.getAttribute("aria-current")).toBe("page");
    // The index ("Queue") link must not stay active on other routes.
    const queue = screen.getByRole("link", { name: "Queue" });
    expect(queue.getAttribute("aria-current")).toBeNull();
    // Let the Events page's mocked initial load settle so its state update
    // lands inside act() rather than after the test body returns.
    await screen.findByText("No events to show.");
  });
});

describe("App shell — responsive navigation", () => {
  // These tests drive the matchMedia-based breakpoint hook. Restore the
  // unstubbed environment afterwards so the default (rail) tests above and any
  // other suites see matchMedia as absent again.
  const originalMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("renders the persistent rail at desktop width", () => {
    installMatchMedia(false);
    renderAt("/");
    // The rail is present and there is no hamburger / top-bar affordance.
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open navigation" }),
    ).toBeNull();
  });

  it("renders a hamburger (not the rail) at mobile width", () => {
    installMatchMedia(true);
    renderAt("/");
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toBeTruthy();
    // The drawer starts closed, so no nav landmark is mounted yet.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("keeps the theme toggle in the mobile top bar", () => {
    installMatchMedia(true);
    renderAt("/");
    expect(
      screen.getByRole("button", { name: /^Theme: / }),
    ).toBeTruthy();
  });

  it("opens the drawer from the hamburger and navigates, then closes", async () => {
    installMatchMedia(true);
    renderAt("/");
    expect(screen.getByRole("heading", { name: "Queue", level: 1 })).toBeTruthy();

    // Open the drawer: the nav landmark and its links become available.
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: item.label })).toBeTruthy();
    }

    // Selecting a route navigates and dismisses the drawer.
    fireEvent.click(within(nav).getByRole("link", { name: "Rules" }));
    expect(screen.getByRole("heading", { name: "Rules", level: 1 })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: "Primary" }),
      ).toBeNull(),
    );
  });
});

describe("App shell — collapsible rail", () => {
  afterEach(() => {
    window.localStorage.removeItem("orchestrator.nav.collapsed");
  });

  it("collapses to icon-only links and persists the choice", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });

    // Expanded by default: labels are visible text and the toggle collapses.
    expect(within(nav).getByText("Playbooks")).toBeTruthy();
    fireEvent.click(
      within(nav).getByRole("button", { name: "Collapse navigation" }),
    );

    // Collapsed: labels are gone as text, but every link keeps its accessible
    // name (aria-label) so navigation stays fully usable.
    expect(within(nav).queryByText("Playbooks")).toBeNull();
    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: item.label })).toBeTruthy();
    }
    expect(window.localStorage.getItem("orchestrator.nav.collapsed")).toBe("1");

    // Expanding restores labels and persists the flipped choice.
    fireEvent.click(
      within(nav).getByRole("button", { name: "Expand navigation" }),
    );
    expect(within(nav).getByText("Playbooks")).toBeTruthy();
    expect(window.localStorage.getItem("orchestrator.nav.collapsed")).toBe("0");
  });

  it("starts collapsed when the persisted preference says so", () => {
    window.localStorage.setItem("orchestrator.nav.collapsed", "1");
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByText("Playbooks")).toBeNull();
    expect(
      within(nav).getByRole("button", { name: "Expand navigation" }),
    ).toBeTruthy();
  });
});
