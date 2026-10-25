import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  definition,
  harness,
  root,
  stateModule as s,
  operationsModule as o,
} from "./helpers.mjs";

const fixture = `
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const c=JSON.parse(process.env.PI_MISSION_OPERATION);
const ctl=existsSync('control.json')?JSON.parse(readFileSync('control.json')):{};
const a=process.argv[2];
console.error('diagnostic log on stderr, not part of JSON stdout');
const identity={key:c.key,attemptId:c.attemptId};
const read=()=>existsSync('remote.json')?JSON.parse(readFileSync('remote.json')):undefined;
if(a==='launch') {
  const ledger=JSON.parse(readFileSync('.pi/mission-operations.json'));
  if(!ledger.records.some(r=>r.key===c.key&&r.status==='launching'&&r.attempts.at(-1).id===c.attemptId)) throw Error('intent not durable');
  if(ctl.crash==='before'&&!existsSync('crashed')) {writeFileSync('crashed','1');process.kill(+process.env.CRASH_HOST_PID,'SIGKILL');process.exit(0)}
  const n=existsSync('launch-count')?+readFileSync('launch-count'):0;
  writeFileSync('launch-count',String(n+1));
  const remote={...identity,operationId:'job-'+c.idempotencyKey,status:'succeeded',value:c.input.value};
  writeFileSync('remote.json',JSON.stringify(remote));
  if(ctl.crash==='after'&&!existsSync('crashed')) {writeFileSync('crashed','1');process.kill(+process.env.CRASH_HOST_PID,'SIGKILL');process.exit(0)}
  if(ctl.dropReceipt) process.exit(0);
  if(ctl.slow) await new Promise(r=>setTimeout(r,10000));
  console.log(JSON.stringify({...identity,operationId:remote.operationId,receipt:{job:remote.operationId}}));
} else if(a==='reconcile') {
  const remote=read();
  console.log(JSON.stringify({...identity,...(remote?{operationId:remote.operationId,status:remote.status,receipt:{job:remote.operationId}}:{status:'absent'}),...ctl.reconcile}));
} else if(a==='verify') {
  const remote=read();
  if(c.status!=='absent'&&(!remote||remote.operationId!==c.operationId||remote.key!==c.key||remote.attemptId!==c.attemptId||remote.value!==c.input.value)) throw Error('artifact provenance or value mismatch');
  console.log(JSON.stringify({...identity,operationId:c.operationId,status:c.status,verified:true,evidence:'Exact identity and artifact value independently checked',...ctl.verify}));
} else if(a==='probe') {
  console.log(JSON.stringify(c));
  process.exitCode=read()?0:75;
}
`;
function setup(h, extra = {}) {
  writeFileSync(join(h.dir, "adapter.mjs"), fixture);
  return definition({
    limits: {},
    operations: [
      {
        id: "job",
        launch: "node adapter.mjs launch",
        reconcile: "node adapter.mjs reconcile",
        verify: "node adapter.mjs verify",
        ...extra,
      },
    ],
    waiters: [
      {
        id: "job",
        kind: "command",
        command: "node adapter.mjs probe",
        intervalSeconds: 60,
      },
    ],
  });
}
const launch = (h, key = "experiment/v1") =>
  h.operation({
    action: "launch",
    operation: "job",
    key,
    input: { value: 42 },
  });
const act = (h, action, key = "experiment/v1") => h.operation({ action, key });
const record = (h) => new o.OperationLedger(h.ctx.cwd).get("experiment/v1");
const control = (h, value) =>
  writeFileSync(join(h.dir, "control.json"), JSON.stringify(value));
const launchCount = (h) =>
  existsSync(join(h.dir, "launch-count"))
    ? +readFileSync(join(h.dir, "launch-count"))
    : 0;

