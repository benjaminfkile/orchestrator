import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { getSystemInfo, type SystemInfo } from "../settings";
import { useLiveRefetch } from "./useLiveRefetch";

// Session-scoped dismiss set. Persisting the choice across the tab avoids
// re-showing a banner the user just clicked away in this session, but a full
// close/reopen brings the warning back so a still-broken install is not silent.
const DISMISS_STORAGE_KEY = "orchestrator.systemBanner.dismissed";

// Stable IDs for each dead-end this banner covers. Kept as constants so a
// fixed key survives dismissal in sessionStorage across renders.
export const BANNER_KEY_API_KEY = "wisper_api_key_missing";
export const BANNER_KEY_HOST_ID = "wisper_host_id_missing";

function readDismissed(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissed(dismissed: Set<string>): void {
  try {
    window.sessionStorage.setItem(
      DISMISS_STORAGE_KEY,
      JSON.stringify([...dismissed]),
    );
  } catch {
    // Session storage may be unavailable (private mode, disabled); dismissal
    // still works for the current mounted lifetime via in-memory state.
  }
}

const useStyles = makeStyles({
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM} 0`,
  },
});

/**
 * App-wide banner that surfaces boot-config dead-ends the backend already
 * reports via `GET /api/settings/system` — specifically the two cases that
 * silently disable leasing:
 *
 *   - v1 mode with the `WISPER_API_KEY` secret unset;
 *   - `WISPER_HOST_ID` env var unset (leasing idle).
 *
 * The banner is dismissable per session (cleared on tab close) and links to the
 * Settings page. It re-fetches system info whenever `secrets` or `settings`
 * change on the live stream so saving the missing secret clears it without a
 * full reload.
 */
export function SystemStatusBanner() {
  const styles = useStyles();
  const navigate = useNavigate();
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getSystemInfo();
      if (mounted.current) setSystem(next);
    } catch {
      // A transient fetch failure leaves the last-known state in place. The
      // next live change or reload will reconcile.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Secrets: catches the WISPER_API_KEY case clearing after a PUT. Settings:
  // reserved for future keys the system endpoint may derive from stored
  // settings — cheap to subscribe to since the fetch is a single small GET.
  useLiveRefetch("secrets", refresh);
  useLiveRefetch("settings", refresh);

  const dismiss = useCallback((key: string) => {
    setDismissed((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      writeDismissed(next);
      return next;
    });
  }, []);

  const goToSettings = useCallback(() => {
    navigate("/settings");
  }, [navigate]);

  if (!system) return null;

  const banners: {
    key: string;
    title: string;
    body: ReactNode;
  }[] = [];

  if (system.wisperMode === "v1" && !system.wisperApiKeyPresent) {
    banners.push({
      key: BANNER_KEY_API_KEY,
      title: "Wisper API key not set — leasing is disabled",
      body: (
        <>
          Add a secret named <code>WISPER_API_KEY</code> (a <code>wck_…</code>{" "}
          consumer key minted in wisper-web) in{" "}
          <Link as="button" onClick={goToSettings}>
            Settings
          </Link>
          .
        </>
      ),
    });
  }

  if (system.wisperHostId === null) {
    banners.push({
      key: BANNER_KEY_HOST_ID,
      title: "Wisper host ID not set — leasing is idle",
      body: (
        <>
          Set the <code>WISPER_HOST_ID</code> environment variable and restart
          the orchestrator. See{" "}
          <Link as="button" onClick={goToSettings}>
            Settings
          </Link>{" "}
          for the current host configuration.
        </>
      ),
    });
  }

  const visible = banners.filter((b) => !dismissed.has(b.key));
  if (visible.length === 0) return null;

  return (
    <div className={styles.stack} data-testid="system-status-banner">
      {visible.map((banner) => (
        <MessageBar
          key={banner.key}
          intent="warning"
          layout="multiline"
          politeness="polite"
          aria-label={banner.title}
        >
          <MessageBarBody>
            <MessageBarTitle>{banner.title}</MessageBarTitle> {banner.body}
          </MessageBarBody>
          <MessageBarActions
            containerAction={
              <Button
                appearance="transparent"
                icon={<Dismiss20Regular />}
                aria-label={`Dismiss: ${banner.title}`}
                onClick={() => dismiss(banner.key)}
              />
            }
          />
        </MessageBar>
      ))}
    </div>
  );
}
