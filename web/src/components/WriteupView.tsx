// Renders a run's `result_text` as GitHub-Flavored Markdown (the flavor Azure
// DevOps accepts in PR descriptions and comments: CommonMark plus GFM tables,
// task lists, and strikethrough) with a Rendered / Raw toggle and a
// Copy markdown button that always puts the RAW result_text on the clipboard.
//
// Load-bearing choices:
//   - No `rehype-raw` and no custom rehype plugins: raw HTML in the input is
//     escaped, not rendered, so the sanitization posture is the react-markdown
//     default (no arbitrary HTML from the model reaches the DOM).
//   - Element styling is scoped to `.writeup-view` via a wrapper className, so
//     the writeup's h1..h6/table/code styling never leaks into the rest of the
//     app (no global CSS).
//   - Clipboard: prefer `navigator.clipboard.writeText`; when it is missing or
//     rejects (the app is served over plain http on the LAN, so a browser may
//     refuse to expose the async clipboard on non-secure contexts), fall back
//     to a hidden textarea + `document.execCommand("copy")`.

import { useCallback, useRef, useState } from "react";
import {
  Button,
  makeStyles,
  Text,
  tokens,
} from "@fluentui/react-components";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** How long the "Copied" confirmation stays visible after a successful copy. */
const COPIED_CONFIRM_MS = 1500;

