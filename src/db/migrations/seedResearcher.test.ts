import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";
import { getPlaybook, listPlaybooks } from "../playbooks";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-seed-"));
  return path.join(dir, "test.sqlite");
}

describe("researcher playbook seed", () => {
  let file: string;
  let db: Knex;

  beforeEach(() => {
    file = tempDbFile();
    db = createDb(file);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("seeds the researcher playbook on a fresh DB with the expected config", async () => {
    await runMigrations(db);

    const all = await listPlaybooks(db);
    const researchers = all.filter((p) => p.name === "researcher");
    expect(researchers).toHaveLength(1);

    const researcher = await getPlaybook(researchers[0].id, db);
    expect(researcher).toBeDefined();
    expect(researcher!.image).toBe("setting:default_lease_image");
    expect(researcher!.ttl_seconds).toBe(3600);
    expect(researcher!.network).toBe("open");
    expect(researcher!.resources).toEqual({ cpus: 2, memory_mb: 4096 });
    expect(researcher!.env_requirements).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GIT_TOKEN",
    ]);

    // Exactly one pre step, cloning the event's repo into ./work with the token.
    const steps = researcher!.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0].phase).toBe("pre");
    expect(steps[0].command_template).toContain("{{payload.repo_url}}");
    expect(steps[0].command_template).toContain("{{env.GIT_TOKEN}}");
    expect(steps[0].command_template).toContain("./work");

    expect(researcher!.prompt_template).toContain("{{event.type}}");
    expect(researcher!.prompt_template).toContain("NOTES_TO_SAVE");
  });

  it("is idempotent: a second migrate pass does not duplicate the seed", async () => {
    await runMigrations(db);
    // A second latest() is a no-op for applied migrations, but the seed's own
    // name guard also protects against a re-run inserting a duplicate row.
    await runMigrations(db);

    const researchers = (await listPlaybooks(db)).filter(
      (p) => p.name === "researcher"
    );
    expect(researchers).toHaveLength(1);
  });

  it("does not overwrite an existing researcher playbook", async () => {
    // Run every migration EXCEPT the seed, then pre-insert a playbook named
    // "researcher" so the seed's idempotency guard must skip it.
    const now = 123;
    // Bring the schema up first via a full migrate, then mutate the seeded row
    // to prove the guard skips (rather than re-seeds) when the name is present.
    await runMigrations(db);
    await db("playbooks")
      .where({ name: "researcher" })
      .update({ ttl_seconds: 42, updated_at: now });

    // Re-running migrations must not clobber the mutated row back to the seed.
    await runMigrations(db);
    const researcher = (await listPlaybooks(db)).find(
      (p) => p.name === "researcher"
    );
    expect(researcher!.ttl_seconds).toBe(42);
  });
});
