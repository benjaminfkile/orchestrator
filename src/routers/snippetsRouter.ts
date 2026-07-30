import express from "express";

import {
  createSnippet,
  deleteSnippet,
  getSnippet,
  listSnippets,
  updateSnippet,
} from "../db/snippets";
import { SNIPPET_KINDS, type SnippetKind } from "../interfaces";

import {
  handler,
  HttpError,
  optionalString,
  parseIdParam,
  rejectUnknownKeys,
  requireBody,
  requireString,
} from "./http";

/**
 * `/api/snippets` — CRUD for reusable, user-authored template fragments resolved
 * at DISPATCH TIME (see the executor), so editing one propagates to every
 * playbook that references it.
 *
 *   GET /            list newest-first; optional `?kind=` filter
 *   GET /:id         one snippet, 404 when absent
 *   POST /           create (kind + name + content required; kind validated;
 *                    duplicate (kind, name) -> 409)
 *   PATCH /:id       partial update, 404 when absent
 *   DELETE /:id      remove, 404 when absent
 *
 * References are BY NAME within a kind, so a PATCH that renames (or re-kinds) a
 * snippet BREAKS every reference to it — BY DESIGN. There is no back-reference
 * bookkeeping: the break surfaces LOUDLY as a dispatch failure ("unknown <kind>
 * snippet") the next time a referencing playbook runs, exactly like a missing
 * secret, rather than silently dropping template text.
 */
const snippetsRouter = express.Router();

/** The keys a snippet request body may carry. */
const SNIPPET_KEYS = ["kind", "name", "description", "content"] as const;

/**
 * Validate a required `kind` field against {@link SNIPPET_KINDS}, throwing 400
 * otherwise. Returned narrowed so callers can pass it straight to the repo.
 */
function requireKind(value: unknown): SnippetKind {
  if (typeof value !== "string" || !SNIPPET_KINDS.includes(value as SnippetKind)) {
    throw new HttpError(
      400,
      `kind must be one of ${SNIPPET_KINDS.join(", ")}`
    );
  }
  return value as SnippetKind;
}

/**
 * Validate an optional `kind` query-string filter, returning it narrowed or
 * `undefined` when absent. A present-but-invalid kind is a 400.
 */
function optionalKindQuery(value: unknown): SnippetKind | undefined {
  if (value === undefined) return undefined;
  return requireKind(value);
}

snippetsRouter.get(
  "/",
  handler(async (req, res) => {
    const kind = optionalKindQuery(req.query.kind);
    res.status(200).json(await listSnippets(kind));
  })
);

snippetsRouter.get(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const snippet = await getSnippet(id);
    if (!snippet) {
      res.status(404).json({ error: "snippet not found" });
      return;
    }
    res.status(200).json(snippet);
  })
);

snippetsRouter.post(
  "/",
  handler(async (req, res) => {
    const body = requireBody(req.body);
    rejectUnknownKeys(body, SNIPPET_KEYS, "snippet");
    const kind = requireKind(body.kind);
    const name = requireString(body.name, "name");
    const content = requireString(body.content, "content");
    optionalString(body.description, "description");
    try {
      const created = await createSnippet({
        kind,
        name,
        content,
        description: body.description as string | undefined,
      });
      res.status(201).json(created);
    } catch {
      // The repo enforces UNIQUE(kind, name) with a pre-check; a clash is the
      // only expected failure here and maps to 409.
      throw new HttpError(
        409,
        `snippet "${name}" of kind "${kind}" already exists`
      );
    }
  })
);

snippetsRouter.patch(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const body = requireBody(req.body);
    rejectUnknownKeys(body, SNIPPET_KEYS, "snippet");
    // A rename or re-kind is allowed and deliberately breaks references by name.
    const kind = body.kind !== undefined ? requireKind(body.kind) : undefined;
    if (body.name !== undefined) requireString(body.name, "name");
    if (body.content !== undefined) requireString(body.content, "content");
    optionalString(body.description, "description");
    const updated = await updateSnippet(id, {
      kind,
      name: body.name as string | undefined,
      content: body.content as string | undefined,
      description: body.description as string | undefined,
    });
    if (!updated) {
      res.status(404).json({ error: "snippet not found" });
      return;
    }
    res.status(200).json(updated);
  })
);

snippetsRouter.delete(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (!(await deleteSnippet(id))) {
      res.status(404).json({ error: "snippet not found" });
      return;
    }
    res.status(204).end();
  })
);

export default snippetsRouter;
