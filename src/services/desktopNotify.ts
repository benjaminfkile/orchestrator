/**
 * Native OS desktop notifications raised FROM THE BACKEND PROCESS — they work
 * with no browser tab open. Cross-platform with ZERO npm dependencies: each
 * platform drives a tool that already ships with the OS.
 *
 *   - win32:  powershell.exe raising a WinRT toast (ToastNotificationManager).
 *   - darwin: osascript `display notification`.
 *   - linux:  notify-send.
 *
 * The toast carries a title and body. On Windows an optional http(s) launch
 * URL makes a click open that URL in the default browser (protocol
 * activation); macOS and Linux toasts are display-only. User text (title/body)
 * is NEVER interpolated onto a command line. On Windows
 * it is XML-escaped and delivered over stdin as a single-line, single-quoted
 * PowerShell string; on macOS it is escaped into a single AppleScript `-e` argv
 * element; on Linux it is passed as separate argv elements. The invocation
 * itself is injectable so tests can stub the spawn and assert command/argument
 * construction on every platform without launching a real process.
 *
 * This function NEVER throws and NEVER logs or embeds secret values: on any
 * failure — an unsupported platform, a missing tool (ENOENT), a non-zero exit, a
 * spawn error, or the ~5s timeout — it resolves `{ok: false, error}` with a
 * generic, value-free message.
 */

import { spawn as nodeSpawn } from "child_process";

/** The content of a single desktop notification. */
export interface DesktopNotification {
  title: string;
  body: string;
  /** http(s) URL opened when the toast is clicked (Windows only); ignored otherwise. */
  launchUrl?: string;
}

/** Only absolute http(s) URLs are accepted as a launch target. */
export function isLaunchUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\/[^\s'"<>]+$/i.test(value);
}

/** Outcome of an attempt. `error` is a generic, secret-free diagnostic. */
export interface DesktopNotifyResult {
  ok: boolean;
  error?: string;
}

/** The subset of a spawned child process this module relies on. */
export interface ChildProcessLike {
  stdin: {
    write(chunk: string): unknown;
    end(): unknown;
  } | null;
  /** Child's stdout, when observable; used to detect the win32 toast sentinel. */
  stdout?: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
}

/** Injectable spawn: `(command, args) => child`. Defaults to `child_process`. */
export type SpawnFn = (command: string, args: string[]) => ChildProcessLike;

/** Injected collaborators for {@link showDesktopNotification}. */
export interface DesktopNotifyDeps {
  /** Platform to target. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Process spawner. Defaults to `child_process.spawn`. */
  spawn?: SpawnFn;
  /** Milliseconds before the child is killed and the attempt fails. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** A stable per-app identifier for the Windows toast notifier. */
const WINDOWS_APP_ID = "orchestrator";

/**
 * Fixed marker the Windows script prints as its LAST line once the toast has
 * actually been shown. Its presence in stdout — together with exit 0 — is the
 * only proof the script ran to completion (see {@link buildWindowsScript}).
 */
export const WINDOWS_TOAST_SENTINEL = "WISP_TOAST_SHOWN";

const defaultSpawn: SpawnFn = (command, args) =>
  nodeSpawn(command, args) as unknown as ChildProcessLike;

/** Escape the five XML metacharacters so no interpolated value can break markup. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escape a value for use inside an AppleScript double-quoted string literal.
 * Only backslash and double-quote are special; both become escaped. The result
 * still travels as a single argv element (via `osascript -e`), so there is no
 * shell to worry about — this only keeps the AppleScript string literal valid.
 */
function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the PowerShell script that raises a WinRT toast. Every interpolated
 * value is XML-escaped and loaded via a SINGLE-quoted PowerShell string literal
 * (`$xml.LoadXml('...')`), which PowerShell does not expand — so `$`, backticks,
 * quotes and angle brackets in user text are inert. Because XML-escaping turns
 * any `'` into `&apos;`, the raw text can never terminate the quoted string.
 *
 * CONSTRAINT (load-bearing): the toast XML MUST stay on ONE line, and this
 * script MUST NEVER use a PowerShell here-string (`@'...'@`). We deliver the
 * script over stdin with `powershell -Command -`, and PS 5.1 consumes that
 * redirected stdin LINE BY LINE: it silently aborts at a here-string opener,
 * skipping every subsequent line (including the Show call) while STILL exiting
 * 0. A one-line single-quoted string keeps the whole payload on the line the
 * parser is reading, so the script actually runs to completion.
 */
export function buildWindowsScript(input: DesktopNotification): string {
  // NB: join with no separator — the XML must be a single line (see above).
  const launch = isLaunchUrl(input.launchUrl)
    ? ` activationType="protocol" launch="${xmlEscape(input.launchUrl)}"`
    : "";
  const xml = [
    `<toast${launch}>`,
    `<visual>`,
    `<binding template="ToastGeneric">`,
    `<text>${xmlEscape(input.title)}</text>`,
    `<text>${xmlEscape(input.body)}</text>`,
    `</binding>`,
    `</visual>`,
    `</toast>`,
  ].join("");

  return [
    `$ErrorActionPreference = 'Stop'`,
    `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]`,
    `$xml = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]::new()`,
    `$xml.LoadXml('${xml}')`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    // Windows silently drops toasts whose AppUserModelID is not registered with
    // the OS. Idempotently ensure the per-user HKCU registration (no admin
    // rights needed) before Show, or the toast never appears on screen.
    `$aumidKey = 'HKCU:\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_ID}'`,
    `if (-not (Test-Path $aumidKey)) { New-Item -Path $aumidKey -Force | Out-Null }`,
    `Set-ItemProperty -Path $aumidKey -Name DisplayName -Value '${WINDOWS_APP_ID}'`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast)`,
    // Give the toast time to hand off before the process exits — a process that
    // dies the instant Show returns can drop the toast on the floor.
    `Start-Sleep -Milliseconds 800`,
    // MUST be the LAST line: its arrival in stdout is how the parent confirms
    // the script reached the end rather than silently aborting mid-way.
    `Write-Output ${WINDOWS_TOAST_SENTINEL}`,
  ].join("\n");
}

/** Build the AppleScript passed to `osascript -e` on macOS. */
export function buildDarwinScript(input: DesktopNotification): string {
  return `display notification "${appleScriptEscape(
    input.body
  )}" with title "${appleScriptEscape(input.title)}"`;
}

