import { createHash, randomUUID } from "node:crypto";

export interface Waiter {
  id: string;
  kind: "command" | "file" | "time";
  command?: string;
  path?: string;
  jsonPath?: string;
  equals?: unknown;
  intervalSeconds: number;
  timeoutSeconds: number;
  maxErrors: number;
  maxWaitSeconds: number | null;
}
export interface WaitState {
  conditionId: string;
  input: Record<string, unknown>;
  summary: string;
  startedAt: number;
  nextProbeAt?: number;
  lastObservation?: string;
  errors: number;
}
export interface Mission {
  goal: string;
  workspace?: string;
  instructions?: string;
  progressFile?: string;
  waiters: Waiter[];
  acceptance: string[];
  constraints: string[];
  checks: { command: string; timeoutSeconds?: number | null }[];
  startupChecks: { command: string; timeoutSeconds?: number | null }[];
  limits: {
    maxMinutes: number | null;
    maxContinuations: number | null;
    maxTurns: number | null;
    maxConsecutiveNoProgress: number | null;
    checkTimeoutSeconds: number | null;
  };
  policies: { noProgress: "reassess" | "pause" | "stop" };
}
export type Status =
  | "starting"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "blocked"
  | "exhausted"
  | "stopped"
  | "review_required";
export interface Report {
  status: "progress" | "complete" | "blocked";
  summary: string;
  evidence: { criterion: number; evidence: string }[];
  blocker?: string;
  significant?: boolean;
  nextAction?: string;
}
export interface CheckResult {
  command: string;
  code: number | null;
  output: string;
  killed: boolean;
}
export interface State {
  version: 1;
  id: string;
  file: string;
  cwd: string;
  mission: Mission;
  status: Status;
  reason: string;
  createdAt: number;
  usedMs: number;
  runningSince?: number;
  continuations: number;
  turns: number;
  noProgress: number;
  seenActivity: string[];
  cycleActivity: string[];
  bestCoverage: number;
  report?: Report;
  checks: CheckResult[];
  wait?: WaitState;
  pendingWait?: WaitState;
  digests?: { at: number; kind: string; summary: string }[];
}

