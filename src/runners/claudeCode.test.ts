import {
  buildAgentCommand,
  detectAuthFailure,
  parseResultText,
  parseUsage,
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
  it("omits optional flags and escapes single quotes in the prompt", () => {
    const command = buildAgentCommand(
      { model: null, allowed_tools: null },
      "it's a test"
    );
    expect(command).toBe(
      "IS_SANDBOX=1 claude --print --dangerously-skip-permissions --output-format stream-json --verbose 'it'\\''s a test'"
    );
  });

  it("is byte-identical for os='linux' and a null/missing os", () => {
    const playbook = { model: "sonnet", allowed_tools: ["Read", "Bash"] };
    const prompt = "line one\nline 'two'";
    const legacy = buildAgentCommand(playbook, prompt);
    expect(buildAgentCommand(playbook, prompt, null)).toBe(legacy);
    expect(buildAgentCommand(playbook, prompt, "linux")).toBe(legacy);
    // Sanity: the linux shape is the historical single-line POSIX-quoted form,
    // now prefixed with IS_SANDBOX=1 (the CLI's container escape hatch for
    // --dangerously-skip-permissions when running under root, which every wisp
    // container exec is).
    expect(legacy).toBe(
      "IS_SANDBOX=1 claude --print --dangerously-skip-permissions --output-format stream-json --verbose " +
        "--model sonnet --allowedTools Read,Bash 'line one\nline '\\''two'\\'''"
    );
  });

  it("linux command starts with IS_SANDBOX=1 env prefix (root-refusal escape hatch)", () => {
    for (const os of [undefined, null, "linux" as const]) {
      const command = buildAgentCommand(
        { model: null, allowed_tools: null },
        "hi",
        os ?? null
      );
      // The prefix comes first so /bin/sh -c applies it as a one-shot env
      // assignment to just the `claude` invocation.
      expect(command.startsWith("IS_SANDBOX=1 claude ")).toBe(true);
    }
  });

  it("windows command carries no IS_SANDBOX prefix (shape unchanged)", () => {
    const command = buildAgentCommand(
      { model: null, allowed_tools: null },
      "unused on windows",
      "windows"
    );
    // The prefix belongs only on the linux shape — the whole windows command
    // is base64 (no env-prefix syntax), and windows leases don't hit the
    // linux root-refusal path.
    expect(command).not.toContain("IS_SANDBOX");
  });

  describe("windows shape", () => {
    /** Decode a `powershell -NoProfile -EncodedCommand <b64>` command's script. */
    const decodeScript = (command: string): string => {
      const prefix = "powershell -NoProfile -EncodedCommand ";
      expect(command.startsWith(prefix)).toBe(true);
      const b64 = command.slice(prefix.length);
      return Buffer.from(b64, "base64").toString("utf16le");
    };

    it("is powershell -EncodedCommand of the fixed script with ZERO double quotes", () => {
      const command = buildAgentCommand(
        { model: null, allowed_tools: null },
        "unused on windows",
        "windows"
      );

      // Pinned exact literal: wisp receives this verbatim and wraps it in cmd /c.
      // The whole command is base64 (A-Za-z0-9+/=) after the fixed prefix, so it
      // carries no double quote, backslash, or cmd metacharacter to be mangled by
      // Docker's MSVCRT argv-joining on Windows.
      const script =
        "$env:ORCH_AGENT_PROMPT | & claude --print " +
        "--dangerously-skip-permissions --output-format stream-json --verbose";
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      expect(command).toBe(`powershell -NoProfile -EncodedCommand ${encoded}`);

      expect(command).not.toContain('"');
      expect(command).not.toContain("\\");
      expect(command).not.toContain("&");
      expect(command).not.toContain("|");
      expect(command).not.toContain("<");
      expect(command).not.toContain(">");
      expect(command).not.toContain("^");
      expect(command).not.toContain("%");
      expect(command).not.toContain("$");
    });

    it("decodes (UTF-16LE) to the exact fixed claude invocation reading the env prompt", () => {
      const command = buildAgentCommand(
        { model: null, allowed_tools: null },
        "unused on windows",
        "windows"
      );
      const script = decodeScript(command);
      expect(script).toBe(
        "$env:ORCH_AGENT_PROMPT | & claude --print " +
          "--dangerously-skip-permissions --output-format stream-json --verbose"
      );
      // The script PIPES the env prompt into claude on stdin (bypassing argv, which
      // the npm claude.cmd batch shim mangles) and invokes claude via the `&` call
      // operator — there is no positional prompt argument on the command line.
      expect(script.startsWith("$env:ORCH_AGENT_PROMPT |")).toBe(true);
      expect(script).toContain("$env:ORCH_AGENT_PROMPT");
      expect(script).not.toMatch(/verbose\s+\S/); // nothing after the final flag
    });

    it("is fixed-length: identical regardless of the prompt argument", () => {
      const playbook = { model: null, allowed_tools: null };
      const tiny = buildAgentCommand(playbook, "hi", "windows");
      const huge = buildAgentCommand(playbook, "x".repeat(100_000), "windows");
      // The prompt never touches the command line, so its size is irrelevant.
      expect(huge).toBe(tiny);
      // ...and the command stays comfortably under the cmd 8191-char ceiling.
      expect(huge.length).toBeLessThan(2000);
    });

    it("appends --model and --allowedTools flags to the piped claude invocation", () => {
      const command = buildAgentCommand(
        { model: "opus", allowed_tools: ["Read", "Edit"] },
        "hi",
        "windows"
      );
      const script = decodeScript(command);
      expect(script).toBe(
        "$env:ORCH_AGENT_PROMPT | & claude --print " +
          "--dangerously-skip-permissions --output-format stream-json --verbose " +
          "--model opus --allowedTools Read,Edit"
      );
    });

    it("never embeds the prompt (or its cmd-special bytes) on the command line", () => {
      const prompt = "space split & pipe | redirect > here";
      const command = buildAgentCommand(
        { model: null, allowed_tools: null },
        prompt,
        "windows"
      );
      // None of the prompt's text reaches the command line — only the fixed
      // base64-encoded invocation does, so cmd never sees the prompt's
      // `&`/`|`/`>` metacharacters. The decoded script references the env var.
      expect(command).not.toContain("space split");
      expect(command).not.toContain("pipe");
      expect(command).not.toContain("redirect");
      expect(decodeScript(command)).toContain("$env:ORCH_AGENT_PROMPT");
    });
  });
});
