import type { PromptEvent } from "../executor/prompt";

import {
  buildScriptCommand,
  MISSING_COMMAND_TEMPLATE_ERROR,
  scriptRunner,
} from "./script";
import type { RunnerCommandContext } from "./runner";

/** A representative event for template rendering. */
const EVENT: PromptEvent = {
  id: 7,
  source: "moduleA",
  type: "thing.changed",
  subject_ref: "42",
  payload: { title: "hello world", branch: "main" },
};

/** Build a command context around {@link EVENT} plus the given secrets. */
function ctx(env: Record<string, string> = {}): RunnerCommandContext {
  return { event: EVENT, env };
}

describe("scriptRunner", () => {
  it("registers as 'script'", () => {
    expect(scriptRunner.id).toBe("script");
  });

  describe("buildCommand / buildScriptCommand", () => {
    it("renders {{event.*}}, {{payload.*}}, and {{env.*}} with the shared engine", () => {
      const config = {
        command_template:
          "build --for {{ event.type }} --branch {{ payload.branch }} --token {{ env.TOKEN }}",
      };
      const command = scriptRunner.buildCommand(
        config,
        "linux",
        ctx({ TOKEN: "s3cr3t-value" })
      );
      expect(command).toBe(
        "build --for thing.changed --branch main --token s3cr3t-value"
      );
    });

    it("renders payload tokens with buildScriptCommand directly", () => {
      const config = { command_template: "echo {{ payload.title }}" };
      expect(buildScriptCommand(config, ctx())).toBe("echo hello world");
    });

    it("leaves unknown template paths as empty strings (shared engine behavior)", () => {
      const config = { command_template: "run {{ payload.missing }}{{ env.NOPE }}x" };
      expect(buildScriptCommand(config, ctx())).toBe("run x");
    });

    it("does no OS branching — the same command for every lease OS", () => {
      const config = { command_template: "make {{ event.type }}" };
      const linux = scriptRunner.buildCommand(config, "linux", ctx());
      const windows = scriptRunner.buildCommand(config, "windows", ctx());
      const legacy = scriptRunner.buildCommand(config, null, ctx());
      expect(linux).toBe("make thing.changed");
      expect(windows).toBe("make thing.changed");
      expect(legacy).toBe("make thing.changed");
    });

    it("does not declare a promptFilePath (executor stages no prompt file for scripts)", () => {
      expect(scriptRunner.promptFilePath).toBeUndefined();
    });

    it("throws on a missing command_template", () => {
      expect(() => buildScriptCommand({}, ctx())).toThrow(
        MISSING_COMMAND_TEMPLATE_ERROR
      );
    });

    it("throws on an empty command_template", () => {
      expect(() => buildScriptCommand({ command_template: "" }, ctx())).toThrow(
        MISSING_COMMAND_TEMPLATE_ERROR
      );
    });

    it("throws on a non-string command_template", () => {
      expect(() =>
        buildScriptCommand({ command_template: 42 }, ctx())
      ).toThrow(MISSING_COMMAND_TEMPLATE_ERROR);
    });

    it("throws on a non-object config", () => {
      expect(() => buildScriptCommand(null, ctx())).toThrow(
        MISSING_COMMAND_TEMPLATE_ERROR
      );
    });
  });

  describe("validateConfig", () => {
    it("passes a config with a non-empty command_template", () => {
      expect(() =>
        scriptRunner.validateConfig?.({ command_template: "true" })
      ).not.toThrow();
    });

    it("throws for a missing/empty command_template (fails before leasing)", () => {
      expect(() => scriptRunner.validateConfig?.({})).toThrow(
        MISSING_COMMAND_TEMPLATE_ERROR
      );
      expect(() =>
        scriptRunner.validateConfig?.({ command_template: "" })
      ).toThrow(MISSING_COMMAND_TEMPLATE_ERROR);
    });
  });

  describe("parseOutput", () => {
    it("passes arbitrary raw output through verbatim with null usage", () => {
      const raw = "build succeeded\nsome arbitrary text\n";
      expect(scriptRunner.parseOutput(raw)).toEqual({
        resultText: raw,
        usage: null,
      });
    });

    it("treats empty output as a valid run (no envelope requirement)", () => {
      expect(scriptRunner.parseOutput("")).toEqual({
        resultText: "",
        usage: null,
      });
    });

    it("preserves a NOTES_TO_SAVE block for the executor to harvest", () => {
      const raw =
        'done\n\n<NOTES_TO_SAVE>\n[{"content":"c"}]\n</NOTES_TO_SAVE>';
      expect(scriptRunner.parseOutput(raw)?.resultText).toBe(raw);
    });
  });
});
