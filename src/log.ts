/**
 * Minimal structured logger: one JSON object per line on stdout.
 *
 * No dependencies — the orchestrator is a small single-user app and a full
 * logging framework would be overkill. Every record carries `ts` (epoch ms),
 * `level`, and `msg`; any extra fields a caller passes are merged in at the top
 * level so log processors can index on them.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured fields merged into a log record. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, extra?: LogFields): void;
  info(msg: string, extra?: LogFields): void;
  warn(msg: string, extra?: LogFields): void;
  error(msg: string, extra?: LogFields): void;
  /** Derive a logger that stamps `bindings` onto every record it emits. */
  child(bindings: LogFields): Logger;
}

/** Where a log line is written. Defaults to stdout; injectable for tests. */
export type Sink = (line: string) => void;

const defaultSink: Sink = (line) => {
  process.stdout.write(line + "\n");
};

function serialize(
  level: LogLevel,
  msg: string,
  now: number,
  bindings: LogFields,
  extra?: LogFields
): string {
  // ts/level/msg lead; bindings and per-call extras follow. Field precedence is
  // bindings < extra so a call-site value overrides an inherited one.
  const record: LogFields = { ts: now, level, msg, ...bindings, ...extra };
  return JSON.stringify(record);
}

function make(sink: Sink, bindings: LogFields, clock: () => number): Logger {
  const write = (level: LogLevel, msg: string, extra?: LogFields): void => {
    sink(serialize(level, msg, clock(), bindings, extra));
  };
  return {
    debug: (msg, extra) => write("debug", msg, extra),
    info: (msg, extra) => write("info", msg, extra),
    warn: (msg, extra) => write("warn", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
    child: (childBindings) =>
      make(sink, { ...bindings, ...childBindings }, clock),
  };
}

/** Options for {@link createLogger}; both are injectable for tests. */
export interface LoggerOptions {
  /** Line sink. Defaults to writing JSON lines to stdout. */
  sink?: Sink;
  /** Clock returning epoch ms. Defaults to `Date.now`. */
  clock?: () => number;
  /** Fields stamped onto every record from this logger. */
  bindings?: LogFields;
}

/** Build a structured logger. With no options it writes JSON lines to stdout. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const clock = options.clock ?? Date.now;
  return make(sink, options.bindings ?? {}, clock);
}

/** The default process-wide logger, writing JSON lines to stdout. */
export const log: Logger = createLogger();
