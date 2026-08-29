import fs from "fs";
import os from "os";
import path from "path";

import {
  dispatchLogDir,
  dispatchLogPath,
  openDispatchLog,
} from "./dispatchLog";

describe("dispatchLog", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dispatchlog-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("resolves the path under <base>/logs/dispatch-<id>.log", () => {
    expect(dispatchLogPath(5, baseDir)).toBe(
      path.join(baseDir, "logs", "dispatch-5.log")
    );
  });

  it("creates the logs directory and file on open", () => {
    const dl = openDispatchLog(9, { baseDir });
    try {
      expect(fs.existsSync(dl.path)).toBe(true);
      expect(dl.path).toBe(dispatchLogPath(9, baseDir));
    } finally {
      dl.close();
    }
  });

  it("appends lines, adding a trailing newline when missing", () => {
    const dl = openDispatchLog(1, { baseDir });
    dl.append("first");
    dl.append("second\n");
    dl.close();

    const contents = fs.readFileSync(dl.path, "utf8");
    expect(contents).toBe("first\nsecond\n");
  });

  it("is append-only across re-opens (never truncates prior lines)", () => {
    const first = openDispatchLog(2, { baseDir });
    first.append("line-a");
    first.close();

    const second = openDispatchLog(2, { baseDir });
    second.append("line-b");
    second.close();

    expect(fs.readFileSync(first.path, "utf8")).toBe("line-a\nline-b\n");
  });

  it("throws when appending after close", () => {
    const dl = openDispatchLog(3, { baseDir });
    dl.close();
    expect(() => dl.append("nope")).toThrow(/already closed/);
  });

  it("close is idempotent", () => {
    const dl = openDispatchLog(4, { baseDir });
    dl.close();
    expect(() => dl.close()).not.toThrow();
  });

  it("writes an optional header line at open, adding a trailing newline when missing", () => {
    const dl = openDispatchLog(11, {
      baseDir,
      header: "# dispatch 11 playbook 3 exec_timeout_ms=630000 release_timeout_ms=60000",
    });
    dl.append("first log line");
    dl.close();

    const contents = fs.readFileSync(dl.path, "utf8");
    expect(contents).toBe(
      "# dispatch 11 playbook 3 exec_timeout_ms=630000 release_timeout_ms=60000\nfirst log line\n"
    );
  });

  it("does not write a header when none is supplied", () => {
    const dl = openDispatchLog(12, { baseDir });
    dl.append("only line");
    dl.close();

    expect(fs.readFileSync(dl.path, "utf8")).toBe("only line\n");
  });

  it("re-opening a dispatch log with a header appends a fresh header (marks a retry attempt)", () => {
    const first = openDispatchLog(13, { baseDir, header: "# attempt 1" });
    first.append("a");
    first.close();

    const second = openDispatchLog(13, { baseDir, header: "# attempt 2" });
    second.append("b");
    second.close();

    expect(fs.readFileSync(first.path, "utf8")).toBe(
      "# attempt 1\na\n# attempt 2\nb\n"
    );
  });

  describe("default base honors ORCH_DATA_DIR", () => {
    const original = process.env.ORCH_DATA_DIR;

    afterEach(() => {
      if (original === undefined) delete process.env.ORCH_DATA_DIR;
      else process.env.ORCH_DATA_DIR = original;
    });

    it("puts logs under <ORCH_DATA_DIR>/logs when the base is omitted", () => {
      process.env.ORCH_DATA_DIR = baseDir;
      expect(dispatchLogDir()).toBe(path.join(baseDir, "logs"));
      expect(dispatchLogPath(7)).toBe(
        path.join(baseDir, "logs", "dispatch-7.log")
      );
    });
  });
});
