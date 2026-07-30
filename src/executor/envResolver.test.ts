import { createSecretEnvResolver } from "./envResolver";

describe("createSecretEnvResolver", () => {
  it("resolves a known secret to its value", () => {
    const store: Record<string, string> = { GIT_TOKEN: "ghp_abc" };
    const resolve = createSecretEnvResolver((name) => store[name]);
    expect(resolve("GIT_TOKEN")).toBe("ghp_abc");
  });

  it("returns undefined for an unknown secret (the executor decides the failure)", () => {
    const resolve = createSecretEnvResolver(() => undefined);
    expect(resolve("CLAUDE_CODE_OAUTH_TOKEN")).toBeUndefined();
  });

  it("looks each name up by that exact key", () => {
    const seen: string[] = [];
    const resolve = createSecretEnvResolver((name) => {
      seen.push(name);
      return name === "A" ? "1" : undefined;
    });
    expect(resolve("A")).toBe("1");
    expect(resolve("B")).toBeUndefined();
    expect(seen).toEqual(["A", "B"]);
  });
});
