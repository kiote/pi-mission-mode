import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  definition,
  harness,
  runtimeModule as r,
  stateModule as s,
} from "./helpers.mjs";

test("approval shows every class of executable command before any command runs", async (t) => {
  const h = await harness(t);
  h.ctx.hasUI = true;
  let approval;
  h.ctx.ui.confirm = async (_title, body) => {
    approval = body;
    return false;
  };
  const mission = definition({
    startupChecks: [{ command: "touch should-not-run", timeoutSeconds: 1 }],
    checks: ["printf completion-check"],
    waiters: [
      { id: "remote", kind: "command", command: "printf remote-probe" },
    ],
  });
  writeFileSync(join(h.dir, "mission.json"), JSON.stringify(mission));
  await h.command("start mission.json");
  assert.match(approval, /touch should-not-run/);
  assert.match(approval, /printf completion-check/);
  assert.match(approval, /printf remote-probe/);
  assert.match(approval, /NOT enforced/);
  assert.equal(existsSync(join(h.dir, "should-not-run")), false);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.latest(), undefined);
});

test("ownership claim rejects a .pi directory symlink escaping the workspace", async (t) => {
  const h = await harness(t);
  symlinkSync(tmpdir(), join(h.dir, ".pi"));
  assert.throws(() => new r.WorkspaceLease(h.dir), /escapes/);
});

test("restoring in a foreign workspace cannot overwrite the original progress snapshot", async (t) => {
  const a = await harness(t);
  await a.start(definition({ progressFile: "progress/PROGRESS.md" }));
  await a.command("pause");
  const path = join(a.dir, "progress/STATE.json");
  const original = readFileSync(path, "utf8");
  const b = await harness(t, { entries: a.entries });
  assert.equal(b.latest().status, "paused");
  assert.equal(readFileSync(path, "utf8"), original);
});

test("restoration rejects forged mission IDs before constructing checkpoint paths", async (t) => {
  const state = s.createState(
    s.parseMission(definition()),
    "mission.json",
    "/workspace",
  );
  state.id = "../../should-not-write";
  const h = await harness(t, {
    entries: [{ type: "custom", customType: "mission-state-v1", data: state }],
  });
  await h.command("status");
  assert.match(h.messages.at(-1).content, /No mission/);
  assert.equal(existsSync(join(h.dir, "agent/mission-checkpoints")), false);
});
