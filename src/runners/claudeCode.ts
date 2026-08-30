/**
 * The `claude-code` runner: everything specific to running headless Claude Code
 * (`claude --print --output-format stream-json --verbose`) behind the generic
 * {@link Runner} seam. Nothing here is imported by the executor directly — the
 * executor only ever sees the {@link Runner} surface via the registry.
 *
 * Two concerns live here:
 *   - COMMAND: build the agent-step exec, per OS family. The RENDERED prompt is
 *     shipped into the lease as a file at create time (see
 *     {@link PROMPT_FILE_PATH}) and read into `claude` on STDIN by the built
 *     command: `sh -c 'claude -p ... < /work/prompt.txt'` on linux, and
 *     `cmd /c type C:\work\prompt.txt | claude -p ...` on windows. No rendered
 *     prompt content ever appears in the exec command, so the windows argv
 *     ceiling is unreachable regardless of prompt length.
 *   - OUTPUT: parse the `stream-json` envelopes the CLI emits — the result text,
 *     the summed token usage, and any auth-failure signature.
 *
 * Per the architecture principle these functions are domain-neutral: they read
 * the SHAPE of Claude Code's CLI and envelopes, never any intent carried in
 * prompts or results. Config (`model`, `allowed_tools`) is opaque data.
 */

import type { LeaseOs } from "../wisper/client";

import type { Runner, RunnerCommandContext, RunnerOutput } from "./runner";

/**
 * The `claude-code` runner's config: the optional `--model` / `--allowedTools`
 * flags. Read out of the playbook's opaque `runner_config` blob (which the core
 * never interprets) and narrowed here — this runner is the only code that knows
 * these keys.
 */
export interface ClaudeCodeConfig {
  model?: string | null;
  allowed_tools?: string[] | null;
}

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Absolute unix-style path (see the wisper contract; windows leases map the
 * same request path onto the container filesystem the same way exec working
 * directories already resolve) under which the executor stages the fully
 * rendered prompt as a lease file. Both per-OS command shapes read from this
 * exact path via a stdin pipe, so it is the ONE seam the executor and the
 * runner agree on.
 */
export const PROMPT_FILE_PATH = "/work/prompt.txt";

/**
 * Windows presentation of {@link PROMPT_FILE_PATH}. The lease file itself is
 * addressed by the unix-style path; only the `cmd /c type` invocation needs a
 * `C:\...\...` string. Kept as a constant so any future path change stays in
 * one place.
 */
const PROMPT_FILE_PATH_WINDOWS = "C:\\work\\prompt.txt";

/**
 * The fixed leading tokens of every `claude` headless-agent invocation, shared
 * by both the linux and windows command shapes.
 */
const AGENT_BASE_FLAGS = [
  "claude",
  "--print",
  "--dangerously-skip-permissions",
  "--output-format",
  "stream-json",
  "--verbose",
] as const;

/**
 * The `claude` argv (base flags + the optional `--model` / `--allowedTools`),
 * WITHOUT any prompt argument. The prompt is fed on stdin by the per-OS
 * pipeline built around this argv.
 */
function agentArgvHead(config: ClaudeCodeConfig): string[] {
  const parts: string[] = [...AGENT_BASE_FLAGS];
  if (config.model) {
    parts.push("--model", config.model);
  }
  if (config.allowed_tools && config.allowed_tools.length > 0) {
    parts.push("--allowedTools", config.allowed_tools.join(","));
  }
  return parts;
}