test("operation adapters validate strictly, normalize defaults, and disclose all commands for approval", () => {
  const adapter = {
    id: "job",
    launch: "launch-code",
    reconcile: "reconcile-code",
    verify: "verify-code",
  };
  const m = s.parseMission(definition({ operations: [adapter] }));
  assert.equal(m.operations[0].timeoutSeconds, 30);
  assert.equal(m.operations[0].retryAfterAbsent, false);
  assert.deepEqual(s.parseMission(m), m);
  const summary = s.approvalSummary(m);
  for (const command of [adapter.launch, adapter.reconcile, adapter.verify])
    assert.ok(summary.includes(command));
  for (const operations of [
    {},
    [adapter, adapter],
    [{ ...adapter, verify: "" }],
    [{ ...adapter, timeoutSeconds: null }],
    [{ ...adapter, retryAfterAbsent: "true" }],
    [{ ...adapter, typo: true }],
  ])
    assert.throws(() => s.parseMission(definition({ operations })));
});

test("managed launch persists intent first, returns a receipt, and refuses duplicates and changed input/contracts", async (t) => {
  const h = await harness(t);
  await h.start(setup(h));
  const result = await launch(h);
  assert.equal(result.details.record.status, "pending");
  assert.equal(launchCount(h), 1);
  assert.ok(record(h).attempts[0].operationId);
  assert.ok(record(h).idempotencyKey);
  await assert.rejects(() => launch(h), /already recorded/);
  await assert.rejects(
    () =>
      h.operation({
        action: "reconcile",
        key: "experiment/v1",
        input: { value: 43 },
      }),
    /immutable/,
  );
  assert.equal(launchCount(h), 1);
  const ledger = new o.OperationLedger(h.dir);
  const d = s.parseMission(setup(h)).operations[0];
  await assert.rejects(
    () =>
      ledger.act(
        {
          action: "reconcile",
          definition: { ...d, verify: "true" },
          key: "experiment/v1",
          missionId: h.latest().id,
        },
        new AbortController().signal,
        () => true,
      ),
    /different adapter/,
  );
});

test("readiness is not success: bound wait consumes once, then requires reconciliation and verification", async (t) => {
  const h = await harness(t);
  await h.start(setup(h));
  await launch(h);
  await h.wait({
    conditionId: "job",
    operationKey: "experiment/v1",
    input: { operationId: "untrusted-input" },
    summary: "Inspect the exact job",
  });
  await h.settle();
  await h.emit("agent_settled", { aborted: false });
  await h.command("check");
  assert.equal(h.latest().status, "running");
  assert.equal(record(h).status, "pending");
  assert.ok(record(h).readiness);
  assert.ok(
    record(h).readiness.detail.includes(record(h).attempts[0].operationId),
  );
  await assert.rejects(() => act(h, "verify"), /fresh terminal reconciliation/);
  await h.report();
  assert.equal((await h.settle()).continue, true);
  assert.match(h.latest().reason, /Continuing/);
  await act(h, "reconcile");
  assert.equal(record(h).status, "succeeded");
  await act(h, "verify");
  await h.report();
  assert.equal((await h.settle()).continue, false);
  assert.equal(h.latest().status, "completed");
  assert.equal(launchCount(h), 1);
});

test("exact operation/attempt identity and artifact provenance gate verification, not just file existence", async (t) => {
  const h = await harness(t);
  await h.start(setup(h));
  await launch(h);
  control(h, { reconcile: { operationId: "some-other-job" } });
  await assert.rejects(() => act(h, "reconcile"), /operationId mismatch/);
  control(h, { reconcile: { attemptId: "old-attempt" } });
  await assert.rejects(() => act(h, "reconcile"), /key\/attemptId/);
  control(h, {});
  await act(h, "reconcile");
  const file = join(h.dir, "remote.json");
  const remote = JSON.parse(readFileSync(file));
  writeFileSync(file, JSON.stringify({ ...remote, value: 43 }));
  await assert.rejects(() => act(h, "verify"), /artifact provenance or value/);
  assert.equal(record(h).verification, undefined);
  writeFileSync(file, JSON.stringify(remote));
  await act(h, "reconcile");
  control(h, { verify: { operationId: "old-result" } });
  await assert.rejects(() => act(h, "verify"), /operationId mismatch/);
  control(h, {});
  await act(h, "reconcile");
  await act(h, "verify");
  assert.ok(record(h).verification);
});