function strings(value: unknown, name: string, required = false): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v.trim()) ||
    (required && !value.length)
  ) {
    throw new Error(
      `${name} must be ${required ? "a nonempty" : "an"} array of nonempty strings`,
    );
  }
  if (value.length > 100 || value.some((v) => v.length > 20000))
    throw new Error(`${name} is too large`);
  return value.map((v) => v.trim());
}
export const DEFAULT_LIMITS: Mission["limits"] = {
  maxMinutes: null,
  maxContinuations: null,
  maxTurns: null,
  maxConsecutiveNoProgress: null,
  checkTimeoutSeconds: null,
};
function optionalLimit(value: unknown, name: string, unit = 1): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Math.floor(Number.MAX_SAFE_INTEGER / unit)
  ) {
    throw new Error(
      `${name} must be a positive safe integer or null (disabled)`,
    );
  }
  return value;
}
export function checkTimeoutMs(
  mission: Mission,
  check: Mission["checks"][number],
): number {
  const seconds =
    check.timeoutSeconds === undefined
      ? mission.limits.checkTimeoutSeconds
      : check.timeoutSeconds;
  return seconds === null ? Infinity : seconds * 1000;
}
export function continuationLimitReached(s: State): boolean {
  return (
    s.mission.limits.maxContinuations !== null &&
    s.continuations >= s.mission.limits.maxContinuations
  );
}
export function unboundedWarning(mission: Mission): string {
  return mission.limits.maxMinutes === null &&
    mission.limits.maxTurns === null &&
    mission.limits.maxContinuations === null
    ? "WARNING: No runtime, turn, or continuation ceiling is configured. Work can continue indefinitely and incur ongoing provider charges. Pause/stop remain available."
    : "";
}
export function approvalSummary(mission: Mission): string {
  const commands = (checks: Mission["checks"]) =>
    checks
      .map(
        (c) =>
          `${c.command} (timeout: ${c.timeoutSeconds === undefined ? (mission.limits.checkTimeoutSeconds ?? "none") : (c.timeoutSeconds ?? "none")} seconds)`,
      )
      .join("\n") || "None";
  return [
    `Goal: ${mission.goal}`,
    `Limits (null = disabled): ${JSON.stringify(mission.limits)}`,
    `No-progress policy: ${mission.policies.noProgress}`,
    unboundedWarning(mission),
    `Startup commands (executed before the model):\n${commands(mission.startupChecks)}`,
    `Completion commands:\n${commands(mission.checks)}`,
    `Wait conditions:\n${mission.waiters.map((w) => `${w.id}: ${w.kind === "command" ? w.command : w.kind === "file" ? w.path : "scheduled time"}${w.kind === "command" ? ` (probe timeout: ${w.timeoutSeconds} seconds)` : ""}`).join("\n") || "None"}`,
    `Progress file: ${mission.progressFile || "workspace .pi/missions/<id>/PROGRESS.md"}`,
    "Commands run with Pi's permissions and bypass tool-call permission gates. Read-only behaviour of startup/probe commands is NOT enforced. Constraints are instructions, NOT a sandbox. Only approve trusted mission definitions and commands.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function parseMission(value: unknown): Mission {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Mission must be a JSON object");
  const v = value as Record<string, unknown>;
  const allowed = [
    "goal",
    "acceptance",
    "constraints",
    "checks",
    "limits",
    "policies",
    "workspace",
    "instructions",
    "progressFile",
    "waiters",
    "startupChecks",
  ];
  for (const k of Object.keys(v))
    if (!allowed.includes(k)) throw new Error(`Unknown mission field: ${k}`);
  if (typeof v.goal !== "string" || !v.goal.trim() || v.goal.length > 20000)
    throw new Error("goal must be a nonempty string (up to 20000 characters)");
  const raw = v.limits ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("limits must be an object");
  const limits = { ...DEFAULT_LIMITS };
  for (const [k, n] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, k))
      throw new Error(`Unknown limit: ${k}`);
    (limits as Record<string, number | null>)[k] = optionalLimit(
      n,
      k,
      k === "maxMinutes" ? 60000 : k === "checkTimeoutSeconds" ? 1000 : 1,
    );
  }
  const policy = v.policies ?? {};
  if (!policy || typeof policy !== "object" || Array.isArray(policy))
    throw new Error("policies must be an object");
  for (const k of Object.keys(policy))
    if (k !== "noProgress") throw new Error(`Unknown policy: ${k}`);
  const noProgress =
    (policy as Record<string, unknown>).noProgress ?? "reassess";
  if (!["reassess", "pause", "stop"].includes(noProgress as string))
    throw new Error("policies.noProgress must be reassess, pause, or stop");
  const parseChecks = (rawChecks: unknown) => {
    if (!Array.isArray(rawChecks) || rawChecks.length > 100)
      throw new Error("checks must be an array of at most 100 commands");
    return rawChecks.map((check, i) => {
      if (typeof check === "string")
        return { command: strings([check], `checks[${i}]`, true)[0] };
      if (!check || typeof check !== "object" || Array.isArray(check))
        throw new Error(`checks[${i}] must be a string or command object`);
      for (const k of Object.keys(check))
        if (!["command", "timeoutSeconds"].includes(k))
          throw new Error(`Unknown check field: ${k}`);
      return {
        command: strings([check.command], `checks[${i}].command`, true)[0],
        ...(check.timeoutSeconds === undefined
          ? {}
          : {
              timeoutSeconds: optionalLimit(
                check.timeoutSeconds,
                `checks[${i}].timeoutSeconds`,
                1000,
              ),
            }),
      };
    });
  };
  const checks = parseChecks(v.checks ?? []);
  const startupChecks = parseChecks(v.startupChecks ?? []);
  const optionalText: {
    workspace?: string;
    instructions?: string;
    progressFile?: string;
  } = {};
  for (const key of ["workspace", "instructions", "progressFile"] as const) {
    if (v[key] !== undefined) {
      if (
        typeof v[key] !== "string" ||
        !v[key].trim() ||
        v[key].length > 100000
      )
        throw new Error(`${key} must be a nonempty string`);
      optionalText[key] = v[key].trim();
    }
  }
  const rawWaiters = v.waiters ?? [];
  if (!Array.isArray(rawWaiters) || rawWaiters.length > 100)
    throw new Error("waiters must be an array of at most 100 conditions");
  const ids = new Set<string>();
  const waiters: Waiter[] = rawWaiters.map((w) => {
    if (!w || typeof w !== "object" || Array.isArray(w))
      throw new Error("Each waiter must be an object");
    for (const key of Object.keys(w))
      if (
        ![
          "id",
          "kind",
          "command",
          "path",
          "jsonPath",
          "equals",
          "intervalSeconds",
          "timeoutSeconds",
          "maxErrors",
          "maxWaitSeconds",
        ].includes(key)
      )
        throw new Error(`Unknown waiter field: ${key}`);
    if (
      typeof w.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(w.id) ||
      ids.has(w.id)
    )
      throw new Error("Waiter IDs must be unique simple names");
    ids.add(w.id);
    if (!["command", "file", "time"].includes(w.kind))
      throw new Error("Waiter kind must be command, file, or time");
    if (
      w.kind === "command" &&
      (typeof w.command !== "string" || !w.command.trim())
    )
      throw new Error("Command waiter requires command");
    if (w.kind === "file" && (typeof w.path !== "string" || !w.path.trim()))
      throw new Error("File waiter requires path");
    if (
      (w.kind !== "command" && w.command !== undefined) ||
      (w.kind !== "file" &&
        [w.path, w.jsonPath, w.equals].some((x) => x !== undefined))
    )
      throw new Error("Waiter fields do not match its kind");
    if (
      w.jsonPath !== undefined &&
      (typeof w.jsonPath !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(w.jsonPath))
    )
      throw new Error("jsonPath must be a dotted property path");
    if (w.equals !== undefined && w.jsonPath === undefined)
      throw new Error("equals requires jsonPath");
    const positive = (key: string, fallback: number) => {
      const n = optionalLimit(
        w[key] ?? fallback,
        key,
        key.endsWith("Seconds") ? 1000 : 1,
      );
      if (n === null) throw new Error(`${key} cannot be null`);
      return n;
    };
    return {
      id: w.id,
      kind: w.kind,
      ...(w.command !== undefined ? { command: w.command } : {}),
      ...(w.path !== undefined ? { path: w.path } : {}),
      ...(w.jsonPath !== undefined ? { jsonPath: w.jsonPath } : {}),
      ...(w.equals !== undefined ? { equals: w.equals } : {}),
      intervalSeconds: positive("intervalSeconds", 60),
      timeoutSeconds: positive("timeoutSeconds", 30),
      maxErrors: positive("maxErrors", 1),
      maxWaitSeconds: optionalLimit(
        w.maxWaitSeconds ?? null,
        "maxWaitSeconds",
        1000,
      ),
    };
  });
  return {
    ...optionalText,
    waiters,
    startupChecks,
    goal: v.goal.trim(),
    acceptance: strings(v.acceptance, "acceptance", true),
    constraints: strings(v.constraints ?? [], "constraints"),
    checks,
    limits,
    policies: { noProgress: noProgress as Mission["policies"]["noProgress"] },
  };
}
export function createState(
  mission: Mission,
  file: string,
  cwd: string,
  now = Date.now(),
): State {
  return {
    version: 1,
    id: randomUUID(),
    file,
    cwd,
    mission,
    status: "running",
    reason: "Mission started",
    createdAt: now,
    usedMs: 0,
    runningSince: now,
    continuations: 0,
    turns: 0,
    noProgress: 0,
    seenActivity: [],
    cycleActivity: [],
    bestCoverage: 0,
    checks: [],
  };
}
export function elapsed(s: State, now = Date.now()): number {
  return (
    s.usedMs +
    (s.runningSince === undefined ? 0 : Math.max(0, now - s.runningSince))
  );
}
export function remaining(s: State, now = Date.now()): number {
  return s.mission.limits.maxMinutes === null
    ? Infinity
    : Math.max(0, s.mission.limits.maxMinutes * 60000 - elapsed(s, now));
}
export function transition(
  s: State,
  status: Status,
  reason: string,
  now = Date.now(),
): void {
  s.usedMs = elapsed(s, now);
  s.runningSince = status === "running" ? now : undefined;
  s.status = status;
  s.reason = reason;
}
export function limitReason(s: State, now = Date.now()): string | undefined {
  if (remaining(s, now) <= 0)
    return "Running wall-time limit reached (includes blocking tools; explicit WAITING excluded)";
  if (
    s.mission.limits.maxTurns !== null &&
    s.turns >= s.mission.limits.maxTurns
  )
    return "Model turn limit reached";
  return undefined;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}
