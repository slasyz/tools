import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import assert from "node:assert/strict";

import {
  formatBenchmarkResult,
  formatBenchmarkStart,
  formatContext,
  formatGenerationStart,
  formatMessage,
  formatReviewPrompt,
} from "../src/output.ts";
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

test("proposed messages show fractional seconds when cost is unavailable", () => {
  assert.equal(
    stripVTControlCharacters(formatMessage("Add CLI styling", 8.126)),
    "Proposed commit message (8.13s)\n  Add CLI styling\n",
  );
  assert.match(stripVTControlCharacters(formatMessage("Add CLI styling", 0)), /\(0\.00s\)/);
});

test("request statistics show estimated USD costs, including zero", () => {
  assert.equal(
    stripVTControlCharacters(formatMessage("Add cost reporting", 8.126, 0.012345)),
    "Proposed commit message (8.13s, $0.0123)\n  Add cost reporting\n",
  );
  assert.equal(
    stripVTControlCharacters(formatBenchmarkResult("provider/model", "Add cost reporting", 0, 0)),
    "Model provider/model:minimal (0.00s, $0.0000)\n  Add cost reporting\n",
  );
});

test("character and diff line counts group thousands and millions", () => {
  assert.equal(
    stripVTControlCharacters(
      formatGenerationStart("provider/model", { promptChars: 1234567, diffLines: 12345 }),
    ),
    "Generating commit message with provider/model:minimal (1,234,567 chars, 12,345 LoC)...",
  );
  assert.match(
    stripVTControlCharacters(
      formatGenerationStart("provider/model", { promptChars: 999, diffLines: 0 }),
    ),
    /\(999 chars, 0 LoC\)/,
  );
});

test("subsequent proposed messages have no statistics suffix", () => {
  assert.equal(
    stripVTControlCharacters(formatMessage("Refine CLI styling")),
    "Proposed commit message\n  Refine CLI styling\n",
  );
});

test("benchmark start shows the shared input size and diff line count", () => {
  assert.equal(
    stripVTControlCharacters(formatBenchmarkStart({ promptChars: 1234567, diffLines: 12345 })),
    "Generating commit messages (1,234,567 chars, 12,345 LoC)...",
  );
});

test("generation without statistics still shows the thinking level", () => {
  assert.equal(
    stripVTControlCharacters(formatGenerationStart("provider/model")),
    "Generating commit message with provider/model:minimal...",
  );
});

test("benchmark results show the thinking level and elapsed time on the model heading", () => {
  assert.equal(
    stripVTControlCharacters(formatBenchmarkResult("provider/model", "Add benchmark mode", 8.126)),
    "Model provider/model:minimal (8.13s)\n  Add benchmark mode\n",
  );
});

test("review shortcuts remain readable without colors", () => {
  assert.equal(
    stripVTControlCharacters(formatReviewPrompt()),
    "Enter: accept · Type feedback + Enter: regenerate\nCtrl-G: edit · Ctrl-C: stop\n> ",
  );
});