test("failed remote job is inspectable and verifiable as failed, never retry permission or automatic mission success", async (t) => {
  const h = await harness(t);
  await h.start(setup(h, { retryAfterAbsent: true }));
  await launch(h);
  const path = join(h.dir, "remote.json");
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path)), status: "failed" }),
  );
  await act(h, "reconcile");
  assert.equal(record(h).status, "failed");
  await assert.rejects(() => act(h, "retry"), /fresh authoritative absence/);
  await act(h, "verify");
  assert.equal(record(h).verification.detail.status, "failed");
  assert.equal(h.latest().status, "running");
  assert.equal(launchCount(h), 1);
});

test("missing receipt leaves ambiguity and prevents even a different-key launch until reconciliation", async (t) => {
  const h = await harness(t);
  await h.start(setup(h, { retryAfterAbsent: true }));
  control(h, { dropReceipt: true });
  await assert.rejects(() => launch(h));
  assert.equal(record(h).status, "unknown");
  await assert.rejects(() => launch(h, "experiment/v2"), /Reconcile ambiguous/);
  await assert.rejects(() => act(h, "retry"), /fresh authoritative absence/);
  control(h, {});
  await act(h, "reconcile");
  assert.equal(record(h).status, "succeeded");
  assert.ok(record(h).attempts[0].operationId);
  assert.equal(
    record(h).attempts[0].receipt.job,
    record(h).attempts[0].operationId,
  );
  await act(h, "verify");
  assert.equal(launchCount(h), 1);
});

