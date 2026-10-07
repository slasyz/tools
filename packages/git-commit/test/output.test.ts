import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import assert from "node:assert/strict";

import { formatContext, formatMessage, formatReviewPrompt } from "../src/output.ts";
import { INSTRUCTIONS } from "../src/prompt.ts";

const context = {
  scope: "staged changes",
  files: "M\tone.ts\n",
  subjects: "First subject\r\nSecond subject\r\n",
  diff: "diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+new\n",
};

test("context separates instructions, a commit list, and the full diff", () => {
  const sections = stripVTControlCharacters(formatContext(context, 40)).split("\n\n");
  assert.equal(sections.length, 4);
  assert.equal(sections[0], "Files with staged changes\nM\tone.ts");
  const [heading, ...instructions] = sections[1].split("\n");
  assert.equal(heading, "Prompt");
  assert.equal(instructions.join(" "), INSTRUCTIONS);
  assert.ok(instructions.every((line) => line.length <= 40));
  assert.equal(
    sections[2],
    "Recent commits (style context)\n  • First subject\n  • Second subject",
  );
  assert.equal(sections[3], `Git diff\n${context.diff.trimEnd()}`);
});

test("an initial commit has an explicit empty history", () => {
  const output = stripVTControlCharacters(formatContext({ ...context, subjects: "" }));
  assert.match(output, /Recent commits \(style context\)\n  No recent commits\./);
  assert.doesNotMatch(output, /•/);
});

test("the first proposed message shows input size, diff lines, and fractional seconds", () => {
  assert.equal(
    stripVTControlCharacters(
      formatMessage("Add CLI styling", { promptChars: 1234, diffLines: 42, seconds: 8.126 }),
    ),
    "Proposed commit message (1,234 chars, 42 LoC, 8.13s)\n  Add CLI styling\n",
  );
  assert.match(
    stripVTControlCharacters(
      formatMessage("Add CLI styling", { promptChars: 1234, diffLines: 42, seconds: 0 }),
    ),
    /\(1,234 chars, 42 LoC, 0\.00s\)/,
  );
});

test("character and diff line counts group thousands and millions", () => {
  assert.equal(
    stripVTControlCharacters(
      formatMessage("Add CLI styling", { promptChars: 1234567, diffLines: 12345, seconds: 8.12 }),
    ),
    "Proposed commit message (1,234,567 chars, 12,345 LoC, 8.12s)\n  Add CLI styling\n",
  );
  assert.match(
    stripVTControlCharacters(
      formatMessage("Add CLI styling", { promptChars: 999, diffLines: 0, seconds: 0 }),
    ),
    /\(999 chars, 0 LoC, 0\.00s\)/,
  );
});

test("subsequent proposed messages have no statistics suffix", () => {
  assert.equal(
    stripVTControlCharacters(formatMessage("Refine CLI styling")),
    "Proposed commit message\n  Refine CLI styling\n",
  );
});

test("review shortcuts remain readable without colors", () => {
  assert.equal(
    stripVTControlCharacters(formatReviewPrompt()),
    "Enter: accept · Type feedback + Enter: regenerate\nCtrl-G: edit · Ctrl-C: stop\n> ",
  );
});
