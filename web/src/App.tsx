import { useEffect, useState } from "react";
import {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  FluentProvider,
  makeStyles,
  mergeClasses,
  OverlayDrawer,
  tokens,
  Title3,
} from "@fluentui/react-components";
import {
  DarkTheme20Regular,
  Dismiss24Regular,
  Navigation24Regular,
  PanelLeftContract20Regular,
  PanelLeftExpand20Regular,
} from "@fluentui/react-icons";
import { NavLink, Route, Routes } from "react-router-dom";
import { NAV_ITEMS } from "./nav";
import { installListboxScrollGuard } from "./scrollGuard";
import { useMediaQuery } from "./useMediaQuery";
import {
  ThemeProvider,
  useTheme,
  type ThemePreference,
} from "./theme";
import { AgentBriefingPage } from "./pages/AgentBriefingPage";
import { EventsPage } from "./pages/EventsPage";
import { ModulesPage } from "./pages/ModulesPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { NotifiersPage } from "./pages/NotifiersPage";
import { PageStub } from "./pages/PageStub";
import { PlaybooksPage } from "./pages/PlaybooksPage";
import { QueuePage } from "./pages/QueuePage";
import { RulesPage } from "./pages/RulesPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SnippetsPage } from "./pages/SnippetsPage";
import { NotificationBell } from "./components/NotificationBell";
import { NotificationsProvider } from "./components/NotificationsProvider";
import { ChangesProvider } from "./components/ChangesProvider";

// Below this width the persistent rail collapses into a top app bar + drawer.
// Kept in one place so the layout switch and any future styling agree.
const NARROW_QUERY = "(max-width: 768px)";

const useStyles = makeStyles({
  root: {
    display: "flex",
    // The shell is exactly the viewport: the nav stays fixed in place and the
    // routed content scrolls in its own region, so the menu never scrolls away.
    height: "100vh",
    overflow: "hidden",
    // Paint the resolved theme's background across the whole shell so dark mode
    // covers the full viewport rather than leaving a light gutter.
    backgroundColor: tokens.colorNeutralBackground1,
  },
  // Narrow layout stacks a top bar above the routed content instead of placing
  // a rail beside it.
  rootColumn: {
    flexDirection: "column",
  },
  nav: {
    display: "flex",
    flexDirection: "column",
    width: "220px",
    flexShrink: 0,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    gap: tokens.spacingVerticalXS,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    // The rail scrolls on its own if it ever outgrows the viewport; the page
    // content scrolling never moves it.
    overflowY: "auto",
    transitionProperty: "width",
    transitionDuration: tokens.durationNormal,
  },
  // Icon-only rail (ADO-style): just wide enough for the icons, labels hidden.
  navCollapsed: {
    width: "56px",
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXS}`,
  },
  navSpacer: {
    flexGrow: 1,
  },
  themeToggle: {
    justifyContent: "flex-start",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    marginBottom: tokens.spacingVerticalM,
  },
  // Collapsed rail: only the bell remains, centered above the icons.
  brandCollapsed: {
    justifyContent: "center",
    padding: `${tokens.spacingVerticalS} 0`,
  },
  // Mobile top app bar: hamburger on the left, brand in the middle, theme
  // toggle on the right.
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  topBarBrand: {
    flexGrow: 1,
  },
  // The drawer's nav links reuse the rail link styling but lay out in a column
  // inside the drawer body.
  drawerNav: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  link: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    textDecorationLine: "none",
    fontSize: tokens.fontSizeBase300,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground2Hover,
    },
  },
  // Icon-only link: center the icon and drop the label's horizontal padding.
  linkCollapsed: {
    justifyContent: "center",
    padding: `${tokens.spacingVerticalSNudge} 0`,
  },
  linkActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    fontWeight: tokens.fontWeightSemibold,
  },
  content: {
    flexGrow: 1,
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXL}`,
    overflowY: "auto",
  },
});

// Cycle order for the toggle and the label shown for each preference.
const THEME_ORDER: ThemePreference[] = ["system", "light", "dark"];
const THEME_LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Toggle that cycles the theme preference system → light → dark. The persisted
 * choice and live re-hydration are owned by ThemeProvider.
 */
function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const styles = useStyles();
  const { preference, setPreference } = useTheme();
  const next =
    THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length];
  const label = `Theme: ${THEME_LABEL[preference]}. Switch to ${THEME_LABEL[next]}.`;
  if (iconOnly) {
    return (
      <Button
        appearance="subtle"
        icon={<DarkTheme20Regular />}
        onClick={() => setPreference(next)}
        aria-label={label}
        title={`Theme: ${THEME_LABEL[preference]}`}
      />
    );
  }
  return (
    <Button
      appearance="subtle"
      className={styles.themeToggle}
      onClick={() => setPreference(next)}
      aria-label={label}
    >
      Theme: {THEME_LABEL[preference]}
    </Button>
  );
}

/**
 * The shared list of route links used by both the desktop rail and the mobile
 * drawer. `onNavigate` lets the drawer close itself when a route is chosen.
 */
