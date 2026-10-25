// Trusted local example probe: 0=ready, 75=pending, 2=needs diagnosis.
// Run from the workspace containing examples/ and results/.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

try {
  const input = JSON.parse(process.env.PI_MISSION_WAIT_INPUT || "{}");
  if (
    typeof input.path !== "string" ||
    typeof input.jobId !== "string" ||
    !input.jobId
  ) {
    throw new Error("input.path and input.jobId are required");
  }
  const root = realpathSync(process.cwd());
  // Validate lexical traversal even before the producer creates the file.
  const target = resolve(root, input.path);
  const within = (path) => {
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new Error("Result path escapes the workspace");
  };
  within(target);
  const actual = realpathSync(target);
  within(actual);
  if (!statSync(actual).isFile() || statSync(actual).size > 1000000)
    throw new Error("Result must be a JSON file no larger than 1 MB");
  const result = JSON.parse(readFileSync(actual, "utf8"));
  if (result.jobId !== input.jobId)
    throw new Error(
      "Job identity mismatch: do not retry the external operation blindly",
    );
  const ready = ["complete", "failed"].includes(result.status);
  console.log(
    JSON.stringify({ jobId: result.jobId, status: result.status ?? "unknown" }),
  );
  process.exitCode = ready ? 0 : 75;
} catch (error) {
  const missing = error?.code === "ENOENT";
  console.log(
    JSON.stringify({
      status: missing ? "pending" : "needs-diagnosis",
      reason: missing ? "Result file does not exist yet" : error.message,
    }),
  );
  process.exitCode = missing ? 75 : 2;
}
