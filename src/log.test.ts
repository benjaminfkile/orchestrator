import { createLogger } from "./log";

describe("createLogger", () => {
  function capture() {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (line) => lines.push(line),
      clock: () => 1_700_000_000_000,
    });
    return { lines, logger };
  }

  it("emits one JSON line per record with ts, level, and msg", () => {
    const { lines, logger } = capture();
    logger.info("hello");

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toEqual({
      ts: 1_700_000_000_000,
      level: "info",
      msg: "hello",
    });
  });

  it("merges extra fields at the top level", () => {
    const { lines, logger } = capture();
    logger.error("boom", { dispatchId: 7, code: "E_LEASE" });

    const record = JSON.parse(lines[0]);
    expect(record.level).toBe("error");
    expect(record.dispatchId).toBe(7);
    expect(record.code).toBe("E_LEASE");
  });

  it("supports all four levels", () => {
    const { lines, logger } = capture();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(lines.map((l) => JSON.parse(l).level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("child loggers stamp bindings onto every record", () => {
    const { lines, logger } = capture();
    const child = logger.child({ dispatchId: 42 });
    child.info("working");

    const record = JSON.parse(lines[0]);
    expect(record.dispatchId).toBe(42);
    expect(record.msg).toBe("working");
  });

  it("lets a call-site extra override an inherited binding", () => {
    const { lines, logger } = capture();
    const child = logger.child({ dispatchId: 1 });
    child.info("override", { dispatchId: 2 });

    expect(JSON.parse(lines[0]).dispatchId).toBe(2);
  });

  it("produces valid JSON even with special characters", () => {
    const { lines, logger } = capture();
    logger.info('quote " and\nnewline', { path: 'a"b' });

    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(JSON.parse(lines[0]).msg).toBe('quote " and\nnewline');
  });
});
