import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { resolveBash, runCheck } = await jiti.import(
  join(root, "src/verify.ts"),
);

const has = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

test("resolveBash uses /bin/bash on POSIX", () => {
  assert.equal(
    resolveBash("linux", {}, () => false),
    "/bin/bash",
  );
  assert.equal(
    resolveBash("darwin", {}, () => false),
    "/bin/bash",
  );
});

test("resolveBash on Windows prefers PI_MISSION_BASH and fails closed when it is missing", () => {
  const custom = "D:\\tools\\bash.exe";
  assert.equal(
    resolveBash("win32", { PI_MISSION_BASH: custom }, has(custom)),
    custom,
  );
  assert.equal(
    resolveBash(
      "win32",
      { PI_MISSION_BASH: custom, ProgramFiles: "C:\\Program Files" },
      has("C:\\Program Files\\Git\\usr\\bin\\bash.exe"),
    ),
    undefined,
  );
});

test("resolveBash on Windows finds Git for Windows installs", () => {
  const machine = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
  assert.equal(
    resolveBash("win32", { ProgramFiles: "C:\\Program Files" }, has(machine)),
    machine,
  );
  const user =
    "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe";
  assert.equal(
    resolveBash(
      "win32",
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      has(user),
    ),
    user,
  );
  const fromPath = "E:\\PortableGit\\usr\\bin\\bash.exe";
  assert.equal(
    resolveBash(
      "win32",
      { Path: "C:\\Windows\\System32;E:\\PortableGit\\cmd" },
      has("E:\\PortableGit\\cmd\\git.exe", fromPath),
    ),
    fromPath,
  );
  const wrapper = "E:\\G\\bin\\bash.exe";
  assert.equal(
    resolveBash(
      "win32",
      { PATH: "E:\\G\\mingw64\\bin" },
      has("E:\\G\\mingw64\\bin\\git.exe", wrapper),
    ),
    wrapper,
  );
});

test("resolveBash on Windows never falls back to a bare bash.exe (WSL)", () => {
  assert.equal(
    resolveBash(
      "win32",
      { Path: "C:\\Windows\\System32" },
      has("C:\\Windows\\System32\\bash.exe"),
    ),
    undefined,
  );
});

test("runCheck runs POSIX tools, reports exit codes, and kills on timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-verify-"));
  try {
    const ok = await runCheck("printf 'a\\nb\\n' | grep -c b", dir, 5000);
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout.trim(), "1");
    assert.equal((await runCheck("exit 3", dir, 5000)).code, 3);
    const started = Date.now();
    const timed = await runCheck("sleep 10", dir, 200);
    assert.equal(timed.killed, true);
    assert.ok(Date.now() - started < 8000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
