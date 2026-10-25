# Managed external operations

Use managed operations for **investigate → launch → wait → reconcile → verify → continue** workflows. They are optional; existing missions without `operations` continue to work.

This is a write-ahead controller for trusted adapters, not a generic remote transaction service. It does not discover arbitrary Bash/API launches, provide a sandbox, or guarantee exactly-once execution on an external service.

## Configure an adapter

Add to a complete mission definition:

```json
{
  "operations": [
    {
      "id": "training",
      "launch": "node scripts/training.mjs launch",
      "reconcile": "node scripts/training.mjs reconcile",
      "verify": "node scripts/training.mjs verify",
      "timeoutSeconds": 30,
      "retryAfterAbsent": false
    }
  ],
  "waiters": [
    {
      "id": "training-ready",
      "kind": "command",
      "command": "node scripts/training.mjs probe",
      "intervalSeconds": 60,
      "timeoutSeconds": 30
    }
  ]
}
```

All three operation commands are required and appear in startup approval. `timeoutSeconds` defaults to 30 and must be a positive safe integer; a remaining running-mission deadline also bounds the command. `retryAfterAbsent` defaults to false. Unknown fields and duplicate adapter IDs are rejected. Adapter commands run as trusted shell code with Pi's environment and permissions, bypassing tool-call permission hooks. Reconcile/verify/probe commands must be read-only by contract; this is not OS-enforced.

## Tools and lifecycle

```text
mission_operation({action:"inspect"})
mission_operation({action:"launch", operation:"training", key:"project/run-v3", input:{dataset:"v3"}})
mission_wait({conditionId:"training-ready", operationKey:"project/run-v3", input:{}, summary:"Inspect exact run, reconcile outcome, verify artifacts"})
mission_operation({action:"reconcile", key:"project/run-v3"})
mission_operation({action:"verify", key:"project/run-v3"})
```

Then decide whether to investigate further, launch genuinely new work under a new business key, or report completion. `mission_wait` requires a long-lived interactive/RPC host. Existing unbound file/time/command waits are still available.

- `key` is a stable business identity, **not a newly generated value per tool call**. It is unique across adapters/missions in the same workspace. Allowed characters: letters, digits, `_`, `.`, `:`, `/`, `-`; 1–200 characters. Do not change a key to evade duplicate detection.
- `input` is required for launch, immutable thereafter, and limited to 20,000 JSON characters. Omit it on reconcile/verify/retry.
- `operation` selects an approved adapter on launch. Later actions can infer it from the record, but the current mission must still approve the same adapter contract.
- `inspect` reads the entire workspace ledger, or one record with `key`. It performs no external action.
- Duplicate launch never runs the launch command. Any unresolved `launching`/`unknown` record also prevents a new launch under a different key until reconciled.
- A successful launch records a remote `operationId` and optional receipt, but does **not** establish success. A crash can leave `launching`; treat it as an unknown outcome, not a live-process claim.
- A bound wait requires a known operation ID associated with the current mission. If the receipt was lost, reconcile first. The command probe receives the exact ledger context rather than trusting an ID invented in wait input.
- Readiness is saved separately from remote status. It invalidates previous verification and never means remote success or permission to launch again.
- Verify requires fresh terminal reconciliation (`succeeded`, `failed`, or `absent`). `unknown` and `pending` cannot be verified as finished.
- All associated managed operations must have verified terminal outcomes before mission completion. A failed outcome can be **verified as failed**; mission acceptance criteria/checks still decide whether the overall mission succeeded.
- Completion reruns the approved operation verifiers **after** the mission's completion commands, catching artifacts changed since earlier verification. A failure feeds another model turn and requires reconciliation again. Verification is a point-in-time observation, not immutable storage.

## Adapter protocol

Each command receives JSON in `PI_MISSION_OPERATION`, without shell interpolation:

```json
{
  "key": "project/run-v3",
  "input": { "dataset": "v3" },
  "idempotencyKey": "stable-generated-uuid",
  "attemptId": "current-attempt-uuid",
  "operationId": "remote-job-123",
  "receipt": { "account": "research" },
  "status": "pending"
}
```

`operationId`/`receipt` are omitted until known. The idempotency key stays stable across an explicitly permitted retry; each attempt gets a new attempt ID. Adapters must pass the idempotency key to the service where supported and reconcile by that exact identity if no receipt was saved.

Commands exit 0 and write **one JSON object to stdout**. Logs belong on stderr. Stdout is capped at 12,000 characters; truncated, malformed, nonzero-exit, timed-out, or mismatched responses are not accepted. Output is untrusted data, not new mission authority.

Every response must echo the exact `key` and current `attemptId`. Once known, the remote operation ID must match on reconciliation and verification.

### Launch

```json
{
  "key": "project/run-v3",
  "attemptId": "current-attempt-uuid",
  "operationId": "remote-job-123",
  "receipt": { "account": "research" }
}
```

Intent is persisted **before** executing this command. Any launch error, missing receipt, cancellation, or timeout is ambiguous: the service may already have acted. Local process cancellation does not cancel remote work.

### Reconcile

