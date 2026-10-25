import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { State } from "./state.ts";

export function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
/** Resolve existing symlink ancestors too: progress/probe files may not escape the workspace. */
export function workspacePath(cwd: string, path: string): string {
  const root = realpathSync(cwd);
  const target = resolve(root, path);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const resolved = resolve(realpathSync(ancestor), relative(ancestor, target));
  const rel = relative(root, resolved);
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  )
    throw new Error("Mission file path escapes its workspace");
  return resolved;
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // malformed ownership fails closed
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export class WorkspaceLease {
  readonly token = randomUUID();
  readonly file: string;
  readonly guard: string;
  constructor(readonly cwd: string) {
    this.file = workspacePath(cwd, ".pi/mission-owner.json");
    this.guard = `${this.file}.guard`;
  }
  private record():
    | { pid: number; token: string; missionId: string }
    | undefined {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private change<T>(fn: () => T): T {
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      mkdirSync(this.guard);
    } catch {
      throw new Error(
        `Ownership change is locked: ${this.guard}. If a process crashed during the claim, inspect the guard/owner and remove only a verified stale guard; never steal a live claim.`,
      );
    }
    try {
      writeFileSync(
        join(this.guard, "owner.json"),
        JSON.stringify({ pid: process.pid, token: this.token }),
      );
      return fn();
    } finally {
      rmSync(this.guard, { recursive: true, force: true });
    }
  }
  acquire(missionId: string): void {
    this.change(() => {
      const old = this.record();
      if (old?.token === this.token) return;
      if (old && alive(old.pid))
        throw new Error(
          `Workspace already owned by mission ${old.missionId}, PID ${old.pid}. Pause/stop its session first. Owner: ${this.file}`,
        );
      if (old) unlinkSync(this.file); // dead-PID recovery, serialized against all other claim/release operations
      writeFileSync(
        this.file,
        JSON.stringify(
          {
            pid: process.pid,
            token: this.token,
            missionId,
            cwd: this.cwd,
            claimedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    });
  }
  release(): void {
    this.change(() => {
      if (this.record()?.token === this.token) unlinkSync(this.file);
    });
  }
  owns(): boolean {
    return this.record()?.token === this.token;
  }
  mayPublish(): boolean {
    const owner = this.record();
    return !owner || owner.token === this.token;
  }
}
export function progressPaths(s: State): {
  progress: string;
  snapshot: string;
} {
  const progress = workspacePath(
    s.cwd,
    s.mission.progressFile || `.pi/missions/${s.id}/PROGRESS.md`,
  );
  return { progress, snapshot: join(dirname(progress), "STATE.json") };
}
export function publishProgress(s: State, snapshot: unknown): void {
  const paths = progressPaths(s);
  const lines = [
    `# Mission progress`,
    "",
    `Updated: ${new Date().toISOString()}`,
    `Mission: ${s.id}`,
    `Status: **${s.status}**`,
    `Goal: ${s.mission.goal}`,
    `Reason: ${s.reason}`,
    `Model turns: ${s.turns}; automatic continuations: ${s.continuations}`,
    "",
    "## Current checkpoint",
    s.report?.summary || "No report yet.",
    ...(s.report?.nextAction ? [`Next action: ${s.report.nextAction}`] : []),
    ...(s.wait
      ? [
          `Waiting: ${s.wait.conditionId}`,
          `External identity/context: ${JSON.stringify(s.wait.input)}`,
          `Resume plan: ${s.wait.summary}`,
          `Next probe: ${s.wait.nextProbeAt ? new Date(s.wait.nextProbeAt).toISOString() : "not armed (paused or starting)"}`,
          `Last observation: ${s.wait.lastObservation || "None"}`,
        ]
      : []),
    "",
    "## Acceptance evidence (agent-reported)",
    ...(s.report?.evidence || []).map((e) => `- ${e.criterion}: ${e.evidence}`),
    "",
    "## Latest verification",
    ...s.checks.map(
      (c) =>
        `- ${c.command}: ${c.code === 0 && !c.killed ? "PASS" : "FAIL"} (exit ${c.code})\n\n\`\`\`text\n${c.output}\n\`\`\``,
    ),
    "",
    "## Significant-event digests (latest first)",
    ...[...(s.digests || [])]
      .reverse()
      .map(
        (d) =>
          `### ${new Date(d.at).toISOString()} — ${d.kind}\n\n${d.summary}\n`,
      ),
    "",
    "State is a checkpoint, not proof the Pi process is alive. Check owner PID/session too.",
  ];
  atomicWrite(paths.progress, lines.join("\n") + "\n");
  atomicWrite(paths.snapshot, JSON.stringify(snapshot, null, 2) + "\n");
}
