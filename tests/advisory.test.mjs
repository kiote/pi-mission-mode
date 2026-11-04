import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definition, harness, stateModule as s } from "./helpers.mjs";

const review = (command = "printf 'Check the source'; exit 0") => ({
  command,
  advisory: true,
});

test("advisory is opt-in, boolean, visible at approval, and forbidden in startup checks", () => {
  const mission = s.parseMission(definition({ checks: [review(), "true"] }));
  assert.equal(mission.checks[0].advisory, true);
  assert.equal(mission.checks[1].advisory, undefined);
  assert.deepEqual(s.parseMission(mission), mission);
  assert.match(s.approvalSummary(mission), /advisory/);
  for (const value of ["yes", null, 1]) {
    assert.throws(() =>
      s.parseMission(
        definition({ checks: [{ command: "true", advisory: value }] }),
      ),
    );
  }
  assert.throws(() =>
    s.parseMission(definition({ startupChecks: [review()] })),
  );
});

for (const code of [0, 1]) {
  test(`advisory exit ${code} feeds findings once before mandatory verification`, async (t) => {
    const h = await harness(t);
    await h.start(
      definition({
        checks: [
          "printf mandatory > gate-ran",
          review(`printf 'Major: wrong source'; exit ${code}`),
        ],
      }),
    );
    await h.report();
    const first = await h.settle();
    assert.equal(first.continue, true);
    assert.match(first.entries.at(-1).content, /Major: wrong source/);
    assert.equal(h.latest().advisoryReviewed, true);
    assert.equal(h.latest().report, undefined);
    assert.equal(existsSync(join(h.dir, "gate-ran")), false);
    await h.report();
    assert.equal((await h.settle()).continue, false);
    assert.equal(h.latest().status, "completed");
    assert.equal(h.latest().checks.length, 1);
    assert.equal(h.latest().advisoryChecks[0].code, code);
    assert.equal(readFileSync(join(h.dir, "gate-ran"), "utf8"), "mandatory");
  });
}

test("one advisory finding does not stop the next advisory command", async (t) => {
  const h = await harness(t);
  await h.start(
    definition({
      checks: [review("printf first; exit 1"), review("printf second"), "true"],
    }),
  );
  await h.report();
  const result = await h.settle();
  assert.match(result.entries.at(-1).content, /first[\s\S]*second/);
  assert.equal(h.latest().advisoryChecks.length, 2);
});

test("mandatory failures remain enforced after advisory feedback, without rerunning the review", async (t) => {
  const h = await harness(t);
  await h.start(
    definition({
      checks: [review("printf x >> reviews; printf advice"), "test -f fixed"],
    }),
  );
  await h.report();
  await h.settle();
  await h.report();
  assert.equal((await h.settle()).continue, true);
  assert.equal(h.latest().status, "running");
  writeFileSync(join(h.dir, "fixed"), "ok");
  await h.report();
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "completed");
  assert.equal(readFileSync(join(h.dir, "reviews"), "utf8"), "x");
});

test("advisory-only missions still require human review", async (t) => {
  const h = await harness(t);
  await h.start(definition({ checks: [review()] }));
  await h.report();
  await h.settle();
  await h.report();
  await h.settle();
  assert.equal(h.latest().status, "review_required");
});

test("review errors pause rather than grant acceptance", async (t) => {
  const h = await harness(t);
  await h.start(
    definition({ checks: [review("printf 'auth error'; exit 2"), "true"] }),
  );
  await h.report();
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "paused");
  assert.notEqual(h.latest().advisoryReviewed, true);
  assert.match(h.latest().reason, /Advisory/);
});

test("timed-out review pauses without consuming the one-time review", async (t) => {
  const h = await harness(t);
  await h.start(
    definition({
      checks: [{ ...review("sleep 5"), timeoutSeconds: 1 }, "true"],
    }),
  );
  await h.report();
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "paused");
  assert.notEqual(h.latest().advisoryReviewed, true);
  assert.equal(h.latest().checks[0].killed, true);
});

test("self-review precedes advisory review and both occur only once", async (t) => {
  const h = await harness(t);
  await h.start(
    definition({ policies: { selfReview: true }, checks: [review(), "true"] }),
  );
  await h.report();
  await h.settle();
  assert.equal(h.latest().selfReviewed, true);
  assert.notEqual(h.latest().advisoryReviewed, true);
  assert.equal(h.latest().checks.length, 0);
  await h.report();
  assert.equal((await h.settle()).continue, true);
  assert.equal(h.latest().advisoryReviewed, true);
  await h.report();
  await h.settle();
  assert.equal(h.latest().status, "completed");
  assert.equal(h.latest().continuations, 2);
});

test("explicit advisory false remains a mandatory gate", async (t) => {
  const h = await harness(t);
  await h.start(
    definition({ checks: [{ command: "exit 1", advisory: false }] }),
  );
  await h.report();
  assert.equal((await h.settle()).continue, true);
  assert.notEqual(h.latest().advisoryReviewed, true);
  assert.equal(h.latest().status, "running");
});

test("pause during review does not consume it or complete the mission", async (t) => {
  const h = await harness(t);
  await h.start(definition({ checks: [review("sleep 5"), "true"] }));
  await h.report();
  h.setIdle(false);
  const pending = h.settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await h.command("pause");
  assert.equal((await pending).continue, false);
  assert.equal(h.latest().status, "paused");
  assert.notEqual(h.latest().advisoryReviewed, true);
});

test("review state survives pause and restore", async (t) => {
  const a = await harness(t);
  await a.start(
    definition({
      checks: [review("printf x >> reviews; printf advice"), "true"],
    }),
  );
  await a.report();
  await a.settle();
  await a.command("pause");
  const b = await harness(t, { entries: a.entries, cwd: a.ctx.cwd });
  await b.command("resume");
  await b.report();
  await b.settle();
  assert.equal(b.latest().status, "completed");
  assert.equal(b.latest().advisoryReviewed, true);
  assert.equal(readFileSync(join(a.dir, "reviews"), "utf8"), "x");
});

test("no continuation budget cannot skip advisory feedback and complete", async (t) => {
  const h = await harness(t);
  await h.start(
    definition({
      checks: [review("printf x > review-ran"), "true"],
      limits: { maxContinuations: 1 },
    }),
  );
  await h.settle();
  await h.report();
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "exhausted");
  assert.equal(existsSync(join(h.dir, "review-ran")), false);
});
