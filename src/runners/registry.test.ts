import { claudeCodeRunner } from "./claudeCode";
import {
  DEFAULT_RUNNER_ID,
  getDefaultRunner,
  getRunner,
  runnerIds,
} from "./registry";
import { scriptRunner } from "./script";

describe("runner registry", () => {
  it("registers claude-code and script", () => {
    expect(runnerIds()).toEqual(["claude-code", "script"]);
  });

  it("resolves the claude-code runner by id", () => {
    expect(getRunner("claude-code")).toBe(claudeCodeRunner);
  });

  it("resolves the script runner by id", () => {
    expect(getRunner("script")).toBe(scriptRunner);
  });

  it("returns undefined for an unknown runner id", () => {
    expect(getRunner("nope")).toBeUndefined();
  });

  it("defaults to claude-code", () => {
    expect(DEFAULT_RUNNER_ID).toBe("claude-code");
    expect(getDefaultRunner()).toBe(claudeCodeRunner);
  });
});
