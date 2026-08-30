import {
  buildAgentCommand,
  claudeCodeRunner,
  detectAuthFailure,
  parseResultText,
  parseUsage,
  PROMPT_FILE_PATH,
} from "./claudeCode";

/** Serialize objects onto their own lines, the shape stream-json emits. */
function lines(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n");
}

describe("parseResultText", () => {
  it("returns the result of the last result envelope (last wins)", () => {
    const output = lines(
      { type: "assistant", message: { content: "thinking" } },
      { type: "result", result: "first" },
      { type: "system", subtype: "info" },
      { type: "result", result: "second" }
    );
    expect(parseResultText(output)).toBe("second");
  });

  it("skips malformed JSON and arbitrary non-JSON noise", () => {
    const output = [
      "provisioning lease...",
      "{ this is not valid json",
      JSON.stringify({ type: "result", result: "kept" }),
      "shell prompt $ ",
      "[warn] trailing chatter",
    ].join("\n");
    expect(parseResultText(output)).toBe("kept");
  });

  it("ignores result envelopes whose result is empty or not a string", () => {
    const output = lines(
      { type: "result", result: "" },
      { type: "result", result: 42 },
      { type: "result" }
    );
    expect(parseResultText(output)).toBeNull();
  });

  it("returns null when there are no result envelopes at all", () => {
    const output = lines(
      { type: "assistant", message: { content: "hi" } },
      { type: "system" }
    );
    expect(parseResultText(output)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseResultText("")).toBeNull();
  });

  it("does not treat a JSON array line as an envelope", () => {
    const output = [
      JSON.stringify([{ type: "result", result: "in-array" }]),
      JSON.stringify({ type: "result", result: "real" }),
    ].join("\n");
    expect(parseResultText(output)).toBe("real");
  });
});

