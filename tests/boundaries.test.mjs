import test from "node:test";
import assert from "node:assert/strict";
import { definition, harness, stateModule as s, runCheck } from "./helpers.mjs";

const unlimited = (overrides = {}) => definition({ limits: {}, ...overrides });

test("omitted limits and explicit null disable ceilings instead of imposing hidden defaults", () => {
  const a = s.parseMission(unlimited());
  assert.deepEqual(a.limits, {
    maxMinutes: null,
    maxTurns: null,
    maxContinuations: null,
    maxConsecutiveNoProgress: null,
    checkTimeoutSeconds: null,
  });
  assert.equal(a.policies.noProgress, "reassess");
  const b = s.parseMission(
    definition({
      limits: {
        maxMinutes: null,
        maxTurns: null,
        maxContinuations: null,
        checkTimeoutSeconds: null,
      },
    }),
  );
  const state = s.createState(b, "f", "w");
  state.usedMs = 60 * 60 * 1000 * 500;
  state.turns = 20000;
  state.continuations = 20000;
  assert.equal(s.remaining(state), Infinity);
  assert.equal(s.limitReason(state), undefined);
  assert.equal(s.continuationLimitReached(state), false);
  assert.equal(s.checkTimeoutMs(a, a.checks[0]), Infinity);
  assert.match(s.unboundedWarning(a), /ongoing provider charges/);
});

test("large mission-specific limits are accepted without arbitrary day/hour/turn caps", () => {
  const m = s.parseMission(
    definition({
      limits: {
        maxMinutes: 100000,
        maxTurns: 1000000,
        maxContinuations: 100000,
        checkTimeoutSeconds: 172800,
      },
    }),
  );
  assert.equal(m.limits.maxMinutes, 100000);
  assert.equal(m.limits.checkTimeoutSeconds, 172800);
  for (const limit of [-1, 0, 1.1, "60", Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() =>
      s.parseMission(definition({ limits: { maxMinutes: limit } })),
    );
  }
});

test("per-check timeouts override the optional global timeout, with null disabling inheritance", () => {
  const m = s.parseMission(
    definition({
      limits: { checkTimeoutSeconds: 10 },
      checks: [
        "printf inherited",
        { command: "printf long", timeoutSeconds: 7200 },
        { command: "printf unlimited", timeoutSeconds: null },
      ],
    }),
  );
  assert.equal(s.checkTimeoutMs(m, m.checks[0]), 10000);
  assert.equal(s.checkTimeoutMs(m, m.checks[1]), 7200000);
  assert.equal(s.checkTimeoutMs(m, m.checks[2]), Infinity);
  // Stored normalized definitions are valid inputs on reload, including legacy string checks.
  assert.deepEqual(s.parseMission(m), m);
  for (const checks of [
    [{ command: "true", timeoutSeconds: 0 }],
    [{ command: "true", typo: 1 }],
    [{ command: " " }],
  ]) {
    assert.throws(() => s.parseMission(definition({ checks })));
  }
  assert.throws(() =>
    s.parseMission(definition({ policies: { noProgress: "guess" } })),
  );
  assert.throws(() =>
    s.parseMission(definition({ policies: { noProgressTypo: "pause" } })),
  );
});

test("uncapped mission passes old 200-turn/12-continuation/3-cycle defaults and displays a warning", async (t) => {
  const h = await harness(t);
  await h.start(unlimited());
  assert.ok(
    h.messages.some((m) =>
      /No runtime, turn, or continuation ceiling/.test(m.content),
    ),
  );
  for (let i = 0; i < 205; i++)
    await h.emit("turn_end", { outcome: "completed" });
  for (let i = 0; i < 15; i++) assert.equal((await h.settle()).continue, true);
  assert.equal(h.latest().status, "running");
  assert.equal(h.latest().turns, 205);
  assert.equal(h.latest().continuations, 15);
  await h.command("status");
  assert.match(h.messages.at(-1).content, /unlimited/);
  assert.doesNotMatch(h.messages.at(-1).content, /Infinity|\/null/);
});

test("configured no-progress threshold reassesses by default, without falsely declaring a blocker", async (t) => {
  const h = await harness(t);
  await h.start(unlimited({ limits: { maxConsecutiveNoProgress: 2 } }));
  assert.doesNotMatch((await h.settle()).entries.at(-1).content, /REASSESS:/);
  const second = await h.settle();
  assert.equal(second.continue, true);
  assert.match(second.entries.at(-1).content, /REASSESS:/);
  assert.equal(h.latest().status, "running");
  await h.settle();
  assert.match((await h.settle()).entries.at(-1).content, /REASSESS:/);
});

test("no-progress stop is available only as an explicit mission policy", async (t) => {
  const h = await harness(t);
  await h.start(
    unlimited({
      limits: { maxConsecutiveNoProgress: 1 },
      policies: { noProgress: "stop" },
    }),
  );
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "stopped");
});

test("uncapped checks execute normally and remain cancellable; long timeouts do not overflow", async (t) => {
  const h = await harness(t);
  const long = await runCheck(
    "sleep 0.03; printf done",
    h.dir,
    2147483647 + 10000,
  );
  assert.equal(long.killed, false);
  assert.equal(long.output, "done");
  const uncapped = await runCheck("printf uncapped", h.dir, null);
  assert.equal(uncapped.output, "uncapped");
  const controller = new AbortController();
  const pending = runCheck("sleep 10", h.dir, null, controller.signal);
  controller.abort();
  assert.equal((await pending).killed, true);
});

test("uncapped mission with per-command checks completes through the normal gate", async (t) => {
  const h = await harness(t);
  await h.start(
    unlimited({
      checks: [{ command: "printf verified", timeoutSeconds: null }],
    }),
  );
  await h.report();
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "completed");
  assert.equal(h.latest().checks[0].output, "verified");
});

test("pause aborts verification even when both mission and command timeouts are disabled", async (t) => {
  const h = await harness(t);
  await h.start(
    unlimited({ checks: [{ command: "sleep 10", timeoutSeconds: null }] }),
  );
  await h.report();
  h.setIdle(false);
  const pending = h.settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.command("pause");
  assert.equal((await pending).continue, false);
  assert.equal(h.latest().status, "paused");
  assert.equal(h.latest().checks[0].killed, true);
});

test("explicit finite limits and no-progress policy survive restore, without silently widening budgets", async (t) => {
  const a = await harness(t);
  await a.start(definition({ policies: { noProgress: "pause" } }));
  const b = await harness(t, { entries: a.entries, cwd: a.ctx.cwd });
  assert.equal(b.latest().mission.limits.maxMinutes, 1);
  assert.equal(b.latest().mission.limits.maxTurns, 20);
  assert.equal(b.latest().mission.limits.maxContinuations, 4);
  assert.equal(b.latest().mission.limits.checkTimeoutSeconds, 1);
  assert.equal(b.latest().mission.policies.noProgress, "pause");
});
