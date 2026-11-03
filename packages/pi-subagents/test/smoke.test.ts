import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

import { AgentManager } from "../src/agents.ts";
import { RpcConnection, type RecordValue } from "../src/rpc.ts";

test(
  "real Pi RPC child loads extensions, handles a command, and shuts down without a model request",
  { timeout: 30_000 },
  async (t) => {
    const packageDist = dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    const events: RecordValue[] = [];
    const manager = new AgentManager(
      { onChange() {}, onComplete() {}, onUI: async () => ({ cancelled: true }) },
      (options) => {
        const connection = new RpcConnection(
          {
            ...options,
            onEvent: (event) => {
              events.push(event);
              options.onEvent(event);
            },
          },
          {
            command: process.execPath,
            args: [join(packageDist, "bundle/cli.js"), "--mode", "rpc", ...options.args],
          },
        );
        return connection;
      },
    );
    t.after(() => manager.dispose());
    const agent = await manager.spawn({
      task_name: "probe",
      message: "/subagents-probe",
      cwd: process.cwd(),
      args: [
        "--offline",
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "-e",
        fileURLToPath(new URL("../index.ts", import.meta.url)),
        "-e",
        fileURLToPath(new URL("./fixtures/probe.ts", import.meta.url)),
      ],
    });
    assert.equal(agent.status, "idle");
    assert.match((await manager.wait()).result!.output, /handled by an extension/);
    const probeEvent = events.find(
      (event) => event.type === "extension_ui_request" && event.method === "notify",
    );
    assert.ok(probeEvent, "probe extension must load");
    const probe = JSON.parse(probeEvent.message);
    assert.equal(probe.child, "1");
    assert.ok(!probe.tools.includes("spawn_agent"), "nested spawning must not be available");
    assert.equal(probe.cwd, process.cwd());
  },
);