test("pause cancels local launch observation but preserves ambiguous intent; resume never launches again", async (t) => {
  const h = await harness(t);
  await h.start(setup(h));
  control(h, { slow: true });
  const pending = launch(h);
  // Attach a rejection handler immediately while waiting for the simulated remote receipt.
  const outcome = pending.then(
    () => null,
    (error) => error,
  );
  for (let i = 0; i < 100 && !existsSync(join(h.dir, "remote.json")); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(existsSync(join(h.dir, "remote.json")));
  await h.command("pause");
  assert.match(String(await outcome), /interrupted/);
  assert.equal(record(h).status, "launching");
  assert.equal(h.latest().status, "paused");
  await h.command("resume");
  await assert.rejects(() => launch(h), /Reconcile ambiguous|already recorded/);
  control(h, {});
  await act(h, "reconcile");
  assert.equal(record(h).status, "succeeded");
  assert.equal(launchCount(h), 1);
});

test("verified results require fresh reconciliation after pause; branches/new missions cannot erase a launch", async (t) => {
  const a = await harness(t);
  await a.start(setup(a));
  const beforeLaunch = structuredClone(a.entries);
  await launch(a);
  await act(a, "reconcile");
  await act(a, "verify");
  await a.command("pause");
  await a.command("resume");
  await assert.rejects(() => act(a, "verify"), /fresh terminal reconciliation/);
  await a.report();
  assert.equal((await a.settle()).continue, true);
  await a.command("pause");
  const b = await harness(t, { cwd: a.dir, entries: beforeLaunch });
  await b.command("resume");
  await assert.rejects(() => launch(b), /already recorded/);
  await act(b, "reconcile");
  await act(b, "verify");
  await b.command("stop");
  // Start a new mission in the same workspace. Reconcile explicitly adopts history.
  await b.start(s.parseMission(setup(a)));
  await assert.rejects(() => launch(b), /already recorded/);
  await act(b, "reconcile");
  assert.equal(record(a).missionIds.length, 2);
  assert.equal(launchCount(a), 1);
});

test("readiness persisted before failed delivery restores paused with exact identity and no wake replay", async (t) => {
  let crashEntries;
  const a = await harness(t, {
    onSendMessage(msg, delivery, entries) {
      if (msg.customType === "mission-feedback" && delivery?.triggerTurn) {
        crashEntries = structuredClone(entries);
        throw new Error("simulated host death before model delivery");
      }
    },
  });
  await a.start(setup(a));
  await launch(a);
  await a.wait({
    conditionId: "job",
    operationKey: "experiment/v1",
    input: {},
    summary: "Collect result",
  });
  await a.settle();
  await a.emit("agent_settled", { aborted: false });
  await a.command("check");
  assert.ok(crashEntries);
  assert.equal(crashEntries.at(-1).data.wait, undefined);
  assert.ok(record(a).readiness);
  const b = await harness(t, { cwd: a.dir, entries: crashEntries });
  assert.equal(b.latest().status, "paused");
  assert.equal(b.prompts.length, 0);
  assert.equal(
    b.messages.filter((m) => m.customType === "mission-feedback").length,
    0,
  );
  await b.command("resume");
  assert.equal(b.latest().wait, undefined);
  assert.ok(b.prompts.at(-1).includes("Begin or resume"));
  await act(b, "reconcile");
  await act(b, "verify");
  assert.equal(launchCount(a), 1);
});

for (const window of ["before", "after"]) {
  test(`SIGKILL ${window === "before" ? "after persisted intent, before external effect" : "after external effect, before receipt persistence"} requires reconciliation`, async (t) => {
    const h = await harness(t);
    const mission = s.parseMission(setup(h, { retryAfterAbsent: true }));
    control(h, { crash: window });
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {createJiti} from ${JSON.stringify(import.meta.resolve("jiti"))};
      const jiti=createJiti(import.meta.url,{moduleCache:false});
      const {OperationLedger}=await jiti.import(${JSON.stringify(join(root, "src/operations.ts"))});
      process.env.CRASH_HOST_PID=String(process.pid);
      await new OperationLedger(process.cwd()).act({action:'launch',definition:${JSON.stringify(mission.operations[0])},key:'experiment/v1',input:{value:42},missionId:'crash-mission'},new AbortController().signal,()=>true);
    `,
      ],
      { cwd: h.dir, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const ledger = new o.OperationLedger(h.dir);
    const original = ledger.get("experiment/v1");
    assert.equal(original.status, "launching");
    assert.equal(original.attempts[0].operationId, undefined);
    const action = (action) =>
      ledger.act(
        {
          action,
          definition: mission.operations[0],
          key: "experiment/v1",
          missionId: "crash-mission",
        },
        new AbortController().signal,
        () => true,
      );
    await assert.rejects(() => action("retry"), /fresh authoritative absence/);
    await action("reconcile");
    if (window === "before") {
      assert.equal(ledger.get("experiment/v1").status, "absent");
      assert.equal(launchCount(h), 0);
      await action("retry");
      const retried = ledger.get("experiment/v1");
      assert.equal(retried.idempotencyKey, original.idempotencyKey);
      assert.equal(retried.attempts.length, 2);
      assert.notEqual(retried.attempts[1].id, original.attempts[0].id);
      await action("reconcile");
    } else {
      assert.equal(ledger.get("experiment/v1").status, "succeeded");
      await assert.rejects(
        () => action("retry"),
        /fresh authoritative absence/,
      );
    }
    await action("verify");
    assert.deepEqual(ledger.completionIssues("crash-mission"), []);
    assert.equal(launchCount(h), 1);
  });
}

test("retry is disabled by default, and a known operation ID cannot be reconciled as absent", async (t) => {
  const h = await harness(t);
  await h.start(setup(h));
  await launch(h);
  control(h, { reconcile: { status: "absent" } });
  await assert.rejects(
    () => act(h, "reconcile"),
    /cannot be treated as authoritative absence/,
  );
  await assert.rejects(() => act(h, "retry"), /Retry requires/);
  assert.equal(launchCount(h), 1);
});

test("completion re-verifies artifacts after later tools and mission checks", async (t) => {
  const h = await harness(t);
  await h.start(setup(h));
  await launch(h);
  await act(h, "reconcile");
  await act(h, "verify");
  const file = join(h.dir, "remote.json");
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(file)),
      value: "tampered-after-verification",
    }),
  );
  await h.report();
  assert.equal((await h.settle()).continue, true);
  assert.equal(h.latest().status, "running");
  assert.ok(
    h
      .latest()
      .checks.some((check) =>
        /Managed operation verification/.test(check.command),
      ),
  );
  assert.equal(record(h).verification, undefined);
});

test("completion never executes an adapter contract altered in the durable ledger", async (t) => {
  const h = await harness(t);
  await h.start(setup(h));
  await launch(h);
  await act(h, "reconcile");
  await act(h, "verify");
  const path = join(h.dir, ".pi/mission-operations.json");
  const data = JSON.parse(readFileSync(path));
  data.records[0].definition.verify = "touch unapproved-command-ran";
  writeFileSync(path, JSON.stringify(data));
  await h.report();
  assert.equal((await h.settle()).continue, true);
  assert.equal(existsSync(join(h.dir, "unapproved-command-ran")), false);
  assert.ok(
    h
      .latest()
      .checks.some((check) => /different adapter contract/.test(check.output)),
  );
});

test("local command timeout preserves external intent and does not authorize retry", async (t) => {
  const h = await harness(t);
  await h.start(setup(h, { timeoutSeconds: 1, retryAfterAbsent: true }));
  control(h, { slow: true });
  await assert.rejects(() => launch(h), /timed out/);
  assert.equal(record(h).status, "unknown");
  await assert.rejects(() => act(h, "retry"), /fresh authoritative absence/);
  control(h, {});
  await act(h, "reconcile");
  assert.equal(record(h).status, "succeeded");
  assert.equal(launchCount(h), 1);
});

test("corrupt operation history fails closed before launch or model startup", async (t) => {
  const h = await harness(t);
  const mission = setup(h);
  mkdirSync(join(h.dir, ".pi"), { recursive: true });
  writeFileSync(
    join(h.dir, ".pi/mission-operations.json"),
    '{"version":99,"records":[]}',
  );
  await h.start(mission);
  assert.equal(h.latest().status, "paused");
  assert.equal(h.prompts.length, 0);
  assert.equal(launchCount(h), 0);
});

test("bundled managed-job adapter checks artifact identity, result value, and hash", async (t) => {
  const h = await harness(t);
  mkdirSync(join(h.dir, "scripts"));
  copyFileSync(
    join(root, "examples/managed-job.mjs"),
    join(h.dir, "scripts/managed-job.mjs"),
  );
  const mission = JSON.parse(
    readFileSync(join(root, "examples/managed-job.json")),
  );
  await h.start(mission);
  await h.operation({
    action: "launch",
    operation: "demo",
    key: "demo/value-42",
    input: { value: 42 },
  });
  await act(h, "reconcile", "demo/value-42");
  const r = new o.OperationLedger(h.dir).get("demo/value-42");
  const artifact = join(h.dir, r.attempts[0].receipt.file);
  const job = JSON.parse(readFileSync(artifact));
  writeFileSync(artifact, JSON.stringify({ ...job, operationId: "stale-job" }));
  await assert.rejects(
    () => act(h, "verify", "demo/value-42"),
    /provenance mismatch/,
  );
  writeFileSync(artifact, JSON.stringify(job));
  await act(h, "reconcile", "demo/value-42");
  writeFileSync(artifact, JSON.stringify({ ...job, sha256: "forged" }));
  await assert.rejects(
    () => act(h, "verify", "demo/value-42"),
    /hash or reconciled outcome/,
  );
  writeFileSync(artifact, JSON.stringify(job));
  await act(h, "reconcile", "demo/value-42");
  await act(h, "verify", "demo/value-42");
  await h.report();
  await h.settle();
  assert.equal(h.latest().status, "completed");
});
