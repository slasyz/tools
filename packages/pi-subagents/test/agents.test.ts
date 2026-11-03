import { test } from "node:test";

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { harness } from "./helpers.ts";

test("spawn returns without waiting for completion; stores full output privately", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const agent = await h.spawn();
  assert.equal(agent.status, "running");
  assert.deepEqual(
    h.connections[0].commands.map((c) => c.type),
    ["get_state", "prompt"],
  );
  assert.equal((await stat(agent.session_file!)).mode & 0o777, 0o600);
  assert.equal((await h.manager.wait(1)).reason, "Timed out; agents continue running");
  const output = "hello 😀\n".repeat(5000);
  h.connections[0].complete(output);
  const { result } = await h.manager.wait();
  assert.equal(result?.status, "idle");
  assert.match(result!.output, /Truncated/);
  assert.equal(await readFile(result!.output_file!, "utf8"), output);
  assert.equal(h.completions.length, 1);
  assert.equal(h.manager.list()[0].status, "idle");
  assert.ok(Buffer.byteLength(h.manager.list()[0].result!.output) < 1000);
  await h.manager.dispose();
  await assert.rejects(stat(agent.session_file!), { code: "ENOENT" });
  assert.equal(h.connections[0].stopped, true);
});

test("send steers, follow-ups queue, and idle agents resume the same session", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const agent = await h.spawn();
  await h.manager.send(agent.id, "focus", false);
  await h.manager.send(agent.id, "then test", true);
  assert.equal(h.connections[0].commands[2].streamingBehavior, "steer");
  assert.equal(h.connections[0].commands[3].streamingBehavior, "followUp");
  h.connections[0].complete("first");
  await h.manager.wait();
  const resumed = await h.manager.send(agent.id, "more", true);
  assert.equal(resumed.run, 2);
  assert.equal(resumed.session_file, agent.session_file);
  h.connections[0].complete("second");
  assert.equal((await h.manager.wait()).result?.output, "second");
});

test("agent_end is not final; retries can recover before agent_settled", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  await h.spawn();
  h.connections[0].emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary" },
  });
  h.connections[0].emit({ type: "agent_end" });
  assert.equal(h.manager.list()[0].status, "running");
  assert.equal(h.completions.length, 0);
  h.connections[0].complete("recovered");
  const { result } = await h.manager.wait();
  assert.equal(result?.status, "idle");
  assert.equal(result?.error, undefined);
});

test("interrupt clears queue before abort and keeps context resumable", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const agent = await h.spawn();
  const interrupted = await h.manager.interrupt(agent.id);
  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(
    h.connections[0].commands.slice(-2).map((c) => c.type),
    ["clear_queue", "abort"],
  );
  assert.equal((await h.manager.wait()).result?.status, "interrupted");
  assert.equal(h.completions.length, 1);
  assert.equal((await h.manager.send(agent.id, "continue", false)).status, "running");
});

test("concurrent spawns reserve four slots before awaiting startup", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  await Promise.all([h.spawn(), h.spawn(), h.spawn(), h.spawn()]);
  await assert.rejects(h.spawn(), /Four agents/);
  h.connections[0].complete();
  const completed = (await h.manager.wait()).result!;
  const fifth = await h.spawn();
  assert.equal(fifth.id, "agent-5");
  await assert.rejects(h.manager.send(completed.id, "resume", false), /Four agents/);
});

test("process crashes notify and cannot be resumed; model failures can", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const agent = await h.spawn();
  h.connections[0].complete("", "error", "API failed");
  assert.equal((await h.manager.wait()).result?.error, "API failed");
  await h.manager.send(agent.id, "retry", false);
  h.connections[0].options.onFailure(new Error("process crashed"));
  const { result } = await h.manager.wait();
  assert.equal(result?.status, "failed");
  assert.match(result!.error!, /process crashed/);
  await assert.rejects(h.manager.send(agent.id, "again", false), /process exited/);
});

test("wait cancellation leaves agents running; disposal wakes waiters", async () => {
  const h = harness();
  try {
    await h.spawn();
    const controller = new AbortController();
    const wait = h.manager.wait(30_000, controller.signal);
    controller.abort();
    await assert.rejects(wait, /Wait cancelled/);
    assert.equal(h.manager.list()[0].status, "running");
    const waiting = h.manager.wait();
    await h.manager.dispose();
    assert.equal((await waiting).reason, "Session closed");
    await h.manager.dispose();
  } finally {
    await h.manager.dispose();
  }
});

test("handled prompts complete without waiting for an event", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const first = await h.spawn();
  h.connections[0].complete();
  await h.manager.wait();
  h.connections[0].handler = async () => ({ disposition: "handled" });
  await h.manager.send(first.id, "/command", false);
  assert.match((await h.manager.wait()).result!.output, /handled by an extension/);
});

test("delivery failure stops the process instead of leaving uncertain work", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const agent = await h.spawn();
  h.connections[0].handler = async () => {
    throw new Error("command timed out");
  };
  await assert.rejects(h.manager.send(agent.id, "message", false), /timed out/);
  assert.equal(h.connections[0].stopped, true);
  assert.equal((await h.manager.wait()).result?.status, "failed");
});

test("settle before prompt acknowledgement still creates exactly one completion", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const agent = await h.spawn();
  h.connections[0].complete("first");
  await h.manager.wait();
  h.connections[0].handler = async () => {
    h.connections[0].complete("fast");
    return { disposition: "started" };
  };
  await h.manager.send(agent.id, "instant", false);
  assert.equal((await h.manager.wait()).result?.output, "fast");
  assert.equal(h.completions.length, 2);
});

test("rejects unknown targets and blank inputs", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  await assert.rejects(h.spawn({ task_name: " " }), /blank/);
  await assert.rejects(h.manager.send("missing", "hi", false), /Unknown agent/);
  const agent = await h.spawn();
  await assert.rejects(h.manager.send(agent.id, " ", false), /blank/);
});

test("cancelling startup leaves no child running", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  const controller = new AbortController();
  const starting = h.spawn({ signal: controller.signal });
  controller.abort();
  await assert.rejects(starting);
  assert.equal(h.connections.length, 0);
  assert.equal(h.manager.list()[0].status, "failed");
});

test("shutdown during startup prevents launching a child", async () => {
  const h = harness();
  const starting = h.spawn();
  const rejection = assert.rejects(starting, /session is closed/);
  await h.manager.dispose();
  await rejection;
  assert.equal(h.connections.length, 0);
});

test("a crash after idle still emits a failure notice", async (t) => {
  const h = harness();
  t.after(() => h.manager.dispose());
  await h.spawn();
  h.connections[0].complete();
  await h.manager.wait();
  h.connections[0].options.onFailure(new Error("idle process exited"));
  assert.match((await h.manager.wait()).result!.error!, /idle process exited/);
  assert.equal(h.completions.length, 2);
});
