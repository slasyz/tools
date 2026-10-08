import { readFileSync } from "node:fs";

import assert from "node:assert/strict";

import { MODELS } from "../../src/prompt.ts";

const args = process.argv.slice(2);
const input = readFileSync(0, "utf8");
if (args.includes("--prompt=Message: ")) {
  assert.ok(!args.includes("--bind=enter:accept-or-print-query"));
  const calls = readFileSync(process.env.TEST_PI_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // Every benchmark process must finish before the message picker opens.
  for (const call of calls) {
    if (
      call.args[call.args.indexOf("--model") + 1] !== process.env.TEST_PI_FAIL_MODEL &&
      !process.env.TEST_PI_FAIL
    ) {
      assert.ok(readFileSync(call.session, "utf8").includes('"assistant"'));
    }
  }
  if (process.env.TEST_FZF_INPUT) assert.equal(input, process.env.TEST_FZF_INPUT);
} else {
  assert.ok(args.includes("--bind=enter:accept-or-print-query"));
  assert.equal(input, `${MODELS.join("\n")}\n`);
}
process.stdout.write(process.env.TEST_FZF_OUTPUT || "");
process.exitCode = Number(process.env.TEST_FZF_EXIT || "0");
