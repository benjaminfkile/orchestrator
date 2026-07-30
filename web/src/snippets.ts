// Typed data-access helpers for the Snippets page and the playbook editor's
// snippet pickers. These wrap the generic `apiFetch` in named, strongly-typed
// calls so pages stay declarative and their tests can mock this module
// wholesale. `/api/snippets` exposes CRUD over reusable, user-authored template
// fragments resolved at DISPATCH TIME, so editing one propagates to every
// playbook that references it by name.

import { apiFetch } from "./api";

/**
 * The three snippet kinds. Each has a DIFFERENT composition model resolved at
 * dispatch time (see the backend executor):
 *   - `prompt`   — stackable `{{snippet.<name>}}` tokens inside a prompt_template
 *   - `userdata` — a single whole-value `snippet:<name>` reference
 *   - `step`     — a whole saved command referenced per step (`snippet:<name>`)
 * Intent lives entirely in the name/description/content — never in a code branch.
 */
export type SnippetKind = "prompt" | "userdata" | "step";

/** The three valid {@link SnippetKind} values, in display order. */
export const SNIPPET_KINDS: readonly SnippetKind[] = [
  "prompt",
  "userdata",
  "step",
];

/** A snippet record as returned by `GET /api/snippets`, newest-first. `name` is
 * unique WITHIN a `kind` (references are by name), so a rename breaks every
 * reference on purpose — the dispatch fails loudly, like a missing secret. */
export interface SnippetRecord {
  id: number;
  kind: SnippetKind;
  name: string;
  description: string;
  content: string;
  created_at: number;
  updated_at: number;
}

/** Fields sent when creating a snippet; kind, name and content are required. */
export interface NewSnippet {
  kind: SnippetKind;
  name: string;
  content: string;
  description?: string;
}

/** Fields sent when updating a snippet. Any omitted field is left unchanged. */
export interface SnippetUpdate {
  kind?: SnippetKind;
  name?: string;
  content?: string;
  description?: string;
}

/** List snippets newest-first; an optional `kind` narrows the result server-side. */
export function listSnippets(kind?: SnippetKind): Promise<SnippetRecord[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return apiFetch<SnippetRecord[]>(`/snippets${query}`);
}

/** Create a snippet; resolves to the stored record. */
export function createSnippet(snippet: NewSnippet): Promise<SnippetRecord> {
  return apiFetch<SnippetRecord>(`/snippets`, {
    method: "POST",
    body: snippet,
  });
}

/** Apply a partial update to a snippet; resolves to the updated record. */
export function updateSnippet(
  id: number,
  patch: SnippetUpdate,
): Promise<SnippetRecord> {
  return apiFetch<SnippetRecord>(`/snippets/${id}`, {
    method: "PATCH",
    body: patch,
  });
}

/** Delete a snippet by id. Resolves once the backend returns 204. */
export function deleteSnippet(id: number): Promise<void> {
  return apiFetch<void>(`/snippets/${id}`, { method: "DELETE" });
}
