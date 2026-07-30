/**
 * Pure prompt builder for the executor.
 *
 * `buildPrompt` composes the single prompt string handed to the headless agent
 * step from an event, its playbook, and any capability-supplied context. It is
 * total and side-effect-free: no I/O, no logging, and template substitution
 * never throws on a missing path.
 *
 * Per the architecture principle this module is domain-neutral — it only shapes
 * generic fields (`source`, `type`, `subject_ref`, `payload`) and renders the
 * playbook's own `prompt_template`. Any intent lives entirely in that template's
 * text and the event data, never in a code branch here.
 */

/** The event fields surfaced to the agent and available for substitution. */
export interface PromptEvent {
  id: number;
  source: string;
  type: string;
  subject_ref: string;
  payload: unknown;
}

/** One labeled block of capability-supplied context, rendered verbatim. */
export interface CapabilityContextEntry {
  label: string;
  content: string;
}

/** Everything {@link buildPrompt} needs to compose a prompt. */
export interface BuildPromptInput {
  event: PromptEvent;
  /** Only the playbook's `prompt_template` participates in the prompt. */
  playbook: { prompt_template: string };
  /**
   * Body of the "## Working environment" section, authored by the executor
   * (working directory, ephemerality note, …). Rendered verbatim.
   */
  workingEnvironment: string;
  /** Zero or more labeled context blocks; defaults to none. */
  capabilityContext?: CapabilityContextEntry[];
  /**
   * Fully-resolved `prompt`-kind snippets keyed by name, used to substitute the
   * `{{snippet.<name>}}` tokens in `prompt_template`. Each value is already
   * expanded (its own nested snippets and `{{event/payload/env}}` tokens
   * rendered) by the executor before leasing; buildPrompt only splices it in.
   * Absent when the template references no snippets.
   */
  promptSnippets?: Map<string, string>;
}

/** Matches a `{{ dotted.path }}` template token, capturing the trimmed path. */
const TEMPLATE_TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * The token root that references a `prompt`-kind snippet: `{{snippet.<name>}}`.
 * Unlike every other root this one is NOT resolved by dotted-path traversal — the
 * whole remainder after the prefix is the snippet name (so a name may itself
 * contain dots) and it is looked up in the caller-supplied snippets map.
 */
export const SNIPPET_TOKEN_PREFIX = "snippet.";

/** Static protocol doc appended last, verbatim, to every prompt. */
const NOTES_PROTOCOL = `## Saving findings

You may emit one or more \`<NOTES_TO_SAVE>\` blocks anywhere in your output. Each
block contains a JSON array of note objects; their contents will be persisted as
findings. A note object has a required \`content\` string, a \`visibility\` of one
of self|siblings|descendants|ancestors|all (defaults to "all"), and an optional
\`tags\` string array. For example:

<NOTES_TO_SAVE>
[{"content": "...", "visibility": "all", "tags": []}]
</NOTES_TO_SAVE>`;

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk a dotted `path` through `root`, returning the value found or `undefined`
 * as soon as a segment is missing or a non-object is traversed. Never throws.
 */
function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Render a resolved value as a string; missing/nullish renders as empty. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Substitute `{{...}}` tokens in `template`. Supported roots are `event`
 * (exposing `type`, `source`, `subject_ref`), `payload` (any dotted path into
 * the event payload), and — when supplied via `extra.env` — `env` (a flat map of
 * resolved secret names to values, for step command templates). Any token that
 * resolves to nothing — an unknown root or a missing path — renders as the empty
 * string and never throws.
 *
 * Exported so the executor can render a playbook's `userdata_template` and its
 * step `command_template`s with the exact same engine used for prompts — the
 * substitution behavior must not drift between them.
 */
export function renderTemplate(
  template: string,
  event: PromptEvent,
  extra?: { env?: Record<string, string>; snippets?: Map<string, string> },
): string {
  const context: Record<string, unknown> = {
    event: {
      type: event.type,
      source: event.source,
      subject_ref: event.subject_ref,
    },
    payload: event.payload,
  };
  if (extra?.env) context.env = extra.env;
  const snippets = extra?.snippets;
  return template.replace(TEMPLATE_TOKEN_RE, (_match, path: string) => {
    // `{{snippet.<name>}}` tokens are spliced from the pre-resolved map (the
    // executor expands and validates them before leasing). The remainder after
    // the prefix is the whole name — never a dotted path. Without a map the
    // token falls through to the normal engine and renders empty, so this stays
    // a pure superset of the base behavior.
    if (snippets && path.startsWith(SNIPPET_TOKEN_PREFIX)) {
      return snippets.get(path.slice(SNIPPET_TOKEN_PREFIX.length)) ?? "";
    }
    return renderValue(resolvePath(context, path));
  });
}

/**
 * Scan a template for `{{snippet.<name>}}` tokens, returning the distinct snippet
 * names in first-seen order. Pure and sync: the executor uses it to discover which
 * `prompt`-kind snippets a template (or a snippet's own content) references so it
 * can load and expand them before leasing. Non-snippet tokens are ignored.
 */
export function scanSnippetRefs(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_TOKEN_RE)) {
    const path = match[1];
    if (path.startsWith(SNIPPET_TOKEN_PREFIX)) {
      const name = path.slice(SNIPPET_TOKEN_PREFIX.length);
      if (name.length > 0 && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Compose the full agent prompt. Sections always appear in this order:
 *   1. Header + pretty-printed event JSON.
 *   2. "## Working environment" (executor-supplied body).
 *   3. "Instructions:" block.
 *   4. The playbook's `prompt_template` with `{{...}}` substitution applied.
 *   5. One labeled section per capability-context entry, in order.
 *   6. The NOTES_TO_SAVE protocol doc (always last).
 */
export function buildPrompt(input: BuildPromptInput): string {
  const {
    event,
    playbook,
    workingEnvironment,
    capabilityContext = [],
    promptSnippets,
  } = input;

  const eventJson = JSON.stringify(
    {
      event: {
        id: event.id,
        source: event.source,
        type: event.type,
        subject_ref: event.subject_ref,
        payload: event.payload,
      },
    },
    null,
    2,
  );

  const sections: string[] = [
    `You are an automated agent. You have been dispatched for the following event:\n\n${eventJson}`,
    `## Working environment\n\n${workingEnvironment}`,
    [
      "Instructions:",
      "- Complete the work described by the playbook below.",
      "- Do not attempt to manage, extend, or terminate your own lease or container.",
      "- Save any work product to disk before finishing.",
    ].join("\n"),
    renderTemplate(playbook.prompt_template, event, {
      snippets: promptSnippets,
    }),
    ...capabilityContext.map(
      (entry) => `## ${entry.label}\n\n${entry.content}`,
    ),
    NOTES_PROTOCOL,
  ];

  return sections.join("\n\n");
}
