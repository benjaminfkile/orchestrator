/**
 * The `claude-code` runner: everything specific to running headless Claude Code
 * (`claude --print --output-format stream-json --verbose`) behind the generic
 * {@link Runner} seam. Nothing here is imported by the executor directly — the
 * executor only ever sees the {@link Runner} surface via the registry.
 *
 * Two concerns live here:
 *   - COMMAND: build the agent-step exec, per OS family. The prompt is delivered
 *     as a POSIX-quoted argv argument on linux and via {@link AGENT_PROMPT_ENV}
 *     on windows (where argv cannot carry the prompt intact).
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

/** POSIX single-quote a value so it is a single, literal shell argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Environment variable a windows lease carries the fully rendered prompt in. The
 * windows agent command references it as `$env:ORCH_AGENT_PROMPT` instead of
 * embedding the prompt on the command line — see {@link buildWindowsAgentScript}
 * and the executor's lease-env injection.
 */
export const AGENT_PROMPT_ENV = "ORCH_AGENT_PROMPT";

/**
 * Ceiling on a windows lease's rendered prompt length. Windows caps a single
 * environment variable at 32767 chars, and the prompt travels to the agent
 * through {@link AGENT_PROMPT_ENV}; a prompt at or under this bound leaves ample
 * headroom, while anything larger fails the dispatch (in the executor) rather
 * than being silently truncated by the OS into a corrupt prompt.
 */
export const MAX_WINDOWS_PROMPT_CHARS = 30000;

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
 * WITHOUT the trailing prompt argument. The prompt is appended per-OS by the
 * callers, since each shape quotes it differently.
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
 * The linux agent command: the `claude` argv joined with spaces, with the prompt
 * as a single POSIX-single-quoted trailing argument. wisp wraps linux execs in
 * `/bin/sh -c`, so single-quoting yields exactly one literal argument, and an
 * `IS_SANDBOX=1` env prefix applies to just the `claude` invocation.
 *
 * The `IS_SANDBOX=1` prefix is the CLI's documented container escape hatch for
 * `--dangerously-skip-permissions`: without it `claude` hard-refuses to run under
 * root/sudo ("cannot be used with root/sudo privileges for security reasons"),
 * and wisp container execs run as root. Every wisp lease is by definition a
 * container/VM sandbox, so this is unconditionally correct for linux leases.
 */
function buildLinuxAgentCommand(
  config: ClaudeCodeConfig,
  prompt: string
): string {
  return ["IS_SANDBOX=1", ...agentArgvHead(config), shellQuote(prompt)].join(
    " "
  );
}

/**
 * The fixed PowerShell script the windows agent command runs. It PIPES the prompt
 * read from `$env:ORCH_AGENT_PROMPT` into `claude` on STDIN — never as an argv
 * argument. `claude --print` reads the prompt from stdin when no positional prompt
 * is given (the documented `cat prompt | claude -p` pattern), and stdin is passed
 * through untouched by every layer (PowerShell → the npm `claude.cmd` batch shim →
 * node), whereas argv is not: the batch shim's argv cannot carry newlines or
 * embedded quotes, so it truncated the prompt at the first newline and mangled its
 * quotes. Piping bypasses argv entirely, so quotes, `%`, `$`, backticks, and
 * newlines in the prompt all reach the agent intact regardless of length. The
 * prompt rides the lease env (see the executor), so this script is fixed-size:
 * its length never depends on the prompt.
 */
export function buildWindowsAgentScript(config: ClaudeCodeConfig): string {
  return [`$env:${AGENT_PROMPT_ENV}`, "|", "&", ...agentArgvHead(config)].join(
    " "
  );
}

/**
 * The windows agent command. wisp passes an exec to the Docker API as
 * `Cmd=["cmd","/c","<command>"]`; on Windows Docker JOINS that argv into a single
 * process command line with MSVCRT escaping, so EVERY embedded double quote in
 * `<command>` becomes `\"`. cmd then strips the outer quotes and hands PowerShell a
 * tail with literal `\"` sequences, which MSVCRT parsing turns back into bare quote
 * characters — so a `-Command "..."` script arrives BEGINNING with a quote and
 * PowerShell evaluates it as a string literal (interpolating the prompt) and echoes
 * it instead of running claude. Any embedded double quote is unsafe end to end.
 *
 * The fix carries ZERO double quotes (and no cmd metacharacters at all): the fixed
 * script from {@link buildWindowsAgentScript} is encoded as UTF-16LE base64 and
 * passed via `-EncodedCommand`. base64 is `A-Za-z0-9+/=` only — nothing cmd or
 * MSVCRT can mangle — and because the prompt travels in the lease env the script is
 * short (~150-300 chars), so its base64 stays far under the cmd 8191-char ceiling.
 */
function buildWindowsAgentCommand(config: ClaudeCodeConfig): string {
  const encoded = Buffer.from(
    buildWindowsAgentScript(config),
    "utf16le"
  ).toString("base64");
  return `powershell -NoProfile -EncodedCommand ${encoded}`;
}

/**
 * Build the headless-agent exec command for a lease of OS family `os`: the fixed
 * `claude` stream-json invocation plus the optional `--model`/`--allowedTools`
 * flags from the config.
 *
 * `os` comes from the create-lease response ({@link LeaseOs}). Only `"windows"`
 * takes the short `$env:ORCH_AGENT_PROMPT` shape (the prompt rides the lease env,
 * NOT the command line, so `prompt` is unused there); `"linux"`, `null` (older
 * servers), and any unrecognized value all fall back to the linux POSIX-quoted
 * shape with the prompt as a trailing argument, byte-identical to the historical
 * command.
 */
export function buildAgentCommand(
  config: ClaudeCodeConfig,
  prompt: string,
  os: LeaseOs | null = null
): string {
  return os === "windows"
    ? buildWindowsAgentCommand(config)
    : buildLinuxAgentCommand(config, prompt);
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
 * The `claude-code` runner. Delegates command building to {@link buildAgentCommand}
 * and output parsing to {@link parseResultText}/{@link parseUsage}, and carries
 * the windows prompt-delivery knobs the executor reads generically.
 */
export const claudeCodeRunner: Runner = {
  id: "claude-code",

  buildCommand(
    prompt: string,
    config: unknown,
    os: LeaseOs | null,
    _ctx: RunnerCommandContext
  ): string {
    // The `claude-code` command carries the fully rendered prompt; the event and
    // resolved secrets in `_ctx` are not templated into it, so they are unused.
    return buildAgentCommand(narrowConfig(config), prompt, os);
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

  promptEnvVar: AGENT_PROMPT_ENV,
  maxWindowsPromptChars: MAX_WINDOWS_PROMPT_CHARS,
};
