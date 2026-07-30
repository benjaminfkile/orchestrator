import { useEffect, useState } from "react";
import {
  Button,
  makeStyles,
  Text,
  Title1,
  tokens,
} from "@fluentui/react-components";
import { Copy20Regular } from "@fluentui/react-icons";

import { getAgentBriefing } from "../agentBriefing";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
  },
  intro: {
    display: "block",
    maxWidth: "70ch",
    marginBottom: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground2,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginBottom: tokens.spacingVerticalM,
  },
  // The briefing itself: monospace, wrapped inside its own box so long lines
  // never widen the page.
  briefing: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    overflowY: "auto",
    margin: 0,
  },
});

/**
 * Renders the agent briefing (fetched from `/api/agent-briefing`) with a
 * one-click copy button. The user pastes it into any AI coding agent running
 * on this machine — Claude Code, Codex, Cursor, anything that can make HTTP
 * requests — so the agent knows how this app works and how to drive its API.
 */
export function AgentBriefingPage() {
  const styles = useStyles();
  const [briefing, setBriefing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAgentBriefing()
      .then((text) => {
        if (!cancelled) setBriefing(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onCopy = async () => {
    if (briefing === null) return;
    try {
      await navigator.clipboard.writeText(briefing);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions); the user can still select
      // the text manually, so a silent no-op beats an error banner.
    }
  };

  return (
    <section>
      <div className={styles.header}>
        <Title1 as="h1">Agent Briefing</Title1>
        <Button
          icon={<Copy20Regular />}
          onClick={() => void onCopy()}
          disabled={briefing === null}
        >
          {copied ? "Copied!" : "Copy briefing"}
        </Button>
      </div>
      <Text as="p" className={styles.intro}>
        Paste this briefing into an AI coding agent running on this machine —
        Claude Code, Codex, Cursor, or anything that can make HTTP requests. It
        teaches the agent how orchestrator works and how to drive the local API
        — creating rules, playbooks, snippets, and notifiers, dispatching runs,
        and reading results — so it can set things up for you. The same text is
        served at <code>GET /api/agent-briefing</code>.
      </Text>
      {error !== null && (
        <Text as="p" className={styles.error} role="alert">
          {error}
        </Text>
      )}
      {briefing !== null && <pre className={styles.briefing}>{briefing}</pre>}
    </section>
  );
}
