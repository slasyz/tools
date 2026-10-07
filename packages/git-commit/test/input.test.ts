import { PassThrough } from "node:stream";
import { test } from "node:test";

import assert from "node:assert/strict";

import { askForAction } from "../src/input.ts";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
  output.resume();
  return { input, output };
}

test("Enter accepts and restores terminal mode", async () => {
  const { input, output } = terminal();
  const answer = askForAction(undefined, input, output);
  assert.equal(input.isRaw, true);
  input.write("\r");
  assert.deepEqual(await answer, { type: "accept" });
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("typed feedback supports editing and Unicode", async () => {
  const { input, output } = terminal();
  const answer = askForAction(undefined, input, output);
  input.write("Mention caféx\u007f instead\r");
  assert.deepEqual(await answer, { type: "feedback", text: "Mention café instead" });
});

test("c, e, and s are feedback rather than the old menu commands", async () => {
  for (const text of ["c", "e", "s"]) {
    const { input, output } = terminal();
    const answer = askForAction(undefined, input, output);
    input.write(`${text}\r`);
    assert.deepEqual(await answer, { type: "feedback", text });
  }
});

test("Ctrl-G opens the editor without needing Enter and allows another review", async () => {
  const { input, output } = terminal();
  const answer = askForAction(undefined, input, output);
  input.write("unfinished feedback\u0007");
  assert.deepEqual(await answer, { type: "edit" });
  assert.equal(input.isRaw, false);
  const next = askForAction(undefined, input, output);
  input.write("\r");
  assert.deepEqual(await next, { type: "accept" });
});

test("Ctrl-C, Ctrl-D, and abort stop without accepting", async () => {
  for (const key of ["\u0003", "\u0004"]) {
    const { input, output } = terminal();
    const answer = askForAction(undefined, input, output);
    input.write(key);
    await assert.rejects(answer, { exitCode: 130 });
    assert.equal(input.isRaw, false);
  }
  const { input, output } = terminal();
  const controller = new AbortController();
  const answer = askForAction(controller.signal, input, output);
  controller.abort();
  await assert.rejects(answer, { exitCode: 130 });
  assert.equal(input.isRaw, false);
});

test("redirected input cannot silently accept a commit", async () => {
  await assert.rejects(
    askForAction(undefined, new PassThrough(), new PassThrough()),
    /interactive terminal/,
  );
});
