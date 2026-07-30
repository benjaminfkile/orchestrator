import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { runMigrations } from "./migrate";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  listPlaybooks,
  updatePlaybook,
} from "./playbooks";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-playbooks-"));
  return path.join(dir, "test.sqlite");
}

const base = {
  name: "researcher",
  image: "ghcr.io/example/agent:latest",
  ttl_seconds: 900,
};

describe("playbooks repo", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    // Start from an empty table: migrations seed a built-in `researcher`
    // playbook, but these tests exercise CRUD against a clean slate.
    await db("playbooks").del();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("creates a playbook and reads it back with decoded JSON columns", async () => {
    const created = await createPlaybook(
      {
        ...base,
        resources: { cpus: 2, memory_mb: 2048, pids: 256 },
        network: "none",
        userdata_template: "#!/bin/sh\necho hi",
        prompt_template: "Investigate {{subject_ref}}",
        runner: "claude-code",
        runner_config: { model: "claude-opus-4-8", allowed_tools: ["Read", "Grep"] },
        env_requirements: ["ADO_TOKEN"],
        steps: [{ phase: "pre", run: "echo setup" }],
        output_kind: "report",
      },
      db
    );

    expect(created.id).toBeGreaterThan(0);
    expect(created.resources).toEqual({ cpus: 2, memory_mb: 2048, pids: 256 });
    expect(created.network).toBe("none");
    expect(created.runner).toBe("claude-code");
    expect(created.runner_config).toEqual({
      model: "claude-opus-4-8",
      allowed_tools: ["Read", "Grep"],
    });
    expect(created.env_requirements).toEqual(["ADO_TOKEN"]);
    expect(created.steps).toEqual([{ phase: "pre", run: "echo setup" }]);
    expect(created.granted_capabilities).toEqual([]);
    expect(created.output_kind).toBe("report");
    expect(created.created_at).toBe(created.updated_at);

    const fetched = await getPlaybook(created.id, db);
    expect(fetched).toEqual(created);
  });

  it("applies defaults for omitted fields", async () => {
    const created = await createPlaybook({ ...base }, db);
    expect(created.resources).toEqual({});
    expect(created.network).toBe("open");
    expect(created.userdata_template).toBe("");
    expect(created.prompt_template).toBe("");
    expect(created.runner).toBe("claude-code");
    expect(created.runner_config).toEqual({});
    expect(created.env_requirements).toEqual([]);
    expect(created.steps).toEqual([]);
    expect(created.granted_capabilities).toEqual([]);
    expect(created.output_kind).toBe("findings");
    // No isolation given -> null (let the server apply its default).
    expect(created.isolation).toBeNull();
  });

  it("round-trips isolation and lets null clear it back to the default", async () => {
    const created = await createPlaybook({ ...base, isolation: "vm" }, db);
    expect(created.isolation).toBe("vm");
    expect((await getPlaybook(created.id, db))?.isolation).toBe("vm");

    // A patch omitting isolation leaves it unchanged...
    const untouched = await updatePlaybook(created.id, { image: "x" }, db);
    expect(untouched?.isolation).toBe("vm");

    // ...and an explicit null clears it back to the server default.
    const cleared = await updatePlaybook(created.id, { isolation: null }, db);
    expect(cleared?.isolation).toBeNull();
  });

  it("round-trips granted_capabilities through create and update", async () => {
    const grants = [
      { capability_id: "ado.get_work_item", config: { org: "acme" } },
      { capability_id: "other.thing" },
    ];
    const created = await createPlaybook(
      { ...base, granted_capabilities: grants },
      db
    );
    expect(created.granted_capabilities).toEqual(grants);
    expect((await getPlaybook(created.id, db))?.granted_capabilities).toEqual(
      grants
    );

    const updated = await updatePlaybook(
      created.id,
      { granted_capabilities: [{ capability_id: "ado.get_work_item" }] },
      db
    );
    expect(updated?.granted_capabilities).toEqual([
      { capability_id: "ado.get_work_item" },
    ]);

    // Other fields left untouched by a granted_capabilities-only update.
    expect(updated?.name).toBe(created.name);
  });

  it("round-trips an opaque runner_config through create and read-back", async () => {
    const config = { model: "x", allowed_tools: ["Read"], nested: { a: 1 } };
    const created = await createPlaybook(
      { ...base, name: "n1", runner: "claude-code", runner_config: config },
      db
    );
    expect(created.runner_config).toEqual(config);
    expect((await getPlaybook(created.id, db))?.runner_config).toEqual(config);

    // An omitted runner_config defaults to an empty object, never null.
    const bare = await createPlaybook({ ...base, name: "n2" }, db);
    expect(bare.runner_config).toEqual({});
  });

  it("enforces a unique name", async () => {
    await createPlaybook({ ...base }, db);
    await expect(createPlaybook({ ...base }, db)).rejects.toThrow();
  });

  it("returns undefined for a missing playbook", async () => {
    expect(await getPlaybook(9999, db)).toBeUndefined();
  });

  it("lists playbooks newest-first", async () => {
    const a = await createPlaybook({ ...base, name: "a" }, db);
    const b = await createPlaybook({ ...base, name: "b" }, db);
    const rows = await listPlaybooks(db);
    expect(rows.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("updates only the provided fields and bumps updated_at", async () => {
    const created = await createPlaybook(
      { ...base, prompt_template: "orig" },
      db
    );

    const updated = await updatePlaybook(
      created.id,
      {
        ttl_seconds: 1200,
        resources: { cpus: 4 },
        runner_config: { model: "claude-sonnet-5", allowed_tools: ["Bash"] },
      },
      db
    );

    expect(updated).toBeDefined();
    expect(updated?.ttl_seconds).toBe(1200);
    expect(updated?.resources).toEqual({ cpus: 4 });
    expect(updated?.runner_config).toEqual({
      model: "claude-sonnet-5",
      allowed_tools: ["Bash"],
    });
    expect(updated?.prompt_template).toBe("orig");
    expect(updated?.name).toBe(created.name);
    expect(updated?.created_at).toBe(created.created_at);
    expect(updated?.updated_at).toBeGreaterThanOrEqual(created.updated_at);
  });

  it("replaces runner_config wholesale via update", async () => {
    const created = await createPlaybook(
      { ...base, runner_config: { allowed_tools: ["Read"] } },
      db
    );
    const updated = await updatePlaybook(created.id, { runner_config: {} }, db);
    expect(updated?.runner_config).toEqual({});
  });

  it("returns undefined when updating a missing playbook", async () => {
    expect(await updatePlaybook(9999, { image: "x" }, db)).toBeUndefined();
  });

  it("deletes a playbook and reports whether a row was removed", async () => {
    const created = await createPlaybook({ ...base }, db);
    expect(await deletePlaybook(created.id, db)).toBe(true);
    expect(await getPlaybook(created.id, db)).toBeUndefined();
    expect(await deletePlaybook(created.id, db)).toBe(false);
  });
});
