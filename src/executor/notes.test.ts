import { parseNotes } from "./notes";

describe("parseNotes", () => {
  function block(body: string): string {
    return `<NOTES_TO_SAVE>${body}</NOTES_TO_SAVE>`;
  }

  it("collects notes from a single valid block", () => {
    const output = block(
      JSON.stringify([
        { content: "hello", visibility: "siblings", tags: ["ctx"] },
      ])
    );
    const { notes, warnings } = parseNotes(output);
    expect(warnings).toEqual([]);
    expect(notes).toEqual([
      { content: "hello", visibility: "siblings", tags: ["ctx"] },
    ]);
  });

  it("defaults visibility to all and omits tags when absent", () => {
    const output = block(JSON.stringify([{ content: "note" }]));
    const { notes } = parseNotes(output);
    expect(notes).toEqual([{ content: "note", visibility: "all" }]);
    expect(notes[0]).not.toHaveProperty("tags");
  });

  it("collects across multiple blocks", () => {
    const output = [
      block(JSON.stringify([{ content: "a" }])),
      "some noise between blocks",
      block(JSON.stringify([{ content: "b", visibility: "self" }])),
    ].join("\n");
    const { notes, warnings } = parseNotes(output);
    expect(warnings).toEqual([]);
    expect(notes).toEqual([
      { content: "a", visibility: "all" },
      { content: "b", visibility: "self" },
    ]);
  });

  it("skips invalid entries within an otherwise valid block and warns", () => {
    const output = block(
      JSON.stringify([
        { content: "keep" },
        { content: "" },
        { content: 123 },
        { content: "bad-vis", visibility: "nowhere" },
        { content: "bad-tags", tags: [1, 2] },
        { content: "keep-2", visibility: "ancestors" },
        "not-an-object",
      ])
    );
    const { notes, warnings } = parseNotes(output);
    expect(notes).toEqual([
      { content: "keep", visibility: "all" },
      { content: "keep-2", visibility: "ancestors" },
    ]);
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toContain("entry #1");
    expect(warnings[0]).toContain("content");
  });

  it("warns when a block body is not valid JSON", () => {
    const output = block("{ not json array");
    const { notes, warnings } = parseNotes(output);
    expect(notes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not valid JSON");
  });

  it("warns when a block body parses to a non-array", () => {
    const output = block(JSON.stringify({ content: "obj not array" }));
    const { notes, warnings } = parseNotes(output);
    expect(notes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a JSON array");
  });

  it("keeps valid notes from a later block after an earlier bad block", () => {
    const output = [
      block("garbage"),
      block(JSON.stringify([{ content: "survivor" }])),
    ].join("\n");
    const { notes, warnings } = parseNotes(output);
    expect(notes).toEqual([{ content: "survivor", visibility: "all" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("block #0");
  });

  it("returns empty results when there are no note blocks", () => {
    const { notes, warnings } = parseNotes("no blocks here at all");
    expect(notes).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("accepts every documented visibility value", () => {
    const output = block(
      JSON.stringify([
        { content: "1", visibility: "self" },
        { content: "2", visibility: "siblings" },
        { content: "3", visibility: "descendants" },
        { content: "4", visibility: "ancestors" },
        { content: "5", visibility: "all" },
      ])
    );
    const { notes, warnings } = parseNotes(output);
    expect(warnings).toEqual([]);
    expect(notes.map((n) => n.visibility)).toEqual([
      "self",
      "siblings",
      "descendants",
      "ancestors",
      "all",
    ]);
  });
});