describe("parseUsage", () => {
  it("returns null when no usage block appears anywhere", () => {
    const output = lines(
      { type: "assistant", message: { content: "no usage here" } },
      { type: "result", result: "done" }
    );
    expect(parseUsage(output)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseUsage("")).toBeNull();
  });

  it("sums usage across all lines and all three source locations", () => {
    const output = lines(
      // top-level o.usage
      {
        type: "usage",
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
      },
      // o.message.usage
      {
        type: "assistant",
        message: {
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 7,
          },
        },
      },
      // o.result.usage
      {
        type: "result",
        result: { usage: { input_tokens: 100, output_tokens: 50 } },
      }
    );
    expect(parseUsage(output)).toEqual({
      input_tokens: 130,
      output_tokens: 56,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 10,
    });
  });

  it("prefers o.usage over message.usage and result.usage on one envelope", () => {
    const output = lines({
      type: "result",
      usage: { input_tokens: 1 },
      message: { usage: { input_tokens: 1000 } },
      result: { usage: { input_tokens: 9000 } },
    });
    expect(parseUsage(output)).toEqual({
      input_tokens: 1,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("prefers message.usage over result.usage when o.usage is absent", () => {
    const output = lines({
      type: "result",
      message: { usage: { output_tokens: 3 } },
      result: { usage: { output_tokens: 999 } },
    });
    expect(parseUsage(output)).toEqual({
      input_tokens: 0,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("ignores negative, non-finite, and non-numeric field values", () => {
    const output = lines(
      { usage: { input_tokens: -5, output_tokens: "12" } },
      { usage: { input_tokens: 4, cache_read_input_tokens: null } }
    );
    expect(parseUsage(output)).toEqual({
      input_tokens: 4,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("treats a present but empty usage block as found (returns zeros, not null)", () => {
    const output = lines({ type: "usage", usage: {} });
    expect(parseUsage(output)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("skips malformed lines while still summing valid usage", () => {
    const output = [
      "noise line",
      "{ broken json",
      JSON.stringify({ usage: { input_tokens: 8 } }),
    ].join("\n");
    expect(parseUsage(output)).toEqual({
      input_tokens: 8,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe("detectAuthFailure", () => {
  const cases: Array<[string, string]> = [
    ["authentication_error", 'API error {"type":"authentication_error"}'],
    ["Invalid API key", "Error: Invalid API key provided"],
    ["invalid-api-key", "code: invalid-api-key"],
    ["invalid credentials", "the invalid credentials were rejected"],
    ["oauth token expired", "your oauth token expired yesterday"],
    ["OAuth_token_has_expired", "reason=OAuth_token_has_expired"],
    ["refresh token is revoked", "the refresh token is revoked now"],
    ["refresh-token-invalid", "state: refresh-token-invalid"],
    ["please run /login", "please run /login to continue"],
    ["run `claude /login`", "please run `claude /login` again"],
    ["run claude /login", "just run claude /login"],
    ["401 Unauthorized", "HTTP 401 Unauthorized"],
    ["401_unauthorized", "status=401_unauthorized"],
  ];

  it.each(cases)("matches %s", (_label, text) => {
    expect(detectAuthFailure(text)).not.toBeNull();
  });

  it("returns the matched substring", () => {
    expect(detectAuthFailure("boom authentication_error boom")).toBe(
      "authentication_error"
    );
  });

  it("returns the first pattern's match when several could match", () => {
    // authentication_error precedes 401 unauthorized in priority order.
    const text = "401 unauthorized ... authentication_error";
    expect(detectAuthFailure(text)).toBe("authentication_error");
  });

  it("returns null for benign output mentioning tokens and login casually", () => {
    const output = [
      "the login page loaded",
      "we used 500 tokens",
      "refresh the token cache",
      JSON.stringify({ type: "result", result: "all good" }),
    ].join("\n");
    expect(detectAuthFailure(output)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectAuthFailure("")).toBeNull();
  });
});

describe("buildAgentCommand", () => {
  it("omits optional flags and pipes the staged prompt file into claude on stdin (linux)", () => {
    const command = buildAgentCommand({ model: null, allowed_tools: null });
    expect(command).toBe(
      "IS_SANDBOX=1 claude --print --dangerously-skip-permissions --output-format stream-json --verbose < '/work/prompt.txt'"
    );
  });

  it("is byte-identical for os='linux' and a null/missing os", () => {
    const playbook = { model: "sonnet", allowed_tools: ["Read", "Bash"] };
    const legacy = buildAgentCommand(playbook);
    expect(buildAgentCommand(playbook, null)).toBe(legacy);
    expect(buildAgentCommand(playbook, "linux")).toBe(legacy);
    // The linux shape reads the staged prompt file on STDIN via `< /work/prompt.txt`
    // (a POSIX-single-quoted argument so a future path with metacharacters still
    // survives /bin/sh -c). Prefixed IS_SANDBOX=1 so the CLI accepts
    // --dangerously-skip-permissions under wisp's root execs.
    expect(legacy).toBe(
      "IS_SANDBOX=1 claude --print --dangerously-skip-permissions --output-format stream-json --verbose " +
        "--model sonnet --allowedTools Read,Bash < '/work/prompt.txt'"
    );
  });

  it("linux command starts with IS_SANDBOX=1 env prefix (root-refusal escape hatch)", () => {
    for (const os of [undefined, null, "linux" as const]) {
      const command = buildAgentCommand(
        { model: null, allowed_tools: null },
        os ?? null
      );
      // The prefix comes first so /bin/sh -c applies it as a one-shot env
      // assignment to just the `claude` invocation.
      expect(command.startsWith("IS_SANDBOX=1 claude ")).toBe(true);
    }
  });

  it("windows command carries no IS_SANDBOX prefix (linux-only concern)", () => {
    const command = buildAgentCommand(
      { model: null, allowed_tools: null },
      "windows"
    );
    // The prefix belongs only on the linux shape; windows leases don't hit
    // the linux root-refusal path.
    expect(command).not.toContain("IS_SANDBOX");
  });

  describe("windows shape", () => {
    it("pipes the staged prompt file into claude via `type C:\\work\\prompt.txt | claude ...`", () => {
      const command = buildAgentCommand(
        { model: null, allowed_tools: null },
        "windows"
      );

      // Pinned exact literal: wisp receives this verbatim and wraps it in
      // cmd /c. The whole command is a bare cmd pipeline (no double quotes,
      // no PowerShell) so Docker's MSVCRT argv-joining on Windows has nothing
      // to mangle.
      expect(command).toBe(
        "type C:\\work\\prompt.txt | claude --print " +
          "--dangerously-skip-permissions --output-format stream-json --verbose"
      );

      expect(command).not.toContain('"');
      expect(command).not.toContain("^");
      expect(command).not.toContain("%");
      expect(command).not.toContain("$");
      expect(command).not.toContain("<");
      expect(command).not.toContain(">");
      expect(command).not.toContain("&");
    });

    it("appends --model and --allowedTools flags to the piped claude invocation", () => {
      const command = buildAgentCommand(
        { model: "opus", allowed_tools: ["Read", "Edit"] },
        "windows"
      );
      expect(command).toBe(
        "type C:\\work\\prompt.txt | claude --print " +
          "--dangerously-skip-permissions --output-format stream-json --verbose " +
          "--model opus --allowedTools Read,Edit"
      );
    });

    it("is fixed-length: identical regardless of prompt size (the prompt travels as a file)", () => {
      // buildAgentCommand no longer takes a prompt argument; the runner
      // command is fixed and reads the staged prompt file at run time. This
      // guards the invariant that the command length is unaffected by prompt
      // size.
      const playbook = { model: null, allowed_tools: null };
      const one = buildAgentCommand(playbook, "windows");
      const two = buildAgentCommand(playbook, "windows");
      expect(one).toBe(two);
      expect(one.length).toBeLessThan(2000);
    });
  });
});

describe("claudeCodeRunner surface", () => {
  it("declares PROMPT_FILE_PATH as the promptFilePath the executor stages", () => {
    expect(PROMPT_FILE_PATH).toBe("/work/prompt.txt");
    expect(claudeCodeRunner.promptFilePath).toBe(PROMPT_FILE_PATH);
  });

  it("ignores the runner command context (config alone shapes the command)", () => {
    const command = claudeCodeRunner.buildCommand(
      { model: null, allowed_tools: null },
      "linux",
      {
        event: {
          id: 1,
          source: "s",
          type: "t",
          subject_ref: "r",
          payload: {},
        },
        env: { SECRET: "should-not-appear" },
      }
    );
    expect(command).not.toContain("should-not-appear");
    expect(command).toBe(
      "IS_SANDBOX=1 claude --print --dangerously-skip-permissions --output-format stream-json --verbose < '/work/prompt.txt'"
    );
  });
});
