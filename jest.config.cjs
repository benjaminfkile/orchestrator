/** Backend Jest config. `npm test` runs with --runInBand --detectOpenHandles
 * (single worker) so the suite never forks parallel workers inside a
 * resource-capped container. Do not remove those flags from package.json. */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/scripts"],
  testMatch: ["**/*.test.ts"],
};
