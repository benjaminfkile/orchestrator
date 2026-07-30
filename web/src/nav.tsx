// Single source of truth for the app's top-level navigation. The shell renders
// the left nav from this list and App wires the same list into the router, so a
// page is added in exactly one place.

import type { FluentIcon } from "@fluentui/react-icons";
import {
  Alert20Regular,
  Book20Regular,
  Bot20Regular,
  Code20Regular,
  Filter20Regular,
  Flash20Regular,
  List20Regular,
  Megaphone20Regular,
  Play20Regular,
  PuzzlePiece20Regular,
  Settings20Regular,
} from "@fluentui/react-icons";

export interface NavItem {
  /** Router path. The first entry ("Queue") is the index route at "/". */
  path: string;
  /** Label shown in the nav and used as the page title. */
  label: string;
  /** Icon shown beside the label, and alone when the rail is collapsed. */
  icon: FluentIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Queue", icon: List20Regular },
  { path: "/events", label: "Events", icon: Flash20Regular },
  { path: "/rules", label: "Rules", icon: Filter20Regular },
  { path: "/playbooks", label: "Playbooks", icon: Book20Regular },
  { path: "/snippets", label: "Snippets", icon: Code20Regular },
  { path: "/runs", label: "Runs", icon: Play20Regular },
  { path: "/modules", label: "Modules", icon: PuzzlePiece20Regular },
  { path: "/notifications", label: "Notifications", icon: Alert20Regular },
  { path: "/notifiers", label: "Notifiers", icon: Megaphone20Regular },
  { path: "/agent-briefing", label: "Agent Briefing", icon: Bot20Regular },
  { path: "/settings", label: "Settings", icon: Settings20Regular },
];