function NavLinks({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const styles = useStyles();
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.path}
            to={item.path}
            // "/" would otherwise stay active for every route; `end` scopes it.
            end={item.path === "/"}
            onClick={onNavigate}
            // The label stays the accessible name when only the icon is shown.
            aria-label={item.label}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              mergeClasses(
                styles.link,
                collapsed && styles.linkCollapsed,
                isActive && styles.linkActive,
              )
            }
          >
            <Icon aria-hidden />
            {!collapsed && item.label}
          </NavLink>
        );
      })}
    </>
  );
}

// Persisted collapse preference; reads defensively like the theme preference
// (localStorage can throw in private mode / disabled storage).
const NAV_COLLAPSED_KEY = "orchestrator.nav.collapsed";

function readNavCollapsed(): boolean {
  try {
    return window.localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Persistent left navigation rail used at desktop width. Fixed in the shell (it
 * never scrolls with the page) and collapsible to an ADO-style icon-only rail;
 * the choice is persisted across sessions.
 */
function SideNav() {
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState(readNavCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Persistence is best-effort; the in-memory state still applies.
    }
  };
  return (
    <nav
      className={mergeClasses(styles.nav, collapsed && styles.navCollapsed)}
      aria-label="Primary"
    >
      <div
        className={mergeClasses(
          styles.brand,
          collapsed && styles.brandCollapsed,
        )}
      >
        {!collapsed && <Title3 as="h1">orchestrator</Title3>}
        <NotificationBell />
      </div>
      <NavLinks collapsed={collapsed} />
      <div className={styles.navSpacer} />
      <ThemeToggle iconOnly={collapsed} />
      <Button
        appearance="subtle"
        className={collapsed ? undefined : styles.themeToggle}
        icon={
          collapsed ? <PanelLeftExpand20Regular /> : <PanelLeftContract20Regular />
        }
        onClick={toggle}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
      >
        {!collapsed && "Collapse"}
      </Button>
    </nav>
  );
}

/**
 * Mobile navigation: a top app bar with a hamburger that opens the nav as an
 * overlay drawer. Choosing a route (or the close button) dismisses the drawer.
 */
function MobileNav() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className={styles.topBar}>
        <Button
          appearance="subtle"
          icon={<Navigation24Regular />}
          aria-label="Open navigation"
          onClick={() => setOpen(true)}
        />
        <Title3 as="h1" className={styles.topBarBrand}>
          orchestrator
        </Title3>
        <NotificationBell />
        <ThemeToggle />
      </header>
      <OverlayDrawer
        open={open}
        position="start"
        onOpenChange={(_, data) => setOpen(data.open)}
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
              />
            }
          >
            orchestrator
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <nav className={styles.drawerNav} aria-label="Primary">
            <NavLinks onNavigate={() => setOpen(false)} />
          </nav>
        </DrawerBody>
      </OverlayDrawer>
    </>
  );
}

/** The routed page content, shared by both layouts. */
function RoutedContent() {
  const styles = useStyles();
  return (
    <main className={styles.content}>
      <Routes>
        {NAV_ITEMS.map((item) => {
          if (item.path === "/") {
            return <Route key={item.path} index element={<QueuePage />} />;
          }
          const element =
            item.path === "/events" ? (
              <EventsPage />
            ) : item.path === "/rules" ? (
              <RulesPage />
            ) : item.path === "/playbooks" ? (
              <PlaybooksPage />
            ) : item.path === "/snippets" ? (
              <SnippetsPage />
            ) : item.path === "/runs" ? (
              <RunsPage />
            ) : item.path === "/modules" ? (
              <ModulesPage />
            ) : item.path === "/notifications" ? (
              <NotificationsPage />
            ) : item.path === "/notifiers" ? (
              <NotifiersPage />
            ) : item.path === "/agent-briefing" ? (
              <AgentBriefingPage />
            ) : item.path === "/settings" ? (
              <SettingsPage />
            ) : (
              <PageStub title={item.label} />
            );
          return <Route key={item.path} path={item.path} element={element} />;
        })}
        {/* Runs detail lives under the "Runs" nav entry; the Queue links here. */}
        <Route path="/runs/:id" element={<RunDetailPage />} />
      </Routes>
    </main>
  );
}

/**
 * App shell: Fluent theme provider plus a responsive navigation layout. Wide
 * viewports get a persistent left rail; narrow ones get a top app bar with a
 * hamburger-triggered drawer. The switch is driven by a matchMedia hook.
 */
function AppShell() {
  const styles = useStyles();
  const { theme } = useTheme();
  const isNarrow = useMediaQuery(NARROW_QUERY);
  // Shield every scrollable region — the routed content, dialog bodies,
  // drawers — from Fluent's dropdown-open scroll bug (see scrollGuard.ts).
  // Installed once at the shell so nested scroll containers are covered too.
  useEffect(() => installListboxScrollGuard(), []);
  return (
    <FluentProvider
      theme={theme}
      className={
        isNarrow ? mergeClasses(styles.root, styles.rootColumn) : styles.root
      }
    >
      <NotificationsProvider>
        <ChangesProvider>
          {isNarrow ? <MobileNav /> : <SideNav />}
          <RoutedContent />
        </ChangesProvider>
      </NotificationsProvider>
    </FluentProvider>
  );
}

/** Root: owns theme preference state, then renders the themed shell. */
function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}

export default App;