/** A fully-resolved spawn invocation, with optional stdin payload. */
interface SpawnPlan {
  command: string;
  args: string[];
  /** Written to the child's stdin, then closed, when present. */
  stdin?: string;
  /**
   * When set, exit 0 is NOT sufficient: the child's stdout must also contain
   * this marker for success. Guards against silent-skip failures where the
   * script exits 0 without ever running to completion (win32 `-Command -`).
   */
  sentinel?: string;
}

/** Resolve the spawn invocation for `platform`. Throws on an unsupported one. */
function buildPlan(
  platform: NodeJS.Platform,
  input: DesktopNotification
): SpawnPlan {
  switch (platform) {
    case "win32":
      return {
        command: "powershell.exe",
        // `-Command -` reads the script from stdin: user text never touches argv.
        args: ["-NoProfile", "-NonInteractive", "-Command", "-"],
        stdin: buildWindowsScript(input),
        sentinel: WINDOWS_TOAST_SENTINEL,
      };
    case "darwin":
      return {
        command: "osascript",
        args: ["-e", buildDarwinScript(input)],
      };
    case "linux":
      return {
        command: "notify-send",
        args: [input.title, input.body],
      };
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
}

/**
 * Raise a native desktop notification. Resolves `{ok: true}` when the platform
 * tool exits 0, and `{ok: false, error}` on every failure mode — unsupported
 * platform, spawn error / ENOENT, non-zero exit, or timeout. Never throws.
 */
export async function showDesktopNotification(
  input: DesktopNotification,
  deps: DesktopNotifyDeps = {}
): Promise<DesktopNotifyResult> {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? defaultSpawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let plan: SpawnPlan;
  try {
    plan = buildPlan(platform, input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return new Promise<DesktopNotifyResult>((resolve) => {
    let settled = false;
    const settle = (result: DesktopNotifyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore: the process may already be gone.
      }
      settle({
        ok: false,
        error: `desktop notification timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    // Do not let a pending toast keep the process alive on its own.
    if (typeof timer.unref === "function") timer.unref();

    let child: ChildProcessLike;
    try {
      child = spawn(plan.command, plan.args);
    } catch (err) {
      settle({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Capture stdout so the win32 plan can require its completion sentinel.
    let stdout = "";
    try {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    } catch {
      // A stream that cannot be observed just leaves stdout empty; the sentinel
      // check below then fails closed for the win32 plan.
    }

    child.on("error", (err) => {
      // Covers ENOENT (tool not installed) and any other spawn failure.
      settle({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        settle({ ok: false, error: `${plan.command} exited with code ${code}` });
        return;
      }
      // darwin/linux succeed on exit 0 alone; win32 also needs the sentinel to
      // rule out a script that exited 0 without ever running to completion.
      if (plan.sentinel !== undefined && !stdout.includes(plan.sentinel)) {
        settle({ ok: false, error: "toast script did not complete" });
        return;
      }
      settle({ ok: true });
    });

    if (plan.stdin !== undefined) {
      try {
        child.stdin?.write(plan.stdin);
        child.stdin?.end();
      } catch {
        // A stdin write failure surfaces via the child's "error"/"close" events.
      }
    }
  });
}
