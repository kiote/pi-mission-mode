import { readFileSync, statSync } from "node:fs";
import type { Waiter, WaitState } from "./state.ts";
import { workspacePath } from "./runtime.ts";
import { runCheck } from "./verify.ts";

export interface Observation {
  status: "ready" | "pending" | "error";
  detail: string;
}
/** One bounded observation without a model. Command read-only behaviour is a trust contract, not enforced. */
export async function probeWait(
  condition: Waiter,
  wait: WaitState,
  cwd: string,
  signal: AbortSignal,
): Promise<Observation> {
  if (signal.aborted) return { status: "error", detail: "Probe cancelled" };
  if (
    condition.maxWaitSeconds !== null &&
    Date.now() - wait.startedAt >= condition.maxWaitSeconds * 1000
  )
    return {
      status: "error",
      detail:
        "Configured wait deadline reached; remote operation is NOT assumed cancelled",
    };
  if (condition.kind === "time") {
    const until =
      typeof wait.input.until === "string" ? Date.parse(wait.input.until) : NaN;
    if (!Number.isFinite(until))
      return {
        status: "error",
        detail: "Time wait requires input.until as an ISO timestamp",
      };
    return {
      status: Date.now() >= until ? "ready" : "pending",
      detail: `Scheduled time: ${new Date(until).toISOString()}`,
    };
  }
  if (condition.kind === "file") {
    try {
      const path = workspacePath(cwd, condition.path!);
      if (!statSync(path).isFile())
        return { status: "error", detail: "Wait path is not a file" };
      if (!condition.jsonPath)
        return { status: "ready", detail: `File exists: ${path}` };
      if (statSync(path).size > 1000000)
        return { status: "error", detail: "Wait file exceeds 1 MB" };
      let value: unknown = JSON.parse(readFileSync(path, "utf8"));
      for (const key of condition.jsonPath.split(".")) {
        if (key === "__proto__" || key === "constructor" || key === "prototype")
          throw new Error("Unsafe property path");
        value =
          value && typeof value === "object" && Object.hasOwn(value, key)
            ? (value as Record<string, unknown>)[key]
            : undefined;
      }
      const ready =
        condition.equals === undefined
          ? value !== undefined
          : JSON.stringify(value) === JSON.stringify(condition.equals);
      return {
        status: ready ? "ready" : "pending",
        detail: `${condition.jsonPath}=${JSON.stringify(value) ?? "missing"}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "pending", detail: "File not present yet" };
      return { status: "error", detail: (error as Error).message };
    }
  }
  const result = await runCheck(
    condition.command!,
    cwd,
    condition.timeoutSeconds * 1000,
    signal,
    {
      PI_MISSION_WAIT_INPUT: JSON.stringify(wait.input),
    },
  );
  return {
    status: result.killed
      ? "error"
      : result.code === 0
        ? "ready"
        : result.code === 75
          ? "pending"
          : "error",
    detail:
      result.output ||
      `Probe exit ${result.code}${result.killed ? " (cancelled/timed out)" : ""}`,
  };
}
