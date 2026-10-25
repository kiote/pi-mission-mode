import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { workspacePath } from "./runtime.ts";
import { runCheck } from "./verify.ts";

export interface OperationDefinition {
  id: string;
  launch: string;
  reconcile: string;
  verify: string;
  timeoutSeconds: number;
  retryAfterAbsent: boolean;
}
export interface OperationAttempt {
  id: string;
  startedAt: number;
  operationId?: string;
  receipt?: unknown;
  result?: string;
}
export interface OperationRecord {
  key: string;
  definition: OperationDefinition;
  missionIds: string[];
  input: Record<string, unknown>;
  idempotencyKey: string;
  attempts: OperationAttempt[];
  status:
    | "launching"
    | "unknown"
    | "pending"
    | "succeeded"
    | "failed"
    | "absent";
  needsReconciliation: boolean;
  reconciliation?: { at: number; detail: unknown };
  readiness?: { at: number; detail: string };
  verification?: { at: number; attemptId: string; detail: unknown };
}
export function operationContext(r: OperationRecord) {
  const attempt = r.attempts.at(-1)!;
  return {
    key: r.key,
    input: r.input,
    idempotencyKey: r.idempotencyKey,
    attemptId: attempt.id,
    operationId: attempt.operationId,
    receipt: attempt.receipt,
    status: r.status,
  };
}
interface Ledger {
  version: 1;
  records: OperationRecord[];
}
const name = /^[a-zA-Z0-9_-]{1,80}$/;
const keyPattern = /^[a-zA-Z0-9_.:/-]{1,200}$/;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseOperations(value: unknown): OperationDefinition[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("operations must be an array of at most 100 adapters");
  const ids = new Set<string>();
  return value.map((v) => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new Error("Operation adapter must be an object");
    for (const k of Object.keys(v))
      if (
        ![
          "id",
          "launch",
          "reconcile",
          "verify",
          "timeoutSeconds",
          "retryAfterAbsent",
        ].includes(k)
      )
        throw new Error(`Unknown operation adapter field: ${k}`);
    if (typeof v.id !== "string" || !name.test(v.id) || ids.has(v.id))
      throw new Error("Operation adapter IDs must be unique simple names");
    ids.add(v.id);
    for (const k of ["launch", "reconcile", "verify"])
      if (typeof v[k] !== "string" || !v[k].trim() || v[k].length > 20000)
        throw new Error(`Operation adapter requires ${k} command`);
    const timeoutSeconds =
      v.timeoutSeconds === undefined ? 30 : v.timeoutSeconds;
    if (
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds <= 0 ||
      timeoutSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    )
      throw new Error(
        "Operation timeoutSeconds must be a positive safe integer",
      );
    if (
      v.retryAfterAbsent !== undefined &&
      typeof v.retryAfterAbsent !== "boolean"
    )
      throw new Error("retryAfterAbsent must be boolean");
    return {
      id: v.id,
      launch: v.launch,
      reconcile: v.reconcile,
      verify: v.verify,
      timeoutSeconds,
      retryAfterAbsent: v.retryAfterAbsent ?? false,
    };
  });
}

