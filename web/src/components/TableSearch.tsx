import { useCallback, useEffect, useRef, useState } from "react";
import {
  makeStyles,
  SearchBox,
  Text,
  tokens,
  type SearchBoxChangeEvent,
  type InputOnChangeData,
} from "@fluentui/react-components";

/**
 * The debounce applied before a keystroke propagates to the page as a committed
 * query. Long enough to coalesce fast typing, short enough to feel live.
 */
const DEFAULT_DEBOUNCE_MS = 300;

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  box: {
    minWidth: "260px",
    maxWidth: "420px",
    flexGrow: 1,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
});

/** Props for {@link TableSearch}. */
export interface TableSearchProps {
  /**
   * Called with the debounced query whenever it changes. Clearing the box fires
   * this immediately with `""` so the normal (unfiltered) list restores at once.
   */
  onSearch: (query: string) => void;
  /** Placeholder shown in the empty box. */
  placeholder?: string;
  /** Accessible label for the search box. Defaults to "Search". */
  label?: string;
  /** Debounce window in ms before a keystroke commits. Defaults to 300. */
  debounceMs?: number;
  /**
   * Row count currently shown. When a query is active this renders a
   * results-count hint beside the box; omit it to suppress the hint.
   */
  resultCount?: number;
}

/**
 * The one search input rendered above every table in the app: a Fluent
 * {@link SearchBox} (magnifier + clear button) that debounces keystrokes before
 * handing the committed query to its page. Pages wire it to a server `q` param
 * (unbounded paginated lists) or to a client-side row filter (small config
 * tables); either way this component only owns the input and its debounce.
 *
 * Clearing the box (the built-in dismiss button, or emptying it) commits `""`
 * immediately — no debounce — so the normal list snaps back without a lag. When
 * a query is active and `resultCount` is provided, a "N results" hint renders
 * beside the box.
 */
export function TableSearch({
  onSearch,
  placeholder = "Search…",
  label = "Search",
  debounceMs = DEFAULT_DEBOUNCE_MS,
  resultCount,
}: TableSearchProps) {
  const styles = useStyles();

  // The immediate input text, and the last committed (debounced) query. The
  // committed query drives whether the results hint shows, so the hint tracks
  // the results the page is actually displaying, not an in-flight keystroke.
  const [text, setText] = useState("");
  const [committed, setCommitted] = useState("");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest onSearch without re-subscribing the debounce to it.
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  });

  const commit = useCallback((value: string) => {
    setCommitted(value);
    onSearchRef.current(value);
  }, []);

  const handleChange = useCallback(
    (_event: SearchBoxChangeEvent, data: InputOnChangeData) => {
      const next = data.value;
      setText(next);
      if (timer.current) clearTimeout(timer.current);
      // Clearing the box restores the normal list immediately (no debounce);
      // any other change commits after the debounce window.
      if (next === "") {
        commit("");
        return;
      }
      timer.current = setTimeout(() => commit(next), debounceMs);
    },
    [commit, debounceMs],
  );

  // Drop a pending debounce on unmount so it can't fire into a gone page.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const filtering = committed.trim() !== "";

  return (
    <div className={styles.root}>
      <SearchBox
        className={styles.box}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={handleChange}
      />
      {filtering && resultCount !== undefined && (
        <Text as="span" className={styles.hint} role="status">
          {resultCount} {resultCount === 1 ? "result" : "results"}
        </Text>
      )}
    </div>
  );
}
