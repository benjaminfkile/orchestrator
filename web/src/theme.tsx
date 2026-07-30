// Theme wiring for the app. The UI is entirely Fluent-token-based, so dark mode
// is a matter of swapping the theme handed to FluentProvider — no restyling.
//
// A ThemeContext exposes the user's *preference* ("system" | "light" | "dark")
// and the *resolved* Fluent theme. "system" follows the OS via matchMedia and
// reacts live to changes. The preference is persisted to localStorage and
// re-hydrated on load.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  webDarkTheme,
  webLightTheme,
  type Theme,
} from "@fluentui/react-components";

/** How the user wants the theme chosen. "system" defers to the OS. */
export type ThemePreference = "system" | "light" | "dark";

/** Whether the resolved theme is light or dark, independent of preference. */
export type ResolvedMode = "light" | "dark";

const STORAGE_KEY = "orchestrator.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  /** The persisted user choice. */
  preference: ThemePreference;
  /** Replace the preference (persisted to localStorage). */
  setPreference: (next: ThemePreference) => void;
  /** Resolved light/dark, after applying the system query for "system". */
  mode: ResolvedMode;
  /** The Fluent theme object to hand to FluentProvider. */
  theme: Theme;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** Read the persisted preference, defaulting to "system". */
function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") {
      return raw;
    }
  } catch {
    // localStorage can throw (private mode, disabled storage); fall through.
  }
  return "system";
}

/** Does the OS currently prefer dark? Safe when matchMedia is unavailable. */
function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * Provides theme state to the app. Owns the localStorage-backed preference and
 * a live subscription to the OS color-scheme query used when preference is
 * "system".
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(readStoredPreference);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Track the OS preference live. Only meaningful while preference is "system",
  // but the subscription is cheap and keeps `systemDark` accurate regardless.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    // Keep state in sync in case it changed between initial read and subscribe.
    setSystemDark(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; ignore storage failures.
    }
  }, []);

  const mode: ResolvedMode = useMemo(() => {
    if (preference === "system") {
      return systemDark ? "dark" : "light";
    }
    return preference;
  }, [preference, systemDark]);

  const theme = mode === "dark" ? webDarkTheme : webLightTheme;

  // FluentProvider only exposes its token CSS variables within its own subtree,
  // so the <body> (outside the provider) can't read them. Mirror the base
  // background/foreground onto :root so index.css can paint the region behind
  // the shell — e.g. overscroll — in the active theme, dark mode included.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--colorNeutralBackground1",
      theme.colorNeutralBackground1,
    );
    root.style.setProperty(
      "--colorNeutralForeground1",
      theme.colorNeutralForeground1,
    );
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      setPreference,
      mode,
      theme,
    }),
    [preference, setPreference, mode, theme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/** Access the theme context. Throws if used outside a ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
