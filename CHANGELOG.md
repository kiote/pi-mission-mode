# Changelog

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
