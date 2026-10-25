# Security and safety

## Experimental status

Version 0.1.0 is an experimental workflow extension, not a sandbox, permission system, durable queue service, cost-control product, or audited security boundary. It runs with the privileges of the Pi process.

## Trust model

- Review mission definitions before starting them. Completion checks, startup checks, command probes, and operation launch/reconcile/verify adapters are **arbitrary shell code**, even if their descriptions say read-only.
- Those commands execute directly in the extension, bypassing other extensions' `tool_call` permission gates. The approval dialog lists them; `--yes` explicitly bypasses that dialog.
- Prompt constraints guide the model but do not restrict filesystem, credential, network, or account access. Other installed extensions also retain their own permissions.
- File-path validation is defensive, not protection against an attacker concurrently changing symlinks or using shell commands to access other locations.
- Workspace ownership is cooperative coordination. It prevents competing instances of this extension, not arbitrary processes, users, or direct API code from acting.
- Timeouts and pause/stop kill ordinary subprocess groups, not remote jobs or deliberately detached descendants.
- Omitted limits are disabled. There is **no enforced dollar/token budget** or remote quota/resource accounting. A model can continue generating billable requests indefinitely.
- Completion evidence is partly self-reported. Successful commands do not prove every semantic requirement or prevent a malicious model from modifying the checks. Preserve and independently review important artifacts.
- Files, command output, probes, and model responses can carry prompt injection. External output is data, not new authorization.

## Reduce exposure

Run unattended work in a restricted container/VM or dedicated account. Expose only needed project files, network services, and narrowly scoped credentials. Keep secrets out of mission reports, probe input, and verification output. Review changes before publishing or deploying.

Sessions, `PROGRESS.md`, adjacent `STATE.json`, `.pi/mission-operations.json`, and agent-directory checkpoint files can contain sensitive evidence, absolute paths, operation IDs, and logs. Do not commit or publicly share them without review. A live-looking checkpoint does not prove a process or job is alive.

Keep Pi/the host running for event-based resumption. Restore is paused after process/session replacement; reconcile exact external identities before explicit resume. Never infer that a local timeout means a remote write did not happen or a remote job was cancelled.

## Managed operation boundary

The workspace-wide operation ledger records launch intent before executing an approved adapter and survives mission session branches. It is not a remote transaction log: service-specific idempotency and authoritative reconciliation are still required. A crash/timeout is an ambiguous outcome, never evidence of cancellation or absence. Retry is opt-in and requires fresh authoritative absence without a known remote operation ID. Readiness does not prove success.

These gates apply only to `mission_operation`. Arbitrary shell tools, SDK calls, other workspaces, deleted/copied-away ledgers, or noncooperating processes can bypass them. Never delete or rewrite a ledger to force another launch. Adapter output echoes identity but is not independently trustworthy evidence; adapters must actually verify provenance and output properties. Agents can edit adapter files/tests unless separately isolated. Persisted adapter definitions are checked against current mission approval, but this is not protection against arbitrary local code execution.

The ledger uses atomic file replacement and fsync before launch, conditional on filesystem support and an intact local ledger. This is not a claim of external exactly-once execution, physical power-loss testing, or safe multi-machine concurrent operation. Verification results are observations, not immutable artifacts. Review the [operation protocol](docs/operations.md) before using valuable external resources.

## Reporting

For a vulnerability, use [GitHub private vulnerability reporting](https://github.com/kiote/pi-mission-mode/security/advisories/new). Do not include credentials or private session data in public issues. For ordinary bugs, use the issue tracker with a minimal synthetic mission and sanitized output.

Supported review target for this release: macOS/Linux, Node 22.19+, Pi coding agent 1.4.0. No formal security audit is claimed.
