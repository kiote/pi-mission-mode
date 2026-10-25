import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  definition,
  harness,
  stateModule as s,
  runtimeModule as r,
  probeWait,
} from "./helpers.mjs";

const mission = (extra = {}) =>
  definition({
    limits: {},
    progressFile: "progress/PROGRESS.md",
    waiters: [
      {
        id: "job",
        kind: "file",
        path: "result.json",
        jsonPath: "state",
        equals: "DONE",
        intervalSeconds: 60,
      },
    ],
    ...extra,
  });
async function yieldJob(h) {
  await h.wait({
    conditionId: "job",
    input: { jobId: "external-123" },
    summary: "Collect external-123 and decide the next step",
  });
  assert.equal((await h.settle()).continue, false);
  await h.emit("agent_settled", { aborted: false });
}

test("waiting yields without model requests and consumes a ready event exactly once", async (t) => {
  const h = await harness(t);
  await h.start(mission());
  await yieldJob(h);
  assert.equal(h.latest().status, "waiting");
  const prompts = h.prompts.length;
  await h.command("check");
  assert.equal(h.prompts.length, prompts);
  assert.equal(h.latest().status, "waiting");
  writeFileSync(join(h.dir, "result.json"), JSON.stringify({ state: "DONE" }));
  await h.command("check");
  assert.equal(h.latest().status, "running");
  const wakes = h.messages.filter((m) => m.customType === "mission-feedback");
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].content, /external-123/);
  await h.command("check");
  assert.equal(
    h.messages.filter((m) => m.customType === "mission-feedback").length,
    1,
  );
});

test("pause while idle waiting prevents wakeup and releases workspace ownership", async (t) => {
  const h = await harness(t);
  await h.start(mission());
  await yieldJob(h);
  assert.equal(existsSync(join(h.dir, ".pi/mission-owner.json")), true);
  await h.command("pause");
  writeFileSync(join(h.dir, "result.json"), JSON.stringify({ state: "DONE" }));
  await h.command("check");
  assert.equal(h.latest().status, "paused");
  assert.equal(
    h.messages.some((m) => m.customType === "mission-feedback"),
    false,
  );
  assert.equal(existsSync(join(h.dir, ".pi/mission-owner.json")), false);
});

test("Escape pauses idle interactive waiting without requiring an active model run", async (t) => {
  const h = await harness(t, { mode: "tui" });
  await h.start(mission());
  await yieldJob(h);
  assert.equal(h.terminal("\u001b").consume, true);
  assert.equal(h.latest().status, "paused");
  assert.equal(existsSync(join(h.dir, ".pi/mission-owner.json")), false);
});

test("waiting time is excluded from the configured running budget", () => {
  const state = s.createState(
    s.parseMission(mission({ limits: { maxMinutes: 1 } })),
    "f",
    "w",
    1000,
  );
  s.transition(state, "waiting", "job", 5000);
  assert.equal(s.remaining(state, 10000000), 56000);
  s.transition(state, "running", "event", 10000000);
  assert.equal(s.remaining(state, 10001000), 55000);
});

test("restoring a waiting mission is paused; explicit resume rearms its exact saved dependency", async (t) => {
  const a = await harness(t);
  await a.start(mission());
  await yieldJob(a);
  const entries = structuredClone(a.entries);
  await a.command("pause");
  const b = await harness(t, { entries, cwd: a.ctx.cwd });
  b.ctx.mode = "rpc";
  assert.equal(b.latest().status, "paused");
  assert.equal(b.prompts.length, 0);
  assert.equal(b.latest().wait.input.jobId, "external-123");
  await b.command("resume");
  assert.equal(b.latest().status, "waiting");
  assert.equal(b.prompts.length, 0);
  writeFileSync(join(a.dir, "result.json"), JSON.stringify({ state: "DONE" }));
  await b.command("check");
  assert.equal(b.latest().status, "running");
  assert.equal(
    b.messages.filter((m) => m.customType === "mission-feedback").length,
    1,
  );
});

test("another live session cannot steal ownership or overwrite its progress file", async (t) => {
  const a = await harness(t);
  await a.start(mission());
  const before = readFileSync(join(a.dir, "progress/STATE.json"), "utf8");
  const b = await harness(t, { entries: a.entries, cwd: a.ctx.cwd });
  await b.command("resume");
  assert.equal(b.latest().status, "paused");
  assert.match(b.messages.at(-1).content, /already owned/);
  assert.equal(
    readFileSync(join(a.dir, "progress/STATE.json"), "utf8"),
    before,
  );
  await a.command("pause");
  await b.command("resume");
  assert.equal(b.latest().status, "running");
});

test("dead-PID claim is recovered, while an incomplete claim guard fails closed", async (t) => {
  const h = await harness(t);
  mkdirSync(join(h.dir, ".pi"), { recursive: true });
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  writeFileSync(
    join(h.dir, ".pi/mission-owner.json"),
    JSON.stringify({ pid: exited.pid, token: "old", missionId: "crashed" }),
  );
  const lease = new r.WorkspaceLease(h.dir);
  lease.acquire("recovered");
  assert.equal(lease.owns(), true);
  lease.release();
  mkdirSync(lease.guard);
  assert.throws(
    () => lease.acquire("no-stealing"),
    /Ownership change is locked/,
  );
});

