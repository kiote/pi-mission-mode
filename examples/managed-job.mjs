// Local demonstration adapter, NOT a production remote-service adapter.
// Copy this file into the target workspace's scripts/ directory.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const operation = JSON.parse(process.env.PI_MISSION_OPERATION || "{}");
const { key, attemptId, idempotencyKey } = operation;
if (!key || !attemptId || !idempotencyKey)
  throw new Error("Missing managed identity");
const dir = join(".pi", "demo-jobs");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${idempotencyKey}.json`);
const read = () => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};
const identity = { key, attemptId };
const digest = (job) =>
  createHash("sha256").update(JSON.stringify(job.result)).digest("hex");
const matching = (job) => {
  if (
    !job ||
    job.key !== key ||
    job.attemptId !== attemptId ||
    job.idempotencyKey !== idempotencyKey ||
    (operation.operationId && operation.operationId !== job.operationId)
  )
    throw new Error("Job identity/provenance mismatch");
};
const action = process.argv[2];
if (action === "launch") {
  let job = read();
  if (!job) {
    job = {
      ...identity,
      idempotencyKey,
      operationId: `local-${idempotencyKey}`,
      status: "succeeded",
      result: { value: operation.input.value ?? 42 },
    };
    job.sha256 = digest(job);
    // Exclusive create illustrates idempotency only for this local single-writer demo.
    writeFileSync(file, JSON.stringify(job), { flag: "wx", mode: 0o600 });
  }
  matching(job);
  console.log(
    JSON.stringify({
      ...identity,
      operationId: job.operationId,
      receipt: { file },
    }),
  );
} else if (
  action === "reconcile" ||
  action === "probe" ||
  action === "verify"
) {
  const job = read();
  if (!job && action === "reconcile") {
    console.log(JSON.stringify({ ...identity, status: "absent" }));
  } else if (!job && action === "probe") {
    process.exitCode = 75;
  } else {
    matching(job);
    if (action === "probe") {
      console.log(JSON.stringify({ ...identity, status: job.status }));
      if (!["succeeded", "failed"].includes(job.status)) process.exitCode = 75;
    } else if (action === "reconcile") {
      console.log(
        JSON.stringify({
          ...identity,
          operationId: job.operationId,
          status: job.status,
        }),
      );
    } else {
      if (
        job.status !== operation.status ||
        !["succeeded", "failed"].includes(job.status) ||
        job.sha256 !== digest(job)
      )
        throw new Error("Artifact hash or reconciled outcome mismatch");
      if (
        job.status === "succeeded" &&
        job.result.value !== (operation.input.value ?? 42)
      )
        throw new Error(
          "Artifact does not meet the requested operation result",
        );
      console.log(
        JSON.stringify({
          ...identity,
          operationId: job.operationId,
          status: job.status,
          verified: true,
          evidence:
            "Exact job identity, terminal outcome, result value, and SHA-256 checked",
          artifacts: [{ path: file, sha256: job.sha256 }],
        }),
      );
    }
  }
} else throw new Error("Expected launch, reconcile, probe, or verify");
