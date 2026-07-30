import { Link, makeStyles, Text, tokens } from "@fluentui/react-components";
import {
  BookOpen16Filled,
  Bug16Filled,
  ClipboardTask16Filled,
  Crown16Filled,
  Document16Filled,
  type FluentIcon,
} from "@fluentui/react-icons";
import type { SubjectFields } from "../dispatches";

/**
 * The generic subject block surfaced on every run/dispatch read. Kept as its own
 * component so the Runs table, Queue table, and the detail view render the
 * triggering subject identically.
 *
 * Layout is a proper flex STACK — a leading type icon and the (truncating) title
 * on one row, with the event type on a second, smaller secondary line — so the
 * title and the event type never share layout space (the previous single-block
 * render let a long title and the event type overlap in the same table cell).
 */

const useStyles = makeStyles({
  // Vertical stack: title row on top, optional event-type line beneath. min-width
  // 0 lets the children truncate instead of forcing the cell wider.
  stack: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    maxWidth: "320px",
    rowGap: "2px",
  },
  // Icon + title on one row; the icon is fixed-size, the title takes the rest and
  // truncates. Used both as the link and the unlinked container.
  titleRow: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXS,
    minWidth: 0,
    maxWidth: "100%",
    textDecorationLine: "none",
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    fontSize: "16px",
    lineHeight: 0,
  },
  // Row wrapper holding the (non-truncating) subject ref chip alongside the
  // icon+title link, so the ref stays visible even when the title truncates.
  identity: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXS,
    minWidth: 0,
    maxWidth: "100%",
  },
  // The subject reference (e.g. an ADO work-item id). Fixed-size, muted, and
  // never truncated — the id is the one part of the subject that must stay
  // legible at any table width.
  ref: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontFamily: tokens.fontFamilyMonospace,
  },
  // The truncating title text: ellipsis on overflow, never wraps.
  title: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // Smaller, muted secondary line for the event type — its own row, so it can
  // never overlap the title.
  eventType: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

/** A presentation-layer icon choice: which glyph and what color to tint it. */
interface IconSpec {
  Icon: FluentIcon;
  color: string;
  /** Human name of the type, used for the icon's accessible/hover label. */
  label: string;
}

/** Neutral fallback for an unknown (source, type) pair or a typeless subject. */
const NEUTRAL_ICON: IconSpec = {
  Icon: Document16Filled,
  color: tokens.colorNeutralForeground3,
  label: "Item",
};

/**
 * PRESENTATION-LAYER registry keyed by (event source prefix, subject_type). This
 * mapping lives entirely in the web layer — the core stays domain-neutral and
 * only ever forwards `subject_type` as an opaque string. Colors approximate
 * ADO's own work-item icons; no data value is ever branched on in the backend.
 */
const ICON_REGISTRY: Record<string, Record<string, IconSpec>> = {
  ado: {
    Bug: { Icon: Bug16Filled, color: "#CC293D", label: "Bug" },
    "User Story": {
      Icon: BookOpen16Filled,
      color: "#009CCC",
      label: "User Story",
    },
    Epic: { Icon: Crown16Filled, color: "#FF7B00", label: "Epic" },
    Task: { Icon: ClipboardTask16Filled, color: "#F2CB1D", label: "Task" },
    Initiative: { Icon: Crown16Filled, color: "#773B93", label: "Initiative" },
  },
};

/**
 * Choose the icon for a subject from the registry, keyed by the event source
 * prefix (the segment before the first `.` in `event_type`, e.g. `ado`) and the
 * opaque `subject_type`. Falls back to a neutral document glyph for any unknown
 * combination, including a missing type.
 */
