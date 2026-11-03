import { test } from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

import { RpcConnection, resourceArgs, type RecordValue } from "../src/rpc.ts";

function peer(deadline = 2000) {
  const failures: Error[] = [];
  const events: RecordValue[] = [];
  const connection = new RpcConnection(
    {
      cwd: process.cwd(),
      args: [],
      onEvent: (event) => {
        events.push(event);
      },
      onFailure: (error) => {
        failures.push(error);
      },
    },
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/rpc-peer.ts", import.meta.url))],
    },
    deadline,
  );
  return { connection, failures, events };
}

test("strict JSONL preserves Unicode separators and split UTF-8", async (t) => {
  const { connection } = peer();
  t.after(() => connection.stop());
  const text = "hello 😀\u2028world\u2029";
  assert.equal((await connection.request({ type: "echo", text })).text, text);
  const [a, b] = await Promise.all([
    connection.request({ type: "echo", text: "a😀" }),
    connection.request({ type: "echo", text: "b😀" }),
  ]);
  assert.equal(a.text, "a😀");
  assert.equal(b.text, "b😀");
});

test("command errors, deadlines, and cancellation reject promptly", async (t) => {
  const { connection } = peer(300);
  t.after(() => connection.stop());
  await assert.rejects(connection.request({ type: "error" }), /rejected/);
  await assert.rejects(connection.request({ type: "silent" }), /timed out/);
  const controller = new AbortController();
  const pending = connection.request({ type: "silent" }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("unexpected exit rejects pending commands and reports stderr", async (t) => {
  const { connection, failures } = peer();
  t.after(() => connection.stop());
  await assert.rejects(connection.request({ type: "exit" }), /crash detail/);
  assert.equal(failures.length, 1);
});

test("malformed stdout fails closed", async (t) => {
  const { connection } = peer();
  t.after(() => connection.stop());
  await assert.rejects(connection.request({ type: "malformed" }), /Invalid Pi RPC/);
});

test("forwards UI records and can stop a SIGTERM-resistant process", async (t) => {
  const { connection, events } = peer();
  t.after(() => connection.stop());
  await connection.request({ type: "dialog" });
  assert.equal(events[0].method, "confirm");
  connection.reply({ type: "extension_ui_response", id: "dialog-1", confirmed: false });
  await connection.request({ type: "ignore-term" });
  await connection.stop();
  await connection.stop();
});

test("forwards resource options but not parent session/model options", () => {
  assert.deepEqual(
    resourceArgs([
      "--session",
      "parent.jsonl",
      "--model",
      "other",
      "-e",
      "permission-gate.ts",
      "--skill=skill.ts",
      "--no-extensions",
      "--append-system-prompt",
      "instructions.txt",
      "--exclude-tools",
      "write,mcp__*",
      "--",
      "-e",
      "not-an-extension",
    ]),
    [
      "-e",
      "permission-gate.ts",
      "--skill=skill.ts",
      "--no-extensions",
      "--append-system-prompt",
      "instructions.txt",
      "--exclude-tools",
      "write,mcp__*",
    ],
  );
});