/** A write-ahead, workspace-wide ledger. Session branches can never roll it back. */
export class OperationLedger {
  readonly file: string;
  private busy = false;
  // A persisted reconciliation is not fresh authority after pause/reload/resume.
  private fresh = new Set<string>();
  constructor(readonly cwd: string) {
    this.file = workspacePath(cwd, ".pi/mission-operations.json");
  }
  private read(): Ledger {
    if (!existsSync(this.file)) return { version: 1, records: [] };
    const data = JSON.parse(readFileSync(this.file, "utf8"));
    if (data?.version !== 1 || !Array.isArray(data.records))
      throw new Error(
        "Invalid operation ledger; inspect it, never delete it to retry",
      );
    const keys = new Set<string>();
    for (const r of data.records) {
      if (
        !r ||
        typeof r.key !== "string" ||
        !keyPattern.test(r.key) ||
        keys.has(r.key) ||
        !Array.isArray(r.missionIds) ||
        r.missionIds.some((id: unknown) => typeof id !== "string") ||
        !r.input ||
        typeof r.input !== "object" ||
        Array.isArray(r.input) ||
        typeof r.idempotencyKey !== "string" ||
        !name.test(r.idempotencyKey) ||
        !Array.isArray(r.attempts) ||
        !r.attempts.length ||
        r.attempts.some(
          (a: OperationAttempt) =>
            !a ||
            typeof a.id !== "string" ||
            !name.test(a.id) ||
            !Number.isFinite(a.startedAt) ||
            (a.operationId !== undefined &&
              (typeof a.operationId !== "string" || !a.operationId.trim())),
        ) ||
        typeof r.needsReconciliation !== "boolean" ||
        ![
          "launching",
          "unknown",
          "pending",
          "succeeded",
          "failed",
          "absent",
        ].includes(r.status)
      )
        throw new Error(
          "Invalid operation record; reconciliation requires an intact ledger",
        );
      parseOperations([r.definition]);
      keys.add(r.key);
    }
    return data as Ledger;
  }
  private write(data: Ledger): void {
    // Persist + fsync the intent before any launch. A failure here forbids launch.
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.file);
      const dir = openSync(dirname(this.file), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
  list(missionId?: string): OperationRecord[] {
    return this.read().records.filter(
      (r) => !missionId || r.missionIds.includes(missionId),
    );
  }
  get(key: string): OperationRecord {
    const r = this.read().records.find((r) => r.key === key);
    if (!r) throw new Error(`Unknown operation key: ${key}`);
    return r;
  }
  resetFreshness(): void {
    this.fresh.clear();
  }
  completionIssues(missionId: string): string[] {
    return this.list(missionId)
      .filter(
        (r) =>
          !this.fresh.has(r.key) ||
          r.needsReconciliation ||
          !["succeeded", "failed", "absent"].includes(r.status) ||
          r.verification?.attemptId !== r.attempts.at(-1)!.id,
      )
      .map(
        (r) =>
          `${r.key}: ${r.status}; reconcile and verify the exact current attempt`,
      );
  }
  markReady(key: string, missionId: string, detail: string): void {
    const data = this.read();
    const r = data.records.find((r) => r.key === key);
    if (!r || !r.missionIds.includes(missionId))
      throw new Error("Wait operation is not owned by this mission");
    r.readiness = { at: Date.now(), detail: detail.slice(-12000) };
    r.needsReconciliation = true;
    r.verification = undefined;
    this.fresh.delete(key);
    this.write(data);
  }
  async act(
    request: {
      action: "launch" | "retry" | "reconcile" | "verify";
      definition: OperationDefinition;
      key: string;
      input?: Record<string, unknown>;
      missionId: string;
    },
    signal: AbortSignal,
    owns: () => boolean,
    maxRuntimeMs = Infinity,
  ): Promise<OperationRecord> {
    if (this.busy)
      throw new Error("Another managed operation command is still settling");
    if (signal.aborted || !owns())
      throw new Error("Operation requires an active workspace owner");
    if (!keyPattern.test(request.key))
      throw new Error(
        "Operation key must be a stable simple business identity (1–200 characters)",
      );
    if (maxRuntimeMs <= 0)
      throw new Error("Mission runtime exhausted before adapter launch");
    this.busy = true;
    try {
      const data = this.read();
      let r = data.records.find((r) => r.key === request.key);
      const { action, definition, missionId } = request;
      if (r && hash(r.definition) !== hash(definition))
        throw new Error(
          "Operation key belongs to a different adapter contract; do not relaunch it",
        );
      if (action === "launch") {
        const ambiguous = data.records.find((record) =>
          ["launching", "unknown"].includes(record.status),
        );
        if (ambiguous)
          throw new Error(
            `Reconcile ambiguous operation ${ambiguous.key} before another launch (including under a different key)`,
          );
        if (r)
          throw new Error(
            `Operation already recorded (${r.status}); reconcile it, never relaunch blindly`,
          );
        if (
          !request.input ||
          Array.isArray(request.input) ||
          typeof request.input !== "object" ||
          JSON.stringify(request.input).length > 20000
        )
          throw new Error(
            "Launch requires an input object (up to 20000 JSON characters)",
          );
        r = {
          key: request.key,
          definition: structuredClone(definition),
          missionIds: [missionId],
          input: structuredClone(request.input),
          idempotencyKey: randomUUID(),
          attempts: [],
          status: "unknown",
          needsReconciliation: true,
        };
        data.records.push(r);
      } else {
        if (!r) throw new Error("No recorded launch intent for this key");
        if (request.input !== undefined)
          throw new Error("Operation input is immutable; omit it after launch");
        if (!r.missionIds.includes(missionId)) {
          if (action !== "reconcile")
            throw new Error(
              "Reconcile the existing operation before adopting it into this mission",
            );
          r.missionIds.push(missionId);
        }
      }
      if (action === "retry") {
        if (
          !definition.retryAfterAbsent ||
          r.status !== "absent" ||
          r.needsReconciliation ||
          !this.fresh.has(r.key) ||
          r.attempts.at(-1)?.operationId
        )
          throw new Error(
            "Retry requires opt-in retryAfterAbsent and fresh authoritative absence with no known operation ID",
          );
      }
      if (
        action === "verify" &&
        (r.needsReconciliation ||
          !this.fresh.has(r.key) ||
          !["succeeded", "failed", "absent"].includes(r.status))
      )
        throw new Error(
          "Verification requires fresh terminal reconciliation, not readiness or a launch claim",
        );
      if (action === "launch" || action === "retry") {
        r.attempts.push({ id: randomUUID(), startedAt: Date.now() });
        r.status = "launching";
        r.reconciliation = undefined;
        r.readiness = undefined;
      }
      // Any attempted reconciliation/verification invalidates previous success before executing.
      r.verification = undefined;
      r.needsReconciliation = action !== "verify";
      if (action !== "verify") this.fresh.delete(r.key);
      this.write(data);
      const attempt = r.attempts.at(-1)!;
      const command =
        action === "retry" ? definition.launch : definition[action];
      const result = await runCheck(
        command,
        this.cwd,
        Math.min(definition.timeoutSeconds * 1000, maxRuntimeMs),
        signal,
        { PI_MISSION_OPERATION: JSON.stringify(operationContext(r)) },
      );
      // Pause/stop/tree changes may release the lease. Never publish a late result.
      if (signal.aborted || !owns())
        throw new Error(
          "Operation interrupted; saved intent remains ambiguous. Reconcile before any retry.",
        );
      try {
        if (result.killed || result.code !== 0)
          throw new Error(
            `Adapter exited ${result.code}${result.killed ? " (cancelled/timed out)" : ""}: ${result.output}`,
          );
        if (result.stdoutTruncated)
          throw new Error("Adapter JSON exceeds 12000 characters");
        const response = JSON.parse(result.stdout || "");
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response) ||
          response.key !== r.key ||
          response.attemptId !== attempt.id
        )
          throw new Error(
            "Adapter response key/attemptId does not match the exact operation",
          );
        if (action === "launch" || action === "retry") {
          if (
            typeof response.operationId !== "string" ||
            !response.operationId.trim() ||
            response.operationId.length > 2000
          )
            throw new Error("Launch requires a nonempty operationId receipt");
          attempt.operationId = response.operationId;
          attempt.receipt = response.receipt;
          r.status = "pending";
        } else {
          if (
            attempt.operationId &&
            response.operationId !== attempt.operationId
          )
            throw new Error(
              "Adapter operationId mismatch; stale or unrelated result",
            );
          if (action === "reconcile") {
            if (
              !["unknown", "pending", "succeeded", "failed", "absent"].includes(
                response.status,
              )
            )
              throw new Error("Invalid reconciliation status");
            if (
              response.status === "absent" &&
              (attempt.operationId || response.operationId !== undefined)
            )
              throw new Error(
                "Known operation ID cannot be treated as authoritative absence",
              );
            if (
              ["pending", "succeeded", "failed"].includes(response.status) ||
              response.operationId !== undefined
            ) {
              if (
                typeof response.operationId !== "string" ||
                !response.operationId.trim() ||
                response.operationId.length > 2000
              )
                throw new Error(
                  "Reconciliation requires the exact operationId",
                );
              attempt.operationId = response.operationId;
            }
            if (response.receipt !== undefined)
              attempt.receipt = response.receipt;
            r.status = response.status;
            r.needsReconciliation = response.status === "unknown";
            r.reconciliation = { at: Date.now(), detail: response };
            if (!r.needsReconciliation) this.fresh.add(r.key);
          } else {
            if (
              response.status !== r.status ||
              (r.status === "absent" && response.operationId !== undefined) ||
              response.verified !== true ||
              typeof response.evidence !== "string" ||
              !response.evidence.trim()
            )
              throw new Error(
                "Verification must attest the reconciled outcome with verified=true and concrete evidence",
              );
            r.verification = {
              at: Date.now(),
              attemptId: attempt.id,
              detail: response,
            };
          }
        }
        attempt.result = `${action}: ${r.status}`;
        this.write(data);
        return structuredClone(r);
      } catch (error) {
        if (action === "launch" || action === "retry") r.status = "unknown";
        r.needsReconciliation = true;
        this.fresh.delete(r.key);
        attempt.result = String(error).slice(-12000);
        this.write(data);
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }
}
