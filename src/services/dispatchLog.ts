import fs from "fs";
import path from "path";

import { userDataDir } from "../config";

/**
 * A per-dispatch append-only log file. Each dispatch pipeline writes its raw,
 * human-readable trace here (distinct from the structured stdout logger); the
 * file path is recorded on the run row as `log_path` so the UI can tail it.
 */
export interface DispatchLog {
  /** Absolute path of the log file. */
  path: string;
  /** Append one line (a trailing newline is added if missing). */
  append(line: string): void;
  /** Flush and release the underlying file descriptor. */
  close(): void;
}

/** The directory holding per-dispatch log files. */
export function dispatchLogDir(baseDir: string = userDataDir()): string {
  return path.join(baseDir, "logs");
}

/** The absolute path of a given dispatch's log file. */
export function dispatchLogPath(
  dispatchId: number,
  baseDir: string = userDataDir()
): string {
  return path.join(dispatchLogDir(baseDir), `dispatch-${dispatchId}.log`);
}

/** Options for {@link openDispatchLog}. */
export interface OpenDispatchLogOptions {
  /**
   * Override the user-data base directory. Defaults to the OS user-data dir;
   * tests point this at a temp directory.
   */
  baseDir?: string;
  /**
   * Optional header line written to the file the moment it is opened, so an
   * operator reading the log sees the operational bounds (dispatch id,
   * playbook id, resolved exec/release timeouts) that governed the run
   * without cross-referencing the structured logger. A trailing newline is
   * added when missing. On a retry re-open the file already exists and a
   * fresh header is simply appended, marking the new attempt.
   */
  header?: string;
}

/**
 * Open (creating if needed) the append-only log file for `dispatchId` and
 * return a writable append function plus its path. The file is opened with the
 * `a` flag so concurrent opens and process restarts never truncate prior lines.
 */
export function openDispatchLog(
  dispatchId: number,
  options: OpenDispatchLogOptions = {}
): DispatchLog {
  const baseDir = options.baseDir ?? userDataDir();
  const filePath = dispatchLogPath(dispatchId, baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const fd = fs.openSync(filePath, "a");
  if (options.header !== undefined) {
    const header = options.header;
    fs.writeSync(fd, header.endsWith("\n") ? header : header + "\n");
  }
  let closed = false;

  return {
    path: filePath,
    append(line: string): void {
      if (closed) {
        throw new Error(`dispatch log for ${dispatchId} is already closed`);
      }
      fs.writeSync(fd, line.endsWith("\n") ? line : line + "\n");
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      fs.closeSync(fd);
    },
  };
}
