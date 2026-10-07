import { test } from "node:test";

import assert from "node:assert/strict";

import { checked, run } from "../src/process.ts";

test("captures stdout, stderr, and nonzero exit status", async () => {
  const result = await run(process.execPath, [
    "-e",
    "console.log('out'); console.error('err'); process.exitCode = 7",
  ]);
  assert.deepEqual(result, { code: 7, stdout: "out\n", stderr: "err\n" });
  await assert.rejects(
    checked(process.execPath, ["-e", "console.error('failure'); process.exitCode = 7"]),
    { message: "failure", exitCode: 7 },
  );
});

test("reports a missing executable", async () => {
  await assert.rejects(run("/nonexistent/git-commit-command", []), /was not found on PATH/);
});

test("abort waits for the child to exit", async () => {
  const controller = new AbortController();
  const pending = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
