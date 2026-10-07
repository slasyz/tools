import { readFileSync } from "node:fs";

import assert from "node:assert/strict";

import { MODELS } from "../../src/prompt.ts";

const args = process.argv.slice(2);
assert.ok(args.includes("--bind=enter:accept-or-print-query"));
assert.equal(readFileSync(0, "utf8"), `${MODELS.join("\n")}\n`);
process.stdout.write(process.env.TEST_FZF_OUTPUT || "");
process.exitCode = Number(process.env.TEST_FZF_EXIT || "0");
