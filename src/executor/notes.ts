/**
 * NOTES_TO_SAVE parsing: extract findings from an agent's result text.
 *
 * This is an ENGINE-NEUTRAL executor concern, not a runner one — it operates on
 * the `resultText` a runner returns, never on raw engine output. The runner has
 * already isolated the result envelope; this module only understands the
 * `<NOTES_TO_SAVE>` protocol the prompt asks agents to follow.
 *
 * Every function here is total and side-effect-free: it takes a string and
 * returns data. No I/O, no logging, no throwing on malformed input — invalid
 * blocks and entries are skipped and explained in the returned warnings.
 */

/** Visibility values accepted on a saved note (see the NOTES_TO_SAVE protocol). */
export type NoteVisibility =
  | "self"
  | "siblings"
  | "descendants"
  | "ancestors"
  | "all";

/** A single validated note extracted from a `<NOTES_TO_SAVE>` block. */
export interface ParsedNote {
  content: string;
  /** Defaults to `"all"` when the source entry omits it. */
  visibility: NoteVisibility;
  tags?: string[];
}

/** Result of {@link parseNotes}: the valid notes plus one warning per skip. */
export interface ParsedNotesResult {
  notes: ParsedNote[];
  /** Human-readable reasons for every block/entry that was skipped. */
  warnings: string[];
}

/** The full ordered set of accepted note visibilities. */
const NOTE_VISIBILITIES: readonly NoteVisibility[] = [
  "self",
  "siblings",
  "descendants",
  "ancestors",
  "all",
];

/** Matches each note block; the capture group is the JSON body. */
const NOTES_BLOCK_RE = /<NOTES_TO_SAVE>([\s\S]*?)<\/NOTES_TO_SAVE>/g;

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a single raw note entry into a {@link ParsedNote}. */
function validateNote(
  entry: unknown
): { ok: true; note: ParsedNote } | { ok: false; reason: string } {
  if (!isRecord(entry)) return { ok: false, reason: "entry is not an object" };

  const { content } = entry;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, reason: "content must be a non-empty string" };
  }

  let visibility: NoteVisibility = "all";
  if (entry.visibility !== undefined) {
    if (
      typeof entry.visibility !== "string" ||
      !NOTE_VISIBILITIES.includes(entry.visibility as NoteVisibility)
    ) {
      return {
        ok: false,
        reason:
          "visibility must be one of self|siblings|descendants|ancestors|all",
      };
    }
    visibility = entry.visibility as NoteVisibility;
  }

  let tags: string[] | undefined;
  if (entry.tags !== undefined) {
    if (
      !Array.isArray(entry.tags) ||
      !entry.tags.every((tag) => typeof tag === "string")
    ) {
      return { ok: false, reason: "tags must be an array of strings" };
    }
    tags = entry.tags as string[];
  }

  const note: ParsedNote = { content, visibility };
  if (tags !== undefined) note.tags = tags;
  return { ok: true, note };
}

/**
 * Collect every `<NOTES_TO_SAVE>...</NOTES_TO_SAVE>` block. Each block body must
 * parse as a JSON array of note objects. Invalid blocks and invalid entries are
 * skipped (never fatal) and explained in the returned `warnings`.
 */
export function parseNotes(output: string): ParsedNotesResult {
  const notes: ParsedNote[] = [];
  const warnings: string[] = [];

  let blockIndex = 0;
  for (const match of output.matchAll(NOTES_BLOCK_RE)) {
    const body = match[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      warnings.push(`block #${blockIndex}: body is not valid JSON`);
      blockIndex += 1;
      continue;
    }
    if (!Array.isArray(parsed)) {
      warnings.push(`block #${blockIndex}: body is not a JSON array`);
      blockIndex += 1;
      continue;
    }
    parsed.forEach((entry, entryIndex) => {
      const result = validateNote(entry);
      if (result.ok) {
        notes.push(result.note);
      } else {
        warnings.push(
          `block #${blockIndex} entry #${entryIndex}: ${result.reason}`
        );
      }
    });
    blockIndex += 1;
  }

  return { notes, warnings };
}