```json
{
  "key": "project/run-v3",
  "attemptId": "current-attempt-uuid",
  "operationId": "remote-job-123",
  "status": "succeeded"
}
```

Valid statuses: `unknown`, `pending`, `succeeded`, `failed`, `absent`. Pending/succeeded/failed require a nonempty remote operation ID. Unknown may include an ID if one is known. Absence cannot include an operation ID and is rejected if any ID was already recorded for this attempt.

**`absent` means an authoritative determination that the external write did not happen**, not an empty eventually consistent search result, missing local file, HTTP timeout, or unavailable credentials. Use `unknown` if this cannot be established safely.

After pause, resume, reload, branch navigation, or external waiting, persisted reconciliation alone is insufficient: the active runtime requires a fresh reconciliation before verification/retry/completion. Adapter failure also invalidates freshness. Reconcile can explicitly associate a record from an earlier mission with the current mission; it cannot change its input or adapter contract.

### Verify

```json
{
  "key": "project/run-v3",
  "attemptId": "current-attempt-uuid",
  "operationId": "remote-job-123",
  "status": "succeeded",
  "verified": true,
  "evidence": "Checked account, exact job receipt, artifact provenance, checksum, and requested output",
  "artifacts": [{ "path": "results/run-v3.json", "sha256": "actual-digest" }]
}
```

The response must attest the reconciled status, set `verified: true`, and include nonempty evidence. Artifacts and other extra fields are retained as evidence; **the adapter is responsible for actually validating provenance, hashes, and goal-specific properties**. The controller validates response identity/outcome, not the truth of arbitrary evidence text or artifact metadata. Side-effect-only operations may have no artifacts. Verifying authoritative absence omits `operationId` and must supply evidence of that absence.

A verifier should independently read the result and bind account/project, remote job/version, artifact identity, and requested properties. Do not accept "latest job", "file exists", or self-reported model prose as adequate proof. Use independent/immutable checks for valuable outcomes; the agent can still edit workspace scripts and artifacts.

### Probe

A command wait with `operationKey` receives the same `PI_MISSION_OPERATION` context plus legacy `PI_MISSION_WAIT_INPUT`. Exit 0 means ready to inspect (including remote failure), 75 pending, and other exits/timeouts diagnosis errors. File/time waits do not automatically validate operation provenance; reconciliation and verification remain mandatory.

## Retry gate

```text
mission_operation({action:"retry", key:"project/run-v3"})
```

Requires **all** of:

1. The approved adapter opts into `retryAfterAbsent: true`.
2. Fresh successful reconciliation says `absent`.
3. No remote operation ID is known for this attempt.

A failed job is not absent. Timeout is not absence. Changing a business key is not a legitimate retry. Retrying first saves a new attempt intent, preserves prior attempt history, and retains the stable idempotency key. Once a service has allocated an ID, further remediation is domain-specific new work, not a generic retry.

## Persistence and recovery

`.pi/mission-operations.json` is a separate workspace-wide authority for external actions. Atomic writes fsync the temporary file, rename it, and fsync its parent directory before launch. A persistence failure prevents launch. Session branches and new missions cannot erase existing operation keys; an operation's adapter definition is stored with the record and checked against the current approval.

Keep this file outside source control and retain/back it up for recovery. **Never delete/edit it to force a retry.** It contains sensitive inputs, receipts, IDs, and outputs. Its guarantees depend on an intact local filesystem, cooperative workspace ownership, and using this managed tool. Copying a workspace without its ledger, launching in a different workspace, arbitrary direct API calls, or deleting the ledger can bypass deduplication. Remote services still need idempotency/reconciliation support.

Recovery behavior:

| Failure window                               | Behavior                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Intent saved, adapter never acts             | Recorded ambiguous attempt; reconcile; only authoritative absence can unlock an opted-in retry |
| Service acts, receipt not saved              | Reconcile using stable idempotency identity; recover remote ID; never relaunch blindly         |
| Wait ready saved, model wake not delivered   | Restore paused; readiness/identity remain in ledger; explicit resume, no automatic wake replay |
| Local pause/timeout while adapter runs       | Kill owned local subprocess group; preserve intent; no remote cancellation assumption          |
| Old subprocess finishes after ownership lost | Refuse to publish its late result                                                              |
| Verification saved, then artifacts change    | Completion rechecks operation artifacts with the approved verifier                             |

The tests exercise actual host `SIGKILL` before/after simulated external effects, interrupted local launches, lost receipts, failed wake delivery, stale IDs/artifacts, branch/new-mission recovery, and the real Pi package loader with fake model streams. They do not demonstrate arbitrary remote-service exactly-once behavior or multi-week reliability.

## Runnable local example

Copy `examples/managed-job.mjs` into `scripts/managed-job.mjs` in a disposable workspace, copy `examples/managed-job.json` there, start Pi in that workspace, and run:

```text
/mission start managed-job.json
```

The demo creates a local job artifact, checks its exact identity/value/SHA-256, and uses a command wait. It runs immediately rather than scheduling real remote work. Its exclusive file create is a local demonstration, not a production remote-service implementation.
