import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { root, harness, stateModule as s } from "./helpers.mjs";

test("bundled mission examples validate against the runtime parser", () => {
  for (const file of ["document-repository.json", "external-job.json"]) {
    const mission = s.parseMission(
      JSON.parse(readFileSync(join(root, "examples", file), "utf8")),
    );
    assert.ok(mission.goal);
    assert.ok(mission.acceptance.length);
  }
});

test("example probe distinguishes missing, mismatched, pending, and terminal jobs", async (t) => {
  const h = await harness(t);
  const probe = (input) =>
    spawnSync(process.execPath, [join(root, "examples/probe-job.mjs")], {
      cwd: h.dir,
      env: { ...process.env, PI_MISSION_WAIT_INPUT: JSON.stringify(input) },
      encoding: "utf8",
      timeout: 3000,
    });
  const input = { path: "result.json", jobId: "unique-job" };
  assert.equal(probe(input).status, 75);
  writeFileSync(
    join(h.dir, "result.json"),
    JSON.stringify({ jobId: "different-job", status: "complete" }),
  );
  assert.equal(probe(input).status, 2);
  for (const [status, expected] of [
    ["running", 75],
    ["complete", 0],
    ["failed", 0],
  ]) {
    writeFileSync(
      join(h.dir, "result.json"),
      JSON.stringify({ jobId: "unique-job", status }),
    );
    assert.equal(probe(input).status, expected);
  }
  assert.equal(
    probe({ path: "../outside.json", jobId: "unique-job" }).status,
    2,
  );
});
