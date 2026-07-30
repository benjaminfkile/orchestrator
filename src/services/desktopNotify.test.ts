import type { ChildProcessLike, SpawnFn } from "./desktopNotify";
import { WINDOWS_TOAST_SENTINEL, showDesktopNotification } from "./desktopNotify";

/** A hand-driven fake child process; the test emits `close`/`error` itself. */
class FakeChild implements ChildProcessLike {
  readonly writes: string[] = [];
  ended = false;
  killed = false;
  stdin = {
    write: (chunk: string) => {
      this.writes.push(chunk);
      return true;
    },
    end: () => {
      this.ended = true;
      return undefined;
    },
  };
  private handlers: Record<string, (arg: unknown) => void> = {};
  private stdoutHandlers: ((chunk: string) => void)[] = [];
  stdout = {
    on: (_event: "data", listener: (chunk: string) => void) => {
      this.stdoutHandlers.push(listener);
      return this.stdout;
    },
  };

  on(event: "error" | "close", listener: (arg: never) => void): this {
    this.handlers[event] = listener as (arg: unknown) => void;
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emit(event: "error" | "close", arg: unknown): void {
    this.handlers[event]?.(arg);
  }
  /** Push a chunk to any registered stdout `data` listeners. */
  emitStdout(chunk: string): void {
    for (const listener of this.stdoutHandlers) listener(chunk);
  }
  /**
   * Emit the win32 completion sentinel on stdout, then close with `code`.
   * Mirrors the happy path of a script that ran end to end.
   */
  finishWithSentinel(code = 0): void {
    this.emitStdout(`${WINDOWS_TOAST_SENTINEL}\n`);
    this.emit("close", code);
  }
  /** The stdin payload the module wrote, joined. */
  get stdinText(): string {
    return this.writes.join("");
  }
}

/** A spawn stub that records the invocation and hands back `child`. */
function stubSpawn(child: ChildProcessLike): {
  spawn: SpawnFn;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    return child;
  };
  return { spawn, calls };
}

const HOSTILE = `a"b'c<d>e&f$g\`h`;

