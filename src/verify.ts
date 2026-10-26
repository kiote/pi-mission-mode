import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { CheckResult } from "./state.ts";

const isWindows = process.platform === "win32";

/**
 * Bash used for mission commands. POSIX: `/bin/bash`. Windows has no `/bin/bash`,
 * so use `PI_MISSION_BASH`, else Git for Windows bash (machine install, per-user
 * install, or the install that owns `git.exe` on PATH). Never a bare `bash.exe`:
 * on Windows that can resolve to WSL's `System32\bash.exe`.
 */
export function resolveBash(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (platform !== "win32") return "/bin/bash";
  if (env.PI_MISSION_BASH)
    return exists(env.PI_MISSION_BASH) ? env.PI_MISSION_BASH : undefined;
  const roots: string[] = [];
  for (const base of [
    env.ProgramFiles,
    env.ProgramW6432,
    env["ProgramFiles(x86)"],
  ]) {
    if (base) roots.push(win32.join(base, "Git"));
  }
  if (env.LOCALAPPDATA)
    roots.push(win32.join(env.LOCALAPPDATA, "Programs", "Git"));
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  for (const dir of (pathKey ? env[pathKey] : "")?.split(";") ?? []) {
    if (!dir || !exists(win32.join(dir, "git.exe"))) continue;
    // git.exe lives in <root>\cmd, <root>\bin, or <root>\mingw64\bin.
    roots.push(win32.dirname(dir), win32.dirname(win32.dirname(dir)));
  }
  for (const root of roots) {
    for (const rel of ["usr\\bin\\bash.exe", "bin\\bash.exe"]) {
      const candidate = win32.join(root, rel);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** On Windows, put the bash directory (Git usr\bin: grep, sed, sleep) first in PATH; the Windows PATH often lacks it. */
function childEnv(
  bash: string,
  env?: Record<string, string>,
): NodeJS.ProcessEnv {
  if (!isWindows) return env ? { ...process.env, ...env } : process.env;
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  const key =
    Object.keys(merged).find((k) => k.toUpperCase() === "PATH") ?? "Path";
  merged[key] = `${win32.dirname(bash)};${merged[key] ?? ""}`;
  return merged;
}

/** Trusted mission commands only. POSIX process groups (Windows: taskkill /T) let timeout/abort kill ordinary descendants too. */
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
    const bash = resolveBash();
    if (!bash) {
      resolve({
        command,
        code: null,
        killed: false,
        output:
          "No bash found for mission checks. Install Git for Windows or set PI_MISSION_BASH to the full path of bash.exe.",
      });
      return;
    }
    let output = "";
    let stdout = "";
    let stdoutTruncated = false;
    let killed = false;
    let finished = false;
    const child = spawn(
      bash,
      ["--noprofile", "--norc", "-o", "pipefail", "-c", command],
      {
        cwd,
        // Windows has no POSIX process groups; taskkill /T stops the tree instead.
        detached: !isWindows,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(bash, env),
      },
    );
    const collect = (data: Buffer) => {
      output = (output + data.toString("utf8")).slice(-12000);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
      if (stdout.length > 12000) {
        stdoutTruncated = true;
        stdout = stdout.slice(-12000);
      }
      collect(Buffer.from(data));
    });
    child.stderr.on("data", collect);
    const kill = () => {
      if (finished) return;
      killed = true;
      try {
        if (isWindows && child.pid) {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
          return;
        }
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
      resolve({ command, code, killed, output, stdout, stdoutTruncated });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}
