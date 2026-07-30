import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // snippets: reusable, user-authored template fragments resolved at DISPATCH
  // TIME so editing one propagates to every playbook that references it. `kind`
  // partitions the store into three composition models (see the executor):
  //   - 'prompt'   — stackable {{snippet.<name>}} tokens inside prompt_template
  //   - 'userdata' — a single whole-value `snippet:<name>` reference
  //   - 'step'     — a whole saved command picked per step / script runner
  // Intent lives entirely in the name/description/content — no code branches on
  // it. References are BY NAME, so (kind, name) is unique; a rename breaks every
  // reference by design (the dispatch fails loudly, like a missing secret).
  await knex.schema.createTable("snippets", (table) => {
    table.increments("id").primary();
    table.text("kind").notNullable().checkIn(["prompt", "userdata", "step"]);
    table.text("name").notNullable();
    table.text("description").notNullable().defaultTo("");
    table.text("content").notNullable();
    table.bigInteger("created_at").notNullable();
    table.bigInteger("updated_at").notNullable();
    table.unique(["kind", "name"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("snippets");
}