describe("showDesktopNotification", () => {
  describe("win32", () => {
    it("spawns powershell reading a toast script from stdin", async () => {
      const child = new FakeChild();
      const { spawn, calls } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "Hi", body: "There" },
        { platform: "win32", spawn }
      );
      child.finishWithSentinel(0);
      const res = await p;

      expect(res).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("powershell.exe");
      expect(calls[0].args).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "-",
      ]);
      // The script arrives over stdin, never on the command line.
      expect(child.ended).toBe(true);
      expect(child.stdinText).toContain(
        "Windows.UI.Notifications.ToastNotificationManager"
      );
      expect(child.stdinText).toContain("<text>Hi</text>");
      expect(child.stdinText).toContain("<text>There</text>");
    });

    it("uses a single-line single-quoted XML string, never a here-string", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "Hi", body: "There" },
        { platform: "win32", spawn }
      );
      child.finishWithSentinel(0);
      await p;

      const script = child.stdinText;
      // No PowerShell here-string: PS 5.1 `-Command -` stdin aborts at `@'`.
      expect(script).not.toContain("@'");
      expect(script).not.toContain("'@");
      // XML is loaded via a single-quoted string, all on ONE line.
      const loadLine = script
        .split("\n")
        .find((line) => line.includes("$xml.LoadXml("));
      expect(loadLine).toBeDefined();
      expect(loadLine).toContain("$xml.LoadXml('<toast>");
      expect(loadLine).toContain("</toast>')");
      // The whole toast markup sits on that one line — no embedded newline.
      expect(loadLine).toContain("<text>Hi</text><text>There</text>");
    });

    it("ends with the post-Show sleep then the stdout sentinel", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "win32", spawn }
      );
      child.finishWithSentinel(0);
      await p;

      const lines = child.stdinText.split("\n");
      // The Show call comes first, then the sleep, then the sentinel last.
      const showIdx = lines.findIndex((l) => l.includes("CreateToastNotifier"));
      const sleepIdx = lines.findIndex((l) =>
        l.includes("Start-Sleep -Milliseconds 800")
      );
      expect(showIdx).toBeGreaterThanOrEqual(0);
      expect(sleepIdx).toBeGreaterThan(showIdx);
      expect(lines[lines.length - 1]).toBe(`Write-Output ${WINDOWS_TOAST_SENTINEL}`);
      expect(lines[lines.length - 2]).toBe("Start-Sleep -Milliseconds 800");
    });

    it("XML-escapes hostile title/body and never emits the raw markup", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: HOSTILE, body: "<b>bold</b>" },
        { platform: "win32", spawn }
      );
      child.finishWithSentinel(0);
      await p;

      const script = child.stdinText;
      // Injected angle brackets/ampersand/quotes are all escaped.
      expect(script).toContain("&lt;d&gt;");
      expect(script).toContain("&amp;f");
      expect(script).toContain("&quot;b");
      expect(script).toContain("&apos;c");
      // The hostile <b> tag must not survive as real markup.
      expect(script).not.toContain("<b>bold</b>");
      expect(script).toContain("&lt;b&gt;bold&lt;/b&gt;");
      // `$` and backtick are inert inside the single-quoted XML string, so they
      // are allowed to pass through literally without breaking anything.
      expect(script).toContain("$g`h");
    });

    it("idempotently self-registers the AppUserModelID under HKCU before Show", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "win32", spawn }
      );
      child.finishWithSentinel(0);
      await p;

      const script = child.stdinText;
      // The registration is guarded so it only creates the key when absent.
      expect(script).toContain(
        "$aumidKey = 'HKCU:\\Software\\Classes\\AppUserModelId\\orchestrator'"
      );
      expect(script).toContain(
        "if (-not (Test-Path $aumidKey)) { New-Item -Path $aumidKey -Force | Out-Null }"
      );
      expect(script).toContain(
        "Set-ItemProperty -Path $aumidKey -Name DisplayName -Value 'orchestrator'"
      );
      // The very same AppId feeds both the registry path and the notifier, and
      // the registration must precede the Show call.
      expect(script).toContain("CreateToastNotifier('orchestrator').Show($toast)");
      expect(script.indexOf("$aumidKey")).toBeLessThan(
        script.indexOf("CreateToastNotifier")
      );
    });

    it("emits a display-only toast with no click-through launch attribute", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "win32", spawn }
      );
      child.finishWithSentinel(0);
      await p;

      expect(child.stdinText).toContain("<toast>");
      expect(child.stdinText).not.toContain("activationType");
      expect(child.stdinText).not.toContain("launch=");
    });

    it("fails when the script exits 0 WITHOUT emitting the sentinel", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "win32", spawn }
      );
      // Exit 0 but no sentinel on stdout: the silent-skip failure this guards.
      child.emit("close", 0);
      const res = await p;

      expect(res.ok).toBe(false);
      expect(res.error).toBe("toast script did not complete");
    });

    it("fails on a non-zero exit even if the sentinel appeared", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "win32", spawn }
      );
      child.emitStdout(`${WINDOWS_TOAST_SENTINEL}\n`);
      child.emit("close", 4);
      const res = await p;

      expect(res.ok).toBe(false);
      expect(res.error).toContain("exited with code 4");
    });

    it("treats ENOENT (powershell missing) as a failure, not a crash", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "win32", spawn }
      );
      const enoent = Object.assign(new Error("spawn powershell.exe ENOENT"), {
        code: "ENOENT",
      });
      child.emit("error", enoent);
      const res = await p;

      expect(res.ok).toBe(false);
      expect(res.error).toContain("ENOENT");
    });

    it("kills the child and fails when the toast script never exits", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      // No close/error and no sentinel: only the timeout can settle it.
      const res = await showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "win32", spawn, timeoutMs: 15 }
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("timed out");
      expect(child.killed).toBe(true);
    });
  });

  describe("darwin", () => {
    it("spawns osascript with a single escaped -e script argv", async () => {
      const child = new FakeChild();
      const { spawn, calls } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "Title", body: "Body" },
        { platform: "darwin", spawn }
      );
      child.emit("close", 0);
      const res = await p;

      expect(res).toEqual({ ok: true });
      expect(calls[0].command).toBe("osascript");
      expect(calls[0].args[0]).toBe("-e");
      expect(calls[0].args).toHaveLength(2);
      expect(calls[0].args[1]).toBe(
        `display notification "Body" with title "Title"`
      );
    });

    it("escapes double-quotes and backslashes in the AppleScript literal", async () => {
      const child = new FakeChild();
      const { spawn, calls } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: `he said "hi"`, body: `back\\slash` },
        { platform: "darwin", spawn }
      );
      child.emit("close", 0);
      await p;

      expect(calls[0].args[1]).toBe(
        `display notification "back\\\\slash" with title "he said \\"hi\\""`
      );
    });
  });

  describe("linux", () => {
    it("spawns notify-send with title and body as separate argv", async () => {
      const child = new FakeChild();
      const { spawn, calls } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: HOSTILE, body: "the body" },
        { platform: "linux", spawn }
      );
      child.emit("close", 0);
      const res = await p;

      expect(res).toEqual({ ok: true });
      expect(calls[0].command).toBe("notify-send");
      // Passed verbatim as argv — no shell, so no escaping needed.
      expect(calls[0].args).toEqual([HOSTILE, "the body"]);
    });

    it("treats ENOENT (notify-send not installed) as a failure, not a crash", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "linux", spawn }
      );
      const enoent = Object.assign(new Error("spawn notify-send ENOENT"), {
        code: "ENOENT",
      });
      child.emit("error", enoent);
      const res = await p;

      expect(res.ok).toBe(false);
      expect(res.error).toContain("ENOENT");
    });
  });

  describe("failure paths", () => {
    it("fails on an unsupported platform without spawning", async () => {
      const child = new FakeChild();
      const { spawn, calls } = stubSpawn(child);

      const res = await showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "freebsd" as NodeJS.Platform, spawn }
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("unsupported platform: freebsd");
      expect(calls).toHaveLength(0);
    });

    it("fails on a non-zero exit code", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const p = showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "linux", spawn }
      );
      child.emit("close", 3);
      const res = await p;

      expect(res.ok).toBe(false);
      expect(res.error).toContain("exited with code 3");
    });

    it("kills the child and fails when it does not exit before the timeout", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      // The child never emits close/error, so only the timeout can settle it.
      const res = await showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "linux", spawn, timeoutMs: 15 }
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("timed out");
      expect(child.killed).toBe(true);
    });

    it("fails without throwing when the spawn itself throws", async () => {
      const spawn: SpawnFn = () => {
        throw new Error("spawn boom");
      };

      const res = await showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "linux", spawn }
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("spawn boom");
    });

    it("does not settle twice when close arrives after the timeout", async () => {
      const child = new FakeChild();
      const { spawn } = stubSpawn(child);

      const res = await showDesktopNotification(
        { title: "T", body: "B" },
        { platform: "linux", spawn, timeoutMs: 10 }
      );
      expect(res.error).toContain("timed out");

      // A late close must not change the already-resolved result.
      expect(() => child.emit("close", 0)).not.toThrow();
    });
  });
});
