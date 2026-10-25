import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definition, harness, stateModule as s, runCheck } from "./helpers.mjs";

// No model calls or provider credentials are used in this suite.
test("validates definitions and rejects typos or invalid finite limits", () => {
  assert.equal(s.parseMission(definition()).limits.maxTurns, 20);
  for (const d of [
    null,
    {},
    definition({ acceptance: [] }),
    definition({ limits: { maxMinutes: 0 } }),
    definition({ limits: { maxTurns: Infinity } }),
    definition({ limits: { maxTurn: 2 } }),
    { ...definition(), cheque: [] },
  ]) {
    assert.throws(() => s.parseMission(d));
  }
});
test("active-time budget survives pause/resume without charging paused time", () => {
  const state = s.createState(
    s.parseMission(definition()),
    "/mission.json",
    "/workspace",
    1000,
  );
  s.transition(state, "paused", "pause", 5000);
  assert.equal(s.elapsed(state, 50000), 4000);
  s.transition(state, "running", "resume", 60000);
  assert.equal(s.elapsed(state, 61000), 5000);
});
test("only novel activity or increased coverage resets no-progress counter", () => {
  const state = s.createState(s.parseMission(definition()), "f", "w");
  state.cycleActivity.push("same");
  assert.equal(s.closeCycle(state), true);
  state.cycleActivity.push("same");
  assert.equal(s.closeCycle(state), false);
  state.report = {
    status: "progress",
    summary: "Different prose is not evidence",
    evidence: [],
  };
  assert.equal(s.closeCycle(state), false);
  assert.equal(state.noProgress, 2);
  state.report.evidence = [{ criterion: 1, evidence: "test result" }];
  assert.equal(s.closeCycle(state), true);
});
test("installation is inert until explicit start; init does not overwrite", async (t) => {
  const h = await harness(t);
  assert.equal(h.latest(), undefined);
  assert.equal(h.active.includes("mission_report"), false);
  assert.equal(await h.settle(), undefined);
  await h.command("init");
  const file = join(h.dir, "mission.json");
  assert.match(readFileSync(file, "utf8"), /REPLACE ME/);
  writeFileSync(file, "keep me");
  await h.command("init");
  assert.equal(readFileSync(file, "utf8"), "keep me");
  assert.equal(h.prompts.length, 0);
});
test("headless start requires explicit authorization", async (t) => {
  const h = await harness(t);
  writeFileSync(join(h.dir, "mission.json"), JSON.stringify(definition()));
  await h.command("start mission.json");
  assert.equal(h.latest(), undefined);
  assert.match(h.messages.at(-1).content, /requires --yes/);
});
test("unfinished work appends runnable feedback, preserving earlier boundary entries", async (t) => {
  const h = await harness(t);
  await h.start();
  const prior = { type: "custom", customType: "other-extension", data: 1 };
  const result = await h.settle({ entries: [prior] });
  assert.equal(result.continue, true);
  assert.deepEqual(result.entries[0], prior);
  assert.equal(result.entries[1].type, "custom_message");
  assert.match(result.entries[1].content, /next concrete step/);
  assert.equal(h.latest().continuations, 1);
  assert.equal(h.active.includes("mission_report"), true);
});
test("complete report plus passing independent checks completes mission", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.report();
  const result = await h.settle();
  assert.equal(result.continue, false);
  assert.equal(h.latest().status, "completed");
  assert.equal(h.latest().checks[0].output, "verified");
  assert.equal(h.active.includes("mission_report"), false);
  assert.equal(
    existsSync(
      join(h.dir, "agent/mission-checkpoints", `${h.latest().id}.json`),
    ),
    true,
  );
});
test("incomplete evidence does not complete, even when checks would pass", async (t) => {
  const h = await harness(t);
  await h.start(definition({ acceptance: ["One", "Two"] }));
  await h.report();
  const result = await h.settle();
  assert.equal(result.continue, true);
  assert.match(result.entries.at(-1).content, /1\/2 criteria/);
  assert.equal(h.latest().checks.length, 0);
});
test("absence of checks requires human review rather than false automatic success", async (t) => {
  const h = await harness(t);
  await h.start(definition({ checks: [] }));
  await h.report();
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "review_required");
});
test("failed verification feeds actionable output back and clears completion claim", async (t) => {
  const h = await harness(t);
  await h.start(definition({ checks: ["printf 'broken test'; exit 7"] }));
  await h.report();
  const result = await h.settle();
  assert.equal(result.continue, true);
  assert.match(result.entries.at(-1).content, /broken test/);
  assert.equal(h.latest().checks[0].code, 7);
  assert.equal(h.latest().report, undefined);
});
test("further tool calls invalidate a completion claim", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.report();
  await h.emit("tool_call", {
    toolName: "read",
    toolCallId: "r1",
    input: { path: "file" },
  });
  const result = await h.settle();
  assert.equal(result.continue, true);
  assert.equal(h.latest().checks.length, 0);
});
test("blockers stop without continuation", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.report({
    status: "blocked",
    summary: "Cannot authenticate",
    evidence: [],
    blocker: "Missing staging credentials",
  });
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "blocked");
});
test("abort never restarts work; late tool calls are blocked until settlement", async (t) => {
  const h = await harness(t);
  await h.start();
  assert.equal((await h.settle({ outcome: "aborted" })).continue, false);
  assert.equal(h.latest().status, "paused");
  const blocked = await h.emit("tool_call", {
    toolName: "bash",
    input: { command: "true" },
    toolCallId: "late",
  });
  assert.equal(blocked.block, true);
  await h.emit("agent_settled", { aborted: true });
  assert.equal(
    await h.emit("tool_call", {
      toolName: "read",
      input: {},
      toolCallId: "normal",
    }),
    undefined,
  );
});
test("provider error stops instead of repeatedly continuing", async (t) => {
  const h = await harness(t);
  await h.start();
  assert.equal((await h.settle({ outcome: "error" })).continue, false);
  assert.equal(h.latest().status, "blocked");
});
test("pause aborts the owned run; stop is not resumable", async (t) => {
  const h = await harness(t);
  await h.start();
  h.setIdle(false);
  await h.command("pause");
  assert.equal(h.aborts, 1);
  assert.equal(h.latest().status, "paused");
  assert.equal((await h.settle()).continue, false);
  await h.emit("agent_settled", { aborted: true });
  h.setIdle(true);
  await h.command("stop");
  await h.command("resume");
  assert.equal(h.latest().status, "stopped");
  assert.match(h.messages.at(-1).content, /Only paused or blocked/);
});
test("continuation limit and no-progress threshold independently stop work", async (t) => {
  const a = await harness(t);
  await a.start(
    definition({
      limits: { maxContinuations: 1, maxConsecutiveNoProgress: 20 },
    }),
  );
  assert.equal((await a.settle()).continue, true);
  assert.equal((await a.settle()).continue, false);
  assert.equal(a.latest().status, "exhausted");
  const b = await harness(t);
  await b.start(
    definition({
      limits: { maxContinuations: 20, maxConsecutiveNoProgress: 2 },
      policies: { noProgress: "pause" },
    }),
  );
  assert.equal((await b.settle()).continue, true);
  assert.equal((await b.settle()).continue, false);
  assert.equal(b.latest().status, "paused");
});
test("turn budget stops a tool-calling loop before settlement", async (t) => {
  const h = await harness(t);
  await h.start(definition({ limits: { maxTurns: 2 } }));
  h.setIdle(false);
  await h.emit("turn_end", { outcome: "completed" });
  await h.emit("turn_end", { outcome: "completed" });
  assert.equal(h.latest().status, "exhausted");
  assert.equal(h.aborts, 1);
  assert.equal((await h.settle()).continue, false);
});
test("session restoration is paused, branch-local, and does not automatically prompt", async (t) => {
  const a = await harness(t);
  await a.start();
  await a.settle();
  const b = await harness(t, { entries: a.entries, cwd: a.ctx.cwd });
  assert.equal(b.latest().status, "paused");
  assert.equal(b.latest().continuations, 1);
  assert.equal(b.prompts.length, 0);
  await a.command("pause"); // A restored session must not steal a still-live owner's workspace.
  await b.command("resume");
  assert.equal(b.latest().status, "running");
  assert.equal(b.latest().continuations, 1);
  assert.equal(b.prompts.length, 1);
  const c = await harness(t); // An unrelated branch/session has no mission.
  assert.equal(c.latest(), undefined);
});
test("resume rejects a different workspace", async (t) => {
  const a = await harness(t);
  await a.start();
  const b = await harness(t, { entries: a.entries });
  await b.command("resume");
  assert.equal(b.latest().status, "paused");
  assert.match(b.messages.at(-1).content, /original workspace/);
});
test("deadline interrupts live work without waiting for settlement", async (t) => {
  const a = await harness(t);
  await a.start();
  const entries = structuredClone(a.entries);
  await a.command("pause"); // Simulate release by the original session before recovery.
  const saved = entries.at(-1).data;
  saved.usedMs = saved.mission.limits.maxMinutes * 60000 - 100;
  saved.status = "paused";
  saved.runningSince = undefined;
  const b = await harness(t, { entries, cwd: a.ctx.cwd });
  await b.command("resume");
  b.setIdle(false);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(b.latest().status, "exhausted");
  assert.equal(b.aborts, 1);
});
test("pause during verification cancels checks and cannot declare completion", async (t) => {
  const h = await harness(t);
  await h.start(definition({ checks: ["sleep 10; printf should-not-run"] }));
  await h.report();
  h.setIdle(false);
  const settling = h.settle();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await h.command("pause");
  const result = await settling;
  assert.equal(result.continue, false);
  assert.equal(h.latest().status, "paused");
  assert.equal(h.latest().checks[0].killed, true);
});
test("verification uses pipefail, bounded output, timeout, abort and correct cwd", async (t) => {
  const h = await harness(t);
  assert.equal((await runCheck("false | true", h.dir, 1000)).code, 1);
  assert.equal(
    realpathSync((await runCheck("pwd", h.dir, 1000)).output.trim()),
    realpathSync(h.dir),
  );
  const large = await runCheck("printf '%20000s' x", h.dir, 1000);
  assert.equal(large.output.length, 12000);
  const timed = await runCheck("sleep 10", h.dir, 40);
  assert.equal(timed.killed, true);
  const controller = new AbortController();
  const pending = runCheck("sleep 10", h.dir, 10000, controller.signal);
  controller.abort();
  assert.equal((await pending).killed, true);
});
