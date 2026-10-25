# pi-mission-mode

**Experimental goal-driven missions for [Pi](https://pi.dev).** Give Pi an outcome, acceptance criteria, and authority; let it work through multiple steps instead of repeatedly asking it to continue.

- A completion gate uses `agent_before_settle` to continue unfinished work with actionable feedback.
- Trusted verification commands check completion claims.
- File, command, and scheduled-time waits yield without model polling and resume when the event is ready.
- Progress checkpoints and significant-event digests survive in the Pi session and local files.
- Optional limits, cooperative workspace ownership, and explicit pause/resume support longer tasks.

> **Not a sandbox or an always-on service.** Commands run with Pi's permissions. Omitted limits are disabled, so work and provider charges can continue indefinitely. Read the [security model](SECURITY.md) before unattended use.

## Install

Requires **Node.js 22.19+**, **macOS or Linux**, `/bin/bash`, and a Pi version with settlement boundary hooks. Tested with **`@earendil-works/pi-coding-agent` 1.4.0**. Older Pi versions and Windows are not supported by this release.

```bash
pi install git:github.com/kiote/pi-mission-mode@v0.1.0
```

Restart Pi or run `/reload`. Installing does **not** start a mission.

This release is distributed through GitHub; an npm registry release is not implied. Pi supplies the host packages declared as peer dependencies; this extension has no bundled runtime dependencies.

### If you installed a manual copy

Do not load two copies of this extension. Pause/stop any active mission, exit its Pi process, and move the old manual extension directory outside Pi's auto-discovery directories before installing the package. Keep the backup and session history until recovery is verified. Do not replace/reload an actively running mission just to upgrade.

## Quick start

Start Pi **inside the project it should work on**:

```bash
cd /path/to/project
pi
```

Then:

```text
/mission init
```

Edit the generated `mission.json`. Define a specific goal, observable success criteria, constraints, and appropriate verification commands. Placeholder missions cannot start. For example:

```json
{
  "goal": "Write docs/architecture.md for a new contributor",
  "acceptance": [
    "The guide identifies actual entry points and component relationships with file references",
    "The guide explains how to run the relevant tests and labels uncertainty"
  ],
  "constraints": [
    "Only edit docs/architecture.md; do not publish or discard unrelated work"
  ],
  "progressFile": ".pi/architecture-mission/PROGRESS.md",
  "checks": ["test -s docs/architecture.md"]
}
```

```text
/mission start mission.json
```

Review the approval dialog: **startup, completion, and probe commands are executable code**. A nonempty-file check alone does not prove the guide is accurate; choose checks that meaningfully test your goal.

Examples: [document a repository](examples/document-repository.json), [wait for an external job](examples/external-job.json), and its [local example probe](examples/probe-job.mjs). Copy/adapt the example and any referenced script into the target workspace before use; example command paths are relative to that workspace, not the installed package.

## Controls and progress

| Command                       | Behaviour                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `/mission init [file]`        | Create an inert template; never overwrite an existing file                    |
| `/mission start <file>`       | Review and start a mission while Pi is idle                                   |
| `/mission start --yes <file>` | Explicitly bypass approval; required for non-interactive start                |
| `/mission status`             | Show state, evidence, counters, wait condition, and progress/checkpoint paths |
| `/mission check`              | Observe an active external wait once, without model polling                   |
| `/mission pause`              | Pause running/startup/waiting work and cancel owned local probes/checks       |
| `/mission resume`             | Explicitly resume a paused/blocked mission in its original workspace          |
| `/mission stop`               | Stop this mission; a new start is required to run again                       |

**Escape pauses**, including when Pi is idle waiting for an external event. A new ordinary user prompt also pauses external waiting so autonomous work cannot unexpectedly resume into that conversation. Status/check commands do not interrupt the wait.

Watch the Pi transcript for full tool activity. `mission_report` checkpoints update generated `PROGRESS.md` and adjacent `STATE.json`; significant reports also display a digest. Lifecycle changes and ready events produce digests, but pending polls do not.

```bash
# Use the progress path shown by /mission status.
tail -F .pi/architecture-mission/PROGRESS.md
```

Use `tail -F`, not `tail -f`: progress files are atomically replaced. Generated files are not for hand editing and may contain sensitive reports, evidence, and check output. A checkpoint timestamp is **not proof that Pi or a remote job is still alive**.

## Mission protocol

```text
RUNNING ── incomplete ──────────────> continue with feedback
   │
   ├── external dependency ──> WAITING ── event ready ──> RUNNING
   ├── reported completion + checks pass ──────────────> COMPLETED
   ├── no checks configured ──────────────────────────> REVIEW_REQUIRED
   ├── genuine reported blocker/provider error ──────> BLOCKED
   └── explicit pause/stop or configured ceiling ─────> pause/stop
```

The agent uses `mission_report` with `progress`, `complete`, or `blocked`:

- Completion needs evidence for every **1-based** acceptance criterion.
- Any later tool call invalidates a complete report.
- The extension runs configured checks sequentially; actual failures feed another turn.
- `significant: true` adds a digest; `nextAction` records the follow-up plan.
- No checks means human review, **not automatic success**.

Checks execute independently of the agent's claim, but acceptance evidence is still self-reported. Tests passing is not a guarantee of semantic correctness, evaluation integrity, or the actual business outcome.

## Waiting without model polling

Add named conditions to the mission:

```json
{
  "waiters": [
    {
      "id": "job",
      "kind": "command",
      "command": "node scripts/probe-job.mjs",
      "intervalSeconds": 60,
      "timeoutSeconds": 30,
      "maxErrors": 3
    },
    { "id": "scheduled", "kind": "time" }
  ]
}
```

These fields extend a complete mission definition. Only configured conditions can be used. The agent calls:

```text
mission_wait({
  conditionId: "job",
  input: {jobId: "exact-operation-123"},
  summary: "Collect operation-123, verify its artifacts, then evaluate the next step"
})
```

It finishes its response without more tools. The runtime saves `waiting`, yields, and runs bounded observations without calling the model:

- Command input arrives as JSON in **`PI_MISSION_WAIT_INPUT`**, not shell interpolation.
- Exit **0 = ready**, **75 = pending**, other exits/timeouts = diagnosis errors.
- A remote failure can be a ready event to diagnose; it is not permission to launch again.
- File conditions test existence or a dotted JSON value within the workspace.
- Time conditions use `input.until` as an ISO timestamp.

On readiness, the wait is consumed and checkpointed **before** one follow-up resumes the model. Missed timer ticks after host sleep are not replayed as a burst. Use **interactive Pi or a long-lived RPC host**: `mission_wait` rejects one-shot print/JSON mode, which exits at settlement.

## Boundaries are mission-specific

**All five numeric limits default to `null` (disabled).** No hidden hour, turn, continuation, no-progress, or verification ceiling is imposed. Explicit positive integers enable limits:

- `maxMinutes`: running wall time, including blocking tools; excludes explicit `WAITING` and `PAUSED` time.
- `maxTurns`: all model turns, including long tool-calling loops.
- `maxContinuations`: settlement continuations and external-event resumptions.
- `maxConsecutiveNoProgress`: optional heuristic threshold, not proof of a blocker.
- `checkTimeoutSeconds`: optional default timeout for verification/startup commands.

`policies.noProgress` defaults to **`reassess`**, not stop. Explicit `pause` or `stop` policies are available. Changing command output can fool the progress heuristic. A configured `maxTurns` is strict and can stop the response that was about to finish.

Checks can override the default timeout individually. An explicit `null` means no command timeout, while a configured mission runtime ceiling still applies to completion checks. Startup checks use their own/default command timeout. Pause/stop still cancel a check with no timeout. Numeric budgets are cumulative across pause/resume.

Probe intervals/timeouts/error counts are separate operational settings, not mission-duration ceilings. **There is no dollar/token spending cap or domain-resource accounting.** Use application-specific quota/approval controls and isolation when needed.

Full field reference and defaults: [mission format](docs/mission-format.md).

## Ownership, recovery, and limits of autonomy

A cooperative claim at `.pi/mission-owner.json` prevents two mission instances from owning the same workspace. Starting/running/waiting retains it; pausing or finishing releases it. A live/reused PID is not stolen. Dead-PID claims can be recovered; a crash during the short `.guard` transaction fails closed and requires inspecting/removing only a verified stale guard.

Session branch entries are authoritative. Global advisory snapshots also live under `~/.pi/agent/mission-checkpoints/` (or `PI_CODING_AGENT_DIR`). Different branches of one mission share that advisory filename. A foreign workspace/branch must not overwrite a live owner's progress.

**Reopening, reloading, or navigating a running/waiting/starting session restores it paused.** Explicit resume reruns startup reconciliation and rearms a saved wait instead of blindly repeating a launch/upload. If Pi crashes after consuming an event but before model delivery, recovery is paused, not an automatic replay.

Keep the Mac/Linux host awake and Pi alive. This package is not a daemon, does not restart Pi after exit, and does not promise exact-once semantics for arbitrary external services. Domain adapters must retain exact operation IDs, reconcile ambiguous responses, and implement once-only write receipts. Manual pause does not mean remote work was cancelled.

## Development

```bash
git clone https://github.com/kiote/pi-mission-mode.git
cd pi-mission-mode
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

Tests use temporary workspaces and fake provider streams, including the real Pi session/package loader and automatic wait/wake loop. They do not require personal credentials or a managed Pi installation. CI covers Node 22/24 on macOS/Linux. This is not proof of multi-week reliability or every physical sleep/reboot scenario.

The project uses documented Pi extension APIs; SDK tests pin Pi 1.4.0. Host-provided packages are peer dependencies, never bundled into the runtime package. No project-specific adapters or live mission data are included.

[MIT license](LICENSE) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)
