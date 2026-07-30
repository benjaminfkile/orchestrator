import { makeStyles } from "@fluentui/react-components";

/**
 * Shared "truncate a long-content table cell" style, used by every list page.
 *
 * Fluent's Table uses a FIXED layout, so a cell holding an unbounded string (a
 * name, a description, a free-text ref) paints over its neighbor when the column
 * narrows. This class clips the overflow to a single line with an ellipsis; pair
 * it with a `title` attribute on the SAME element so hover still reveals the full
 * value. Compose it with a page-local style (e.g. a monospace or color cell) via
 * `mergeClasses` when a cell needs both.
 *
 * Extracted here — next to {@link ../useTableSort useTableSort} — so one
 * definition backs every table and the NEXT new table gets truncation for free
 * instead of copying the three CSS rules again.
 */
const useStyles = makeStyles({
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/** The class name for a long-content `TableCell` (pair with a matching `title`). */
export function useTruncateStyle(): string {
  return useStyles().truncate;
}