test("command probes distinguish pending/ready/error, receive JSON input safely, and pause on bounded errors", async (t) => {
  const h = await harness(t);
  await h.start(
    mission({
      waiters: [
        {
          id: "job",
          kind: "command",
          command: "printf '%s' \"$PI_MISSION_WAIT_INPUT\"; exit 75",
          intervalSeconds: 60,
          timeoutSeconds: 1,
        },
      ],
    }),
  );
  await yieldJob(h);
  await h.command("check");
  assert.equal(h.latest().status, "waiting");
  const snapshot = JSON.parse(
    readFileSync(join(h.dir, "progress/STATE.json"), "utf8"),
  );
  assert.match(snapshot.wait.lastObservation, /external-123/);
  await h.command("stop");
  const errorMission = mission({
    waiters: [
      {
        id: "job",
        kind: "command",
        command: "printf identity-mismatch; exit 2",
        intervalSeconds: 60,
        timeoutSeconds: 1,
      },
    ],
  });
  await h.start(errorMission);
  await yieldJob(h);
  await h.command("check");
  assert.equal(h.latest().status, "paused");
  assert.match(h.latest().reason, /identity-mismatch/);
  assert.equal(
    h.messages.some((m) => m.customType === "mission-feedback"),
    false,
  );
});

test("pausing during a probe cancels it, and late results never restart the mission", async (t) => {
  const h = await harness(t);
  await h.start(
    mission({
      waiters: [
        {
          id: "job",
          kind: "command",
          command: "sleep 10; exit 0",
          timeoutSeconds: 20,
          intervalSeconds: 60,
        },
      ],
    }),
  );
  await yieldJob(h);
  const pending = h.command("check");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.command("pause");
  await pending;
  assert.equal(h.latest().status, "paused");
  assert.equal(
    h.messages.some((m) => m.customType === "mission-feedback"),
    false,
  );
});

test("time waits and explicit wait deadlines are deterministic, not guesses about remote cancellation", async (t) => {
  const h = await harness(t);
  const condition = s.parseMission(
    mission({ waiters: [{ id: "clock", kind: "time" }] }),
  ).waiters[0];
  const wait = {
    conditionId: "clock",
    input: { until: new Date(Date.now() + 100000).toISOString() },
    summary: "scheduled",
    startedAt: Date.now(),
    errors: 0,
  };
  assert.equal(
    (await probeWait(condition, wait, h.dir, new AbortController().signal))
      .status,
    "pending",
  );
  wait.input.until = new Date(Date.now() - 10).toISOString();
  assert.equal(
    (await probeWait(condition, wait, h.dir, new AbortController().signal))
      .status,
    "ready",
  );
  condition.maxWaitSeconds = 1;
  wait.startedAt -= 10000;
  const expired = await probeWait(
    condition,
    wait,
    h.dir,
    new AbortController().signal,
  );
  assert.equal(expired.status, "error");
  assert.match(expired.detail, /NOT assumed cancelled/);
});

test("unknown wait conditions, one-shot mode, path escapes, and invalid schemas are rejected", async (t) => {
  const h = await harness(t);
  await h.start(mission());
  await assert.rejects(
    () => h.wait({ conditionId: "not-approved", input: {}, summary: "bad" }),
    /Unknown wait/,
  );
  await assert.rejects(
    () =>
      h.wait(
        { conditionId: "job", input: {}, summary: "not persistent" },
        "json",
      ),
    /one-shot modes/,
  );
  for (const waiters of [
    [{ id: "a", kind: "command" }],
    [
      { id: "a", kind: "file", path: "x" },
      { id: "a", kind: "time" },
    ],
    [{ id: "a", kind: "invalid" }],
  ])
    assert.throws(() => s.parseMission(mission({ waiters })));
  assert.throws(() => r.workspacePath(h.dir, "../outside"), /escapes/);
  symlinkSync("/tmp", join(h.dir, "outside-link"));
  assert.throws(
    () => r.workspacePath(h.dir, "outside-link/future.json"),
    /escapes/,
  );
});

test("significant reports write digests; routine checkpoints update progress without extra digest events", async (t) => {
  const h = await harness(t);
  await h.start(mission());
  const initial = h.latest().digests.length;
  await h.report({
    status: "progress",
    summary: "Routine checkpoint",
    evidence: [],
  });
  assert.equal(h.latest().digests.length, initial);
  await h.report({
    status: "progress",
    summary: "Official score improved to 0.31",
    nextAction: "Analyze failure clusters",
    evidence: [],
    significant: true,
  });
  assert.equal(h.latest().digests.length, initial + 1);
  assert.match(
    readFileSync(join(h.dir, "progress/PROGRESS.md"), "utf8"),
    /0\.31/,
  );
  assert.ok(h.messages.some((m) => /Mission digest:/.test(m.content)));
});

test("failed startup reconciliation pauses before any model prompt or autonomous action", async (t) => {
  const h = await harness(t);
  await h.start(
    mission({
      startupChecks: [
        { command: "printf old-writer-active; exit 1", timeoutSeconds: 1 },
      ],
    }),
  );
  assert.equal(h.latest().status, "paused");
  assert.equal(h.prompts.length, 0);
  assert.match(h.latest().reason, /old-writer-active/);
  assert.equal(existsSync(join(h.dir, ".pi/mission-owner.json")), false);
});
