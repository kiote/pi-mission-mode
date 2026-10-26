# Changelog

## Unreleased

- Windows (experimental): mission checks no longer fail with `spawn /bin/bash ENOENT`. They use `PI_MISSION_BASH` or Git for Windows bash, put its directory first on `PATH`, and stop timed-out checks with `taskkill /T`.
- Optional managed operation adapters and `mission_operation` inspect/launch/reconcile/verify/retry tool.
- Workspace-wide fsynced write-ahead operation ledger, stable idempotency identities, immutable inputs, saved receipts, and per-attempt history that session branches cannot undo.
- Fail-closed reconciliation and identity checks; retry only with adapter opt-in and fresh authoritative absence without a known remote ID.
- Operation-bound waits persist readiness separately from success; completion requires verified terminal outcomes and rechecks operation artifacts after mission checks.
- Failed external outcomes may be verified as failed without implying overall mission success. Recovery/pause invalidates reconciliation freshness.
- Fixed failed external-event delivery leaving a running mission/ownership claim after its wait was consumed.
- Added adapter/recovery documentation, a local identity/hash-checked job example, real Pi managed-lifecycle integration, and failure-window tests including actual host SIGKILL before/after external effects.

## 0.1.0 — experimental initial release

- Goal/acceptance/authority mission definitions and `/mission` controls.
- Settlement-based continuation with trusted completion verification.
- Command, file, and scheduled-time waiting without model polling.
- Significant-event digests, generated progress/state files, and branch-aware session checkpoints.
- Cooperative workspace ownership and paused restoration with explicit reconciliation/resume.
- Optional mission-specific ceilings; omitted/null limits are disabled. Default no-progress action is reassessment, not termination.
- No bundled runtime dependencies; host packages are Pi-provided peers.
- Portable tests, real Pi SDK/package-loader integration with fake model streams, generic examples, and macOS/Linux CI configuration.
- Release hardening: approval lists all executable command classes; restored foreign workspaces cannot publish progress; ownership paths reject workspace-escaping symlinks; invalid saved IDs are rejected before checkpoint path construction.

This release is not a sandbox, spending cap, always-on daemon, or guarantee of external exactly-once execution. No project-specific adapters, private mission configurations, or live session data are included.