const useStyles = makeStyles({
  // Toolbar sits above the pane; the toggle group left, copy affordance right.
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalS,
    flexWrap: "wrap",
  },
  toggle: {
    display: "inline-flex",
    gap: tokens.spacingHorizontalXS,
  },
  copyGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  copiedNote: {
    color: tokens.colorPaletteGreenForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  // Raw view: the same monospace pane the previous <pre> used, so the on-wire
  // text renders identically when the user flips off the rendered view.
  raw: {
    margin: 0,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowX: "auto",
  },
  // Rendered view container. All element rules below are scoped through this
  // class name so no global CSS is emitted. `overflowWrap` keeps long words
  // from bursting the pane at narrow widths.
  rendered: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    overflowWrap: "anywhere",
    overflowX: "auto",
    // Headings: match Fluent title sizes, trimmed at the top so the pane starts
    // flush; `first-child` on the pane strips the leading margin.
    "& h1, & h2, & h3, & h4, & h5, & h6": {
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalS,
      fontFamily: tokens.fontFamilyBase,
      lineHeight: tokens.lineHeightBase400,
    },
    "& > :first-child": {
      marginTop: 0,
    },
    "& h1": { fontSize: tokens.fontSizeHero800 },
    "& h2": { fontSize: tokens.fontSizeHero700 },
    "& h3": { fontSize: tokens.fontSizeBase600 },
    "& h4": { fontSize: tokens.fontSizeBase500 },
    "& h5": { fontSize: tokens.fontSizeBase400 },
    "& h6": { fontSize: tokens.fontSizeBase300 },
    // Paragraphs & lists: keep breathing room, but no giant gaps.
    "& p, & ul, & ol, & blockquote": {
      marginTop: 0,
      marginBottom: tokens.spacingVerticalS,
      lineHeight: tokens.lineHeightBase300,
    },
    "& ul, & ol": {
      paddingLeft: tokens.spacingHorizontalXXL,
    },
    "& li + li": {
      marginTop: tokens.spacingVerticalXXS,
    },
    "& blockquote": {
      paddingLeft: tokens.spacingHorizontalM,
      borderLeft: `4px solid ${tokens.colorNeutralStroke2}`,
      color: tokens.colorNeutralForeground3,
    },
    // Inline code: subtle chip so it reads as code without shouting.
    "& code": {
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: tokens.fontSizeBase200,
      backgroundColor: tokens.colorNeutralBackground4,
      padding: `2px ${tokens.spacingHorizontalXS}`,
      borderRadius: tokens.borderRadiusSmall,
    },
    // Code blocks: full-width, scroll horizontally rather than wrap; the inner
    // <code> inherits the mono font but drops the chip background.
    "& pre": {
      margin: 0,
      marginBottom: tokens.spacingVerticalS,
      padding: tokens.spacingVerticalM,
      borderRadius: tokens.borderRadiusMedium,
      backgroundColor: tokens.colorNeutralBackground4,
      overflowX: "auto",
      lineHeight: tokens.lineHeightBase200,
    },
    "& pre code": {
      backgroundColor: "transparent",
      padding: 0,
      fontSize: tokens.fontSizeBase200,
    },
    // GFM tables: bordered, header row emphasised.
    "& table": {
      borderCollapse: "collapse",
      marginBottom: tokens.spacingVerticalM,
      fontSize: tokens.fontSizeBase300,
    },
    "& th, & td": {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
      textAlign: "left",
      verticalAlign: "top",
    },
    "& th": {
      backgroundColor: tokens.colorNeutralBackground4,
      fontWeight: tokens.fontWeightSemibold,
    },
    // Links: brand-colored, underline on hover.
    "& a": {
      color: tokens.colorBrandForegroundLink,
      textDecorationLine: "none",
    },
    "& a:hover": {
      textDecorationLine: "underline",
    },
    // Horizontal rule + task-list bullets from GFM.
    "& hr": {
      border: 0,
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalM,
    },
    "& input[type='checkbox']": {
      marginRight: tokens.spacingHorizontalXS,
    },
    // Images: never overflow the pane.
    "& img": {
      maxWidth: "100%",
      height: "auto",
    },
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

/** Which face the writeup pane is currently showing. */
type Mode = "rendered" | "raw";

/**
 * Copy `text` to the clipboard. Uses the async Clipboard API when available
 * (secure contexts), and falls back to a hidden textarea + `execCommand` on
 * older browsers or when the app is served over plain http on the LAN. Returns
 * true when the copy succeeded, false otherwise.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the execCommand path below.
    }
  }
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.left = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

export interface WriteupViewProps {
  /** The RAW markdown source. Empty/null renders the muted placeholder. */
  text: string | null | undefined;
  /**
   * Accessible label for the writeup pane (rendered and raw). Also used as the
   * label prefix for the Rendered/Raw toggle so multiple writeup views on a
   * page stay distinguishable to assistive tech.
   */
  ariaLabel?: string;
  /** Copy for the empty state. Defaults to "No result text." */
  emptyText?: string;
}

/**
 * Renders a markdown writeup (a run's `result_text` or any other markdown a
 * user surface displays) with a Rendered/Raw toggle and a copy-markdown
 * button. The rendered view uses react-markdown + remark-gfm (GFM tables,
 * task lists, strikethrough) with the default sanitization posture (no raw
 * HTML). The copy button always writes the RAW text to the clipboard, even
 * when the rendered view is showing.
 */
export function WriteupView({
  text,
  ariaLabel = "Writeup",
  emptyText = "No result text.",
}: WriteupViewProps) {
  const styles = useStyles();
  const [mode, setMode] = useState<Mode>("rendered");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const raw = text ?? "";
  const isEmpty = raw.length === 0;

  const onCopy = useCallback(async () => {
    const ok = await copyToClipboard(raw);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    if (ok) {
      setCopyError(null);
      setCopied(true);
      copiedTimerRef.current = setTimeout(
        () => setCopied(false),
        COPIED_CONFIRM_MS,
      );
    } else {
      setCopied(false);
      setCopyError("Copy failed. Select the raw text and copy it manually.");
    }
  }, [raw]);

  if (isEmpty) {
    return <Text className={styles.muted}>{emptyText}</Text>;
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <div
          className={styles.toggle}
          role="group"
          aria-label={`${ariaLabel} view mode`}
        >
          <Button
            size="small"
            appearance={mode === "rendered" ? "primary" : "secondary"}
            aria-pressed={mode === "rendered"}
            onClick={() => setMode("rendered")}
          >
            Rendered
          </Button>
          <Button
            size="small"
            appearance={mode === "raw" ? "primary" : "secondary"}
            aria-pressed={mode === "raw"}
            onClick={() => setMode("raw")}
          >
            Raw
          </Button>
        </div>
        <div className={styles.copyGroup}>
          {copied && (
            <Text
              className={styles.copiedNote}
              role="status"
              aria-live="polite"
            >
              Copied
            </Text>
          )}
          <Button
            size="small"
            appearance="secondary"
            onClick={() => {
              void onCopy();
            }}
          >
            Copy markdown
          </Button>
        </div>
      </div>
      {copyError && (
        <Text as="p" role="alert" className={styles.muted}>
          {copyError}
        </Text>
      )}
      {mode === "rendered" ? (
        <div
          className={`writeup-view ${styles.rendered}`}
          aria-label={ariaLabel}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{raw}</ReactMarkdown>
        </div>
      ) : (
        <pre className={styles.raw} aria-label={`${ariaLabel} raw`}>
          {raw}
        </pre>
      )}
    </div>
  );
}