/**
 * POSIX single-quote a value so it is a single, literal shell argument. Used
 * only for the fixed `claude` argv assembled below; the prompt itself never
 * touches the command line.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The linux agent command. wisp wraps every linux exec in `/bin/sh -c`, so
 * this runs `claude` with its argv and pipes {@link PROMPT_FILE_PATH} into
 * its STDIN via shell redirection: `IS_SANDBOX=1 claude ... < /work/prompt.txt`.
 * The prompt travels as a file, not on the command line, so quotes, `%`, `$`,
 * backticks, and newlines in the prompt all reach the agent intact regardless
 * of length.
 *
 * The `IS_SANDBOX=1` prefix is the CLI's documented container escape hatch for
 * `--dangerously-skip-permissions`: without it `claude` hard-refuses to run
 * under root/sudo, and wisp container execs run as root. Every wisp lease is
 * by definition a container/VM sandbox, so this is unconditionally correct for
 * linux leases.
 */
function buildLinuxAgentCommand(config: ClaudeCodeConfig): string {
  return [
    "IS_SANDBOX=1",
    ...agentArgvHead(config),
    "<",
    shellQuote(PROMPT_FILE_PATH),
  ].join(" ");
}

/**
 * The windows agent command. wisp passes an exec to the Docker API as
 * `Cmd=["cmd","/c","<command>"]`; the command here is a plain `cmd` pipeline
 * that types the staged prompt file into `claude`'s STDIN:
 * `type C:\work\prompt.txt | claude --print ...`. cmd's `type` reads the file
 * as-is; `|` pipes it to `claude` unchanged, so quotes, `%`, `$`, and every
 * other cmd-special byte in the prompt is never seen on the command line.
 * That leaves the built command a short, fixed string dependent only on the
 * runner's config (never the prompt), well under the cmd 8191-char ceiling.
 */
function buildWindowsAgentCommand(config: ClaudeCodeConfig): string {
  return [
    "type",
    PROMPT_FILE_PATH_WINDOWS,
    "|",
    ...agentArgvHead(config),
  ].join(" ");
}

/**
 * Build the headless-agent exec command for a lease of OS family `os`: the
 * fixed `claude` stream-json invocation plus the optional `--model` /
 * `--allowedTools` flags from the config, wired to read the prompt from
 * {@link PROMPT_FILE_PATH} via a per-OS stdin pipe.
 *
 * `os` comes from the create-lease response ({@link LeaseOs}). Only
 * `"windows"` takes the `type ... | claude` shape; `"linux"`, `null` (older
 * servers), and any unrecognized value all fall back to the linux
 * `claude ... < /work/prompt.txt` shape.
 */
export function buildAgentCommand(
  config: ClaudeCodeConfig,
  os: LeaseOs | null = null
): string {
  return os === "windows"
    ? buildWindowsAgentCommand(config)
    : buildLinuxAgentCommand(config);
}

// --- output parsing --------------------------------------------------------

/** Summed token counts across every usage block found in the output. */
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** The four usage fields we sum; anything else in a usage block is ignored. */
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * Auth-failure signatures, in priority order. Deliberately narrow: each pattern
 * targets a specific credential/OAuth error string so that ordinary output
 * mentioning "token" or "login" does not trip a false positive.
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /authentication_error/i,
  /invalid[\s_-]*api[\s_-]*key/i,
  /invalid[\s_-]*credentials/i,
  /oauth[\s_-]*token[\s_-]*(?:has[\s_-]*)?expired/i,
  /refresh[\s_-]*token[\s_-]*(?:is[\s_-]*)?(?:invalid|expired|revoked)/i,
  /please[\s_-]*run[\s_-]*\/login/i,
  /\brun `?claude \/login`?/i,
  /401[\s_-]*unauthorized/i,
];

/**
 * Iterate the JSON objects embedded in `output`, one candidate per line.
 * Non-JSON noise, blank lines, and any line whose JSON is not a plain object
 * are silently skipped.
 */
function* iterJsonObjects(output: string): Generator<Record<string, unknown>> {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    // A stream-json envelope is always a single `{...}` object. Skipping other
    // lines up front avoids parsing (potentially large) prose noise.
    if (trimmed.length === 0 || trimmed[0] !== "{") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(parsed)) yield parsed;
  }
}

