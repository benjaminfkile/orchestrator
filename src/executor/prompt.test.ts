import {
  buildPrompt,
  renderTemplate,
  scanSnippetRefs,
  type BuildPromptInput,
  type PromptEvent,
} from "./prompt";

/** A representative event; individual tests override fields as needed. */
function makeEvent(overrides: Partial<PromptEvent> = {}): PromptEvent {
  return {
    id: 7,
    source: "ado",
    type: "work_item.updated",
    subject_ref: "AB#123",
    payload: { title: "Fix login", nested: { level: "high" }, count: 3 },
    ...overrides,
  };
}

/** A minimal, valid input; individual tests override fields as needed. */
function makeInput(overrides: Partial<BuildPromptInput> = {}): BuildPromptInput {
  return {
    event: makeEvent(),
    playbook: { prompt_template: "Do the thing." },
    workingEnvironment: "Working directory is /work. The container is ephemeral.",
    capabilityContext: [],
    ...overrides,
  };
}

describe("buildPrompt section order", () => {
  it("emits the six sections in the required order", () => {
    const prompt = buildPrompt(
      makeInput({
        playbook: { prompt_template: "PLAYBOOK_BODY" },
        capabilityContext: [
          { label: "Cap One", content: "CAP_ONE_BODY" },
          { label: "Cap Two", content: "CAP_TWO_BODY" },
        ],
      }),
    );

    const markers = [
      "You are an automated agent. You have been dispatched for the following event:",
      "## Working environment",
      "Instructions:",
      "PLAYBOOK_BODY",
      "## Cap One",
      "## Cap Two",
      "## Saving findings",
    ];

    const positions = markers.map((m) => prompt.indexOf(m));
    // Every marker is present...
    expect(positions.every((p) => p >= 0)).toBe(true);
    // ...and strictly increasing, i.e. in the exact order above.
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("puts the NOTES_TO_SAVE protocol doc last even with capabilities", () => {
    const prompt = buildPrompt(
      makeInput({
        capabilityContext: [{ label: "Ctx", content: "body" }],
      }),
    );
    expect(prompt.indexOf("## Saving findings")).toBeGreaterThan(
      prompt.indexOf("## Ctx"),
    );
    expect(prompt.trimEnd().endsWith("</NOTES_TO_SAVE>")).toBe(true);
  });

  it("keeps capability sections in the order provided", () => {
    const prompt = buildPrompt(
      makeInput({
        capabilityContext: [
          { label: "Beta", content: "b" },
          { label: "Alpha", content: "a" },
        ],
      }),
    );
    expect(prompt.indexOf("## Beta")).toBeLessThan(prompt.indexOf("## Alpha"));
  });

  it("omits any capability section when none are provided", () => {
    const prompt = buildPrompt(makeInput({ capabilityContext: [] }));
    // Between the instructions and the notes doc there are no `## ` capability
    // headers other than working-environment and saving-findings.
    const between = prompt.slice(
      prompt.indexOf("Save any work product"),
      prompt.indexOf("## Saving findings"),
    );
    expect(between).not.toContain("## ");
  });

  it("defaults capabilityContext to none when omitted", () => {
    const { capabilityContext: _omit, ...rest } = makeInput();
    const prompt = buildPrompt(rest);
    expect(prompt).toContain("## Saving findings");
  });
});

describe("buildPrompt header", () => {
  it("pretty-prints only the whitelisted event fields", () => {
    const event = makeEvent({
      id: 42,
      source: "src",
      type: "t",
      subject_ref: "ref",
      payload: { a: 1 },
    });
    const prompt = buildPrompt(makeInput({ event }));
    const expectedJson = JSON.stringify(
      {
        event: {
          id: 42,
          source: "src",
          type: "t",
          subject_ref: "ref",
          payload: { a: 1 },
        },
      },
      null,
      2,
    );
    expect(prompt).toContain(expectedJson);
  });

  it("does not leak non-whitelisted event fields into the header", () => {
    const event = {
      ...makeEvent(),
      subject_kind: "work_item",
      dedupe_key: "secret-key",
    } as unknown as PromptEvent;
    const prompt = buildPrompt(makeInput({ event }));
    const header = prompt.slice(0, prompt.indexOf("## Working environment"));
    expect(header).not.toContain("subject_kind");
    expect(header).not.toContain("secret-key");
  });
});

describe("buildPrompt working environment", () => {
  it("renders the executor-supplied body verbatim under the header", () => {
    const prompt = buildPrompt(
      makeInput({ workingEnvironment: "CWD=/data; disposable box." }),
    );
    expect(prompt).toContain(
      "## Working environment\n\nCWD=/data; disposable box.",
    );
  });
});

describe("buildPrompt instructions", () => {
  it("includes the lease/container and save-to-disk directives", () => {
    const prompt = buildPrompt(makeInput());
    expect(prompt).toContain("Instructions:");
    expect(prompt).toMatch(
      /do not attempt to manage, extend, or terminate your own lease or container/i,
    );
    expect(prompt).toMatch(/save any work product to disk before finishing/i);
  });
});

describe("buildPrompt template substitution", () => {
  it("substitutes event.type, event.source and event.subject_ref", () => {
    const prompt = buildPrompt(
      makeInput({
        event: makeEvent({
          type: "TT",
          source: "SS",
          subject_ref: "RR",
        }),
        playbook: {
          prompt_template: "[{{event.type}}][{{event.source}}][{{event.subject_ref}}]",
        },
      }),
    );
    expect(prompt).toContain("[TT][SS][RR]");
  });

  it("resolves dotted payload paths", () => {
    const prompt = buildPrompt(
      makeInput({
        event: makeEvent({
          payload: { title: "T", nested: { level: "deep" } },
        }),
        playbook: {
          prompt_template: "title={{payload.title}} level={{payload.nested.level}}",
        },
      }),
    );
    expect(prompt).toContain("title=T level=deep");
  });

  it("renders missing payload paths as the empty string, never throwing", () => {
    const prompt = buildPrompt(
      makeInput({
        event: makeEvent({ payload: { a: {} } }),
        playbook: {
          prompt_template: "x=[{{payload.a.b.c}}] y=[{{payload.missing}}]",
        },
      }),
    );
    expect(prompt).toContain("x=[] y=[]");
  });

  it("renders unknown roots and stray tokens as the empty string", () => {
    const prompt = buildPrompt(
      makeInput({
        event: makeEvent(),
        playbook: {
          prompt_template: "a=[{{event.unknown}}] b=[{{whatever}}] c=[{{bindings.x}}]",
        },
      }),
    );
    expect(prompt).toContain("a=[] b=[] c=[]");
  });

  it("stringifies non-string payload values", () => {
    const prompt = buildPrompt(
      makeInput({
        event: makeEvent({
          payload: { count: 3, flag: false, obj: { k: 1 } },
        }),
        playbook: {
          prompt_template: "n={{payload.count}} f={{payload.flag}} o={{payload.obj}}",
        },
      }),
    );
    expect(prompt).toContain('n=3 f=false o={"k":1}');
  });

  it("tolerates whitespace inside the token braces", () => {
    const prompt = buildPrompt(
      makeInput({
        event: makeEvent({ type: "WS" }),
        playbook: { prompt_template: "[{{  event.type  }}]" },
      }),
    );
    expect(prompt).toContain("[WS]");
  });

  it("does not treat payload paths as event fields or vice versa", () => {
    const prompt = buildPrompt(
      makeInput({
        event: makeEvent({ type: "real", payload: { type: "payload-type" } }),
        playbook: {
          prompt_template: "e={{event.type}} p={{payload.type}}",
        },
      }),
    );
    expect(prompt).toContain("e=real p=payload-type");
  });
});

describe("scanSnippetRefs", () => {
  it("returns distinct snippet names in first-seen order, ignoring other tokens", () => {
    const refs = scanSnippetRefs(
      "{{event.type}} {{snippet.intro}} {{payload.x}} {{ snippet.body }} {{snippet.intro}}",
    );
    expect(refs).toEqual(["intro", "body"]);
  });

  it("returns none when there are no snippet tokens", () => {
    expect(scanSnippetRefs("{{event.type}} plain")).toEqual([]);
  });

  it("treats a name with dots as a single whole name", () => {
    expect(scanSnippetRefs("{{snippet.a.b.c}}")).toEqual(["a.b.c"]);
  });
});

describe("renderTemplate snippet splicing", () => {
  const event = makeEvent();

  it("splices pre-resolved snippet content from the map", () => {
    const out = renderTemplate("before {{snippet.foo}} after", event, {
      snippets: new Map([["foo", "SPLICED"]]),
    });
    expect(out).toBe("before SPLICED after");
  });

  it("renders a snippet token as empty when no map is supplied", () => {
    expect(renderTemplate("x{{snippet.foo}}y", event)).toBe("xy");
  });

  it("renders a snippet token as empty when the name is absent from the map", () => {
    const out = renderTemplate("x{{snippet.missing}}y", event, {
      snippets: new Map([["foo", "F"]]),
    });
    expect(out).toBe("xy");
  });

  it("still resolves event/payload/env tokens alongside snippet tokens", () => {
    const out = renderTemplate("{{event.type}}|{{snippet.s}}|{{env.K}}", event, {
      env: { K: "V" },
      snippets: new Map([["s", "S"]]),
    });
    expect(out).toBe(`${event.type}|S|V`);
  });
});

describe("buildPrompt snippet substitution", () => {
  it("splices promptSnippets into the rendered prompt_template", () => {
    const prompt = buildPrompt(
      makeInput({
        playbook: { prompt_template: "Body: {{snippet.block}}." },
        promptSnippets: new Map([["block", "RESOLVED_BLOCK"]]),
      }),
    );
    expect(prompt).toContain("Body: RESOLVED_BLOCK.");
  });
});

describe("buildPrompt env substitution", () => {
  it("renders {{env.NAME}} from the supplied env map into the rendered prompt_template", () => {
    const prompt = buildPrompt(
      makeInput({
        playbook: {
          prompt_template: "region={{env.REGION}} host={{env.HOST}}",
        },
        env: { REGION: "westus", HOST: "worker-9" },
      }),
    );
    expect(prompt).toContain("region=westus host=worker-9");
  });

  it("renders an {{env.NAME}} token as empty when env is omitted", () => {
    const prompt = buildPrompt(
      makeInput({
        playbook: { prompt_template: "tok=[{{env.TOK}}]" },
      }),
    );
    expect(prompt).toContain("tok=[]");
  });

  it("renders an {{env.NAME}} token as empty when the name is absent from env", () => {
    const prompt = buildPrompt(
      makeInput({
        playbook: { prompt_template: "tok=[{{env.MISSING}}]" },
        env: { OTHER: "x" },
      }),
    );
    expect(prompt).toContain("tok=[]");
  });
});

describe("buildPrompt is pure", () => {
  it("does not mutate its inputs", () => {
    const input = makeInput({
      capabilityContext: [{ label: "L", content: "C" }],
    });
    const snapshot = JSON.parse(JSON.stringify(input));
    buildPrompt(input);
    expect(input).toEqual(snapshot);
  });

  it("is deterministic for identical inputs", () => {
    const a = buildPrompt(makeInput());
    const b = buildPrompt(makeInput());
    expect(a).toBe(b);
  });
});
