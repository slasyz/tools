import assert from "node:assert/strict";
import { test } from "node:test";

import { parseGeneration } from "../src/pi.ts";

function message(total?: unknown, text = "Add cost reporting") {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Ignore this" }, { type: "text", text }],
    usage: { cost: { total } },
    stopReason: "stop",
  };
}

const stream = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\r\n");

test("completed assistant messages supply the subject and cost without counting duplicate events", () => {
  const assistant = message(0.012345, "Add cost reporting\nMore text");
  assert.deepEqual(
    parseGeneration(stream(
      { type: "session" },
      { type: "message_end", message: { role: "user", content: "Prompt" } },
      { type: "message_update", usage: { cost: { total: 1 } } },
      { type: "message_end", message: assistant },
      { type: "turn_end", message: assistant },
      { type: "agent_end", messages: [assistant] },
    )),
    { subject: "Add cost reporting", cost: 0.012345 },
  );
});

test("zero is a reported cost; missing or invalid costs are omitted", () => {
  for (const total of [undefined, null, "0.01", -1, Infinity]) {
    assert.equal(parseGeneration(stream({ type: "message_end", message: message(total) })).cost, undefined);
  }
  assert.equal(parseGeneration(stream({ type: "message_end", message: message(0) })).cost, 0);
});

test("request costs include retries and compaction, not just the final response", () => {
  assert.deepEqual(
    parseGeneration(stream(
      { type: "message_end", message: { ...message(0.01), stopReason: "error" } },
      { type: "compaction_end", result: { usage: { cost: { total: 0.02 } } } },
      { type: "message_end", message: message(0.03) },
    )),
    { subject: "Add cost reporting", cost: 0.06 },
  );
  assert.equal(parseGeneration(stream(
    { type: "message_end", message: message() },
    { type: "message_end", message: message(0.03) },
  )).cost, undefined);
});

test("JSON framing preserves Unicode separators inside text", () => {
  const subject = "Add\u2028cost\u2029reporting";
  assert.equal(parseGeneration(stream({ type: "message_end", message: message(0, subject) })).subject, subject);
});

test("invalid JSON, empty responses, and failed final responses are rejected", () => {
  assert.throws(() => parseGeneration("not JSON"), /invalid JSON response/);
  assert.throws(() => parseGeneration("null"), /invalid JSON response/);
  assert.throws(() => parseGeneration(stream({ type: "agent_end", messages: [] })), /empty commit message/);
  assert.throws(() => parseGeneration(stream({ type: "message_end", message: message(0, "\n ") })), /empty commit message/);
  for (const stopReason of ["error", "aborted"]) {
    assert.throws(() => parseGeneration(stream({ type: "message_end", message: { ...message(0), stopReason } })), /empty commit message/);
  }
});