export function iconForSubject(fields: Partial<SubjectFields>): IconSpec {
  const eventType = fields.event_type;
  const sourcePrefix =
    typeof eventType === "string" && eventType.length > 0
      ? eventType.split(".")[0]
      : "";
  const subjectType = fields.subject_type;
  if (sourcePrefix && typeof subjectType === "string") {
    const spec = ICON_REGISTRY[sourcePrefix]?.[subjectType];
    if (spec) return spec;
  }
  return NEUTRAL_ICON;
}

/**
 * The human label for a subject: its `subject_title` when present, else a
 * generic `"<kind> <ref>"` fallback (e.g. `"workitem 42"`), else null when the
 * subject is entirely unknown. Payloads are opaque, so a missing title is
 * expected — never assumed. Exported for the detail view and for tests.
 */
export function subjectLabel(fields: Partial<SubjectFields>): string | null {
  const title = fields.subject_title;
  if (typeof title === "string" && title.length > 0) return title;
  const kind = fields.subject_kind;
  const ref = fields.subject_ref;
  const parts = [kind, ref].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Render the (aria-hidden) leading type glyph, tinted per the registry. */
function SubjectIcon({ spec }: { spec: IconSpec }) {
  const styles = useStyles();
  const { Icon } = spec;
  return (
    <span
      className={styles.icon}
      style={{ color: spec.color }}
      aria-hidden
      title={spec.label}
    >
      <Icon />
    </span>
  );
}

/**
 * Render a subject as a compact stack: the subject reference (e.g. an ADO
 * work-item id) as a leading `#<ref>` chip, a type icon and the subject label on
 * one row (the icon+label hyperlinked to `subject_url` when present, opening in
 * a new tab), and the event type — when shown — on a smaller secondary line
 * beneath. The label truncates with an ellipsis and carries a `title` for
 * hover/reading, while the ref chip never truncates so the id stays legible. A
 * subject with no label at all renders a muted em dash.
 *
 * The ref chip is shown only when a `subject_title` is present — without a title
 * the label already falls back to `"<kind> <ref>"`, which carries the ref, so a
 * chip would just duplicate it.
 *
 * `showEventType` (default true) is set false where the embedding table already
 * has a dedicated event-type column or row, so the type is never duplicated.
 */
export function SubjectCell({
  fields,
  showEventType = true,
}: {
  fields: Partial<SubjectFields>;
  showEventType?: boolean;
}) {
  const styles = useStyles();
  const label = subjectLabel(fields);

  if (label === null) {
    return (
      <Text className={styles.muted} aria-label="No subject">
        —
      </Text>
    );
  }

  const spec = iconForSubject(fields);
  const url = fields.subject_url;
  const eventType = fields.event_type;

  // Show the ref as its own chip only when the title carries the label; the
  // titleless fallback already folds the ref into `label`.
  const title = fields.subject_title;
  const ref = fields.subject_ref;
  const showRef =
    typeof title === "string" &&
    title.length > 0 &&
    typeof ref === "string" &&
    ref.length > 0;

  const inner = (
    <>
      <SubjectIcon spec={spec} />
      <span className={styles.title}>{label}</span>
    </>
  );

  const titleRow =
    typeof url === "string" && url.length > 0 ? (
      <Link
        className={styles.titleRow}
        href={url}
        target="_blank"
        rel="noreferrer"
        title={label}
        // Row click navigates to the detail view; the external link should not
        // also trigger that navigation.
        onClick={(e) => e.stopPropagation()}
      >
        {inner}
      </Link>
    ) : (
      <span className={styles.titleRow} title={label}>
        {inner}
      </span>
    );

  return (
    <span className={styles.stack}>
      <span className={styles.identity}>
        {showRef && (
          <Text
            as="span"
            className={styles.ref}
            title={`Reference ${ref as string}`}
          >
            #{ref}
          </Text>
        )}
        {titleRow}
      </span>
      {showEventType &&
        typeof eventType === "string" &&
        eventType.length > 0 && (
          <Text as="span" className={styles.eventType} title={eventType}>
            {eventType}
          </Text>
        )}
    </span>
  );
}