export function coverage(s: State): number {
  return new Set(
    (s.report?.evidence ?? [])
      .filter(
        (e) =>
          Number.isInteger(e.criterion) &&
          e.criterion >= 1 &&
          e.criterion <= s.mission.acceptance.length &&
          e.evidence.trim(),
      )
      .map((e) => e.criterion),
  ).size;
}
/** Novel tool-result signatures or increased evidence coverage count as progress (a heuristic, not proof). */
export function closeCycle(s: State): boolean {
  const known = new Set(s.seenActivity);
  const covered = coverage(s);
  const progress =
    s.cycleActivity.some((hash) => !known.has(hash)) ||
    covered > s.bestCoverage;
  s.seenActivity = [...new Set([...s.seenActivity, ...s.cycleActivity])].slice(
    -2000,
  );
  s.cycleActivity = [];
  s.bestCoverage = Math.max(s.bestCoverage, covered);
  s.noProgress = progress ? 0 : s.noProgress + 1;
  return progress;
}
export function missionPrompt(s: State): string {
  return `[MISSION MODE — ${s.id}]
Workspace: ${s.cwd}
Goal: ${s.mission.goal}
Acceptance criteria (1-based indices):
${s.mission.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}
Constraints:
${s.mission.constraints.map((a) => `- ${a}`).join("\n") || "- No additional mission-specific constraints."}
Working policy:
- Work independently: inspect, plan, implement, verify, and fix failures. Do not stop merely after planning or one subtask.
- Stay within this workspace and the mission's authority. Do not deploy, push, purchase, expose secrets, or discard unrelated work unless this mission explicitly authorizes it.
- Make reasonable reversible decisions; escalate only missing access, conflicting requirements, or decisions outside your authority.
- Do not edit the mission definition, weaken tests, or manipulate verification to claim success.
- Use mission_report to checkpoint progress. Mark significant=true for an important digest; include nextAction and concrete facts/IDs in the summary. Routine checkpoints do not send digests.
- For remote jobs, quota renewal, or other external dependencies use mission_wait with a configured conditionId and exact operation identities in input. It yields without model polling and resumes when the deterministic probe is ready. Do not wait by repeatedly calling the model or a long blocking shell command solely to poll.
- Do not perform more tool calls after mission_wait; finish the response so the runtime can enter waiting. Reconcile existing operations before retrying any external write.
- Before finishing the mission, report complete with evidence for EVERY acceptance criterion, or blocked with a precise blocker.
- Report evidence is a claim; configured checks run independently after your completion report.
- After a complete report, do not call other tools; further tool calls invalidate the report.
- Configured hard limits are cumulative across pause/resume; null means disabled: ${JSON.stringify(s.mission.limits)}.
- maxMinutes counts running wall time, including blocking tool execution, NOT model reasoning time; explicit WAITING and PAUSED time is excluded.
- No-progress policy: ${s.mission.policies.noProgress}. The heuristic is not proof of a blocker; normal external waiting is not a failed experiment.
Mission-specific instructions (within the user's authority):
${s.mission.instructions || "None"}
Configured wait conditions: ${JSON.stringify(s.mission.waiters)}
Last external wait: ${s.wait ? JSON.stringify(s.wait) : "None"}
Configured checks: ${JSON.stringify(s.mission.checks)}
Latest checkpoint: ${s.report?.summary ?? "None yet"}
Current counters: ${s.turns} turns; ${s.continuations} continuations; ${Number.isFinite(remaining(s)) ? `${Math.ceil(remaining(s) / 1000)} seconds remaining` : "no runtime ceiling"}.`;
}
export const TEMPLATE = {
  goal: "REPLACE ME: describe the outcome to achieve",
  acceptance: ["REPLACE ME: a concrete, verifiable success criterion"],
  constraints: [
    "Do not deploy or push",
    "Do not access production or expose secrets",
    "Do not discard unrelated work or weaken existing tests",
  ],
  checks: [],
  limits: { ...DEFAULT_LIMITS },
  policies: { noProgress: "reassess" },
};
