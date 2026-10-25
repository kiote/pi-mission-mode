import { spawn } from "node:child_process";
import type { CheckResult } from "./state.ts";

/** Trusted mission commands only. POSIX process groups let timeout/abort kill ordinary descendants too. */
export function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number | null,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        command,
        code: null,
        killed: true,
        output: "Verification cancelled before launch",
      });
      return;
    }
    let output = "";
    let killed = false;
    let finished = false;
    const child = spawn(
      "/bin/bash",
      ["--noprofile", "--norc", "-o", "pipefail", "-c", command],
      {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: env ? { ...process.env, ...env } : process.env,
      },
    );
    const collect = (data: Buffer) => {
      output = (output + data.toString("utf8")).slice(-12000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const kill = () => {
      if (finished) return;
      killed = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    // null disables the time ceiling, not cancellation. Long deadlines must not
    // overflow Node's signed 32-bit timer delay and become accidental 1ms timeouts.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
    const arm = () => {
      if (finished || deadline === undefined) return;
      const left = deadline - Date.now();
      if (left <= 0) {
        kill();
        return;
      }
      timer = setTimeout(arm, Math.min(2147483647, left));
    };
    arm();
    signal?.addEventListener("abort", kill, { once: true });
    // Close the race between the pre-launch check and registering the listener.
    if (signal?.aborted) kill();
    const finish = (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (error) output = `${output}\n${error.message}`.slice(-12000);
      resolve({ command, code, killed, output });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}