/**
 * Return the `result` string of the LAST envelope with `type === "result"` and
 * a non-empty string `result`, or `null` when no such envelope exists.
 */
export function parseResultText(output: string): string | null {
  let last: string | null = null;
  for (const obj of iterJsonObjects(output)) {
    if (
      obj.type === "result" &&
      typeof obj.result === "string" &&
      obj.result.length > 0
    ) {
      last = obj.result;
    }
  }
  return last;
}

/**
 * Locate the usage block on one envelope, preferring `o.usage`, then
 * `o.message.usage`, then `o.result.usage`. Returns the first that is an object.
 */
function pickUsage(
  obj: Record<string, unknown>
): Record<string, unknown> | null {
  if (isRecord(obj.usage)) return obj.usage;
  if (isRecord(obj.message) && isRecord(obj.message.usage))
    return obj.message.usage;
  if (isRecord(obj.result) && isRecord(obj.result.usage))
    return obj.result.usage;
  return null;
}

/**
 * Sum token usage across every envelope that carries a usage block. For each
 * envelope a single usage block is chosen via {@link pickUsage}; only
 * non-negative finite numbers are added. Returns `null` when no usage block is
 * found anywhere, so callers never persist an all-zero row.
 */
export function parseUsage(output: string): UsageTotals | null {
  const totals: UsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let found = false;
  for (const obj of iterJsonObjects(output)) {
    const usage = pickUsage(obj);
    if (!usage) continue;
    found = true;
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        totals[field] += value;
      }
    }
  }
  return found ? totals : null;
}

/**
 * Scan `output` for the auth-failure signatures in {@link AUTH_FAILURE_PATTERNS}
 * and return the matched substring of the first pattern (in priority order) that
 * hits, or `null` when none match.
 */
export function detectAuthFailure(output: string): string | null {
  for (const pattern of AUTH_FAILURE_PATTERNS) {
    const match = output.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * The message recorded when a zero-exit run produced no `{"type":"result",...}`
 * envelope. With `--output-format stream-json` the CLI always terminates with
 * one; its ABSENCE means claude never actually ran (e.g. a shell echoed the
 * invocation text and exited 0), so the run must fail.
 */
export const MISSING_RESULT_ERROR =
  "agent exited 0 but produced no stream-json result envelope — claude did not run";

/** Narrow the executor's opaque config into {@link ClaudeCodeConfig}. */
function narrowConfig(config: unknown): ClaudeCodeConfig {
  if (!isRecord(config)) return {};
  const model = typeof config.model === "string" ? config.model : null;
  const allowed_tools =
    Array.isArray(config.allowed_tools) &&
    config.allowed_tools.every((t) => typeof t === "string")
      ? (config.allowed_tools as string[])
      : null;
  return { model, allowed_tools };
}

/**
 * The `claude-code` runner. Delegates command building to
 * {@link buildAgentCommand} and output parsing to
 * {@link parseResultText}/{@link parseUsage}, and declares
 * {@link PROMPT_FILE_PATH} so the executor stages the rendered prompt as a
 * lease file at create time.
 */
export const claudeCodeRunner: Runner = {
  id: "claude-code",

  buildCommand(
    config: unknown,
    os: LeaseOs | null,
    _ctx: RunnerCommandContext
  ): string {
    // The `claude-code` command reads the prompt from PROMPT_FILE_PATH on
    // stdin; the event and resolved secrets in `_ctx` are not templated into
    // it, so they are unused.
    return buildAgentCommand(narrowConfig(config), os);
  },

  parseOutput(raw: string): RunnerOutput | null {
    const resultText = parseResultText(raw);
    if (resultText === null) return null;
    return { resultText, usage: parseUsage(raw) };
  },

  missingResultError: MISSING_RESULT_ERROR,

  detectAuthFailure(raw: string): string | null {
    return detectAuthFailure(raw);
  },

  promptFilePath: PROMPT_FILE_PATH,
};
