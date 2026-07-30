import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { ThemeProvider, useTheme } from "./theme";

const STORAGE_KEY = "orchestrator.theme";

// A controllable matchMedia stub so tests can drive the OS color-scheme query.
type Listener = (e: MediaQueryListEvent) => void;

function installMatchMedia(initialDark: boolean) {
  let matches = initialDark;
  const listeners = new Set<Listener>();
  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    // Legacy API, unused but present on real MediaQueryList.
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return {
    setDark(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    },
  };
}

// A tiny probe that surfaces the resolved theme + preference for assertions.
function Probe() {
  const { preference, mode, theme } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="isDark">
        {String(theme === webDarkTheme)}
      </span>
      <span data-testid="isLight">
        {String(theme === webLightTheme)}
      </span>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to system preference and follows a light OS setting", () => {
    installMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("preference").textContent).toBe("system");
    expect(screen.getByTestId("mode").textContent).toBe("light");
    expect(screen.getByTestId("isLight").textContent).toBe("true");
  });

  it("resolves dark when the OS prefers dark in system mode", () => {
    installMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("mode").textContent).toBe("dark");
    expect(screen.getByTestId("isDark").textContent).toBe("true");
  });

  it("reacts live to a mocked matchMedia change in system mode", () => {
    const media = installMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("mode").textContent).toBe("light");
    act(() => media.setDark(true));
    expect(screen.getByTestId("mode").textContent).toBe("dark");
    act(() => media.setDark(false));
    expect(screen.getByTestId("mode").textContent).toBe("light");
  });

  it("re-hydrates a persisted preference on load", () => {
    installMatchMedia(false);
    window.localStorage.setItem(STORAGE_KEY, "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("preference").textContent).toBe("dark");
    expect(screen.getByTestId("mode").textContent).toBe("dark");
  });

  it("ignores the OS setting when an explicit preference is set", () => {
    const media = installMatchMedia(true);
    window.localStorage.setItem(STORAGE_KEY, "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("mode").textContent).toBe("light");
    // OS flipping should not move an explicit preference.
    act(() => media.setDark(false));
    expect(screen.getByTestId("mode").textContent).toBe("light");
  });
});

// A control that lets a test flip the preference, mirroring the nav toggle.
function Toggle() {
  const { preference, setPreference } = useTheme();
  return (
    <button onClick={() => setPreference(preference === "dark" ? "light" : "dark")}>
      flip
    </button>
  );
}

describe("theme preference persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the choice to localStorage and updates the resolved theme", () => {
    installMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
        <Toggle />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("mode").textContent).toBe("light");
    fireEvent.click(screen.getByText("flip"));
    expect(screen.getByTestId("mode").textContent).toBe("dark");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });
});
