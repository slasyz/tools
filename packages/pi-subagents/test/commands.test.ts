import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import type { AgentView } from "../src/agents.ts";

import { copyAgentSnapshot } from "../src/commands.ts";

async function harness(t: TestContext) {
  const cwd = await mkdtemp("/tmp/pi-subagents-menu-'$-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const session = join(cwd, "agent's session.jsonl");
  await writeFile(session, "{}\n", { flag: "wx", mode: 0o600 });
  const agents: AgentView[] = [
    { id: "agent-1", task_name: "starting", status: "starting", run: 1 },
    {
      id: "agent-2",
      task_name: "check\ncode\x1b[31m",
      status: "running",
      run: 1,
      session_file: session,
    },
  ];
  const answers: (number | undefined)[] = [0, 0];
  const menus: { title: string; options: string[] }[] = [];
  const notifications: { message: string; type: string }[] = [];
  const copied: string[] = [];
  const ctx = {
    mode: "tui",
    cwd,
    ui: {
      select: async (title: string, options: string[]) => {
        menus.push({ title, options });
        const index = answers.shift();
        return index === undefined ? undefined : options[index];
      },
      notify: (message: string, type: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;
  const copy = async (command: string) => {
    copied.push(command);
  };
  return { cwd, session, agents, answers, menus, notifications, copied, ctx, copy };
}

test("agent menu copies a shell-quoted fork command in the project directory", async (t) => {
  const h = await harness(t);
  await copyAgentSnapshot(h.ctx, h.agents, h.copy);
  assert.deepEqual(h.menus[0].options, ["agent-2 · running · check code [31m"]);
  assert.deepEqual(h.menus[1].options, ["Copy snapshot command"]);
  assert.match(h.menus[1].title, /not live/);
  assert.equal(h.copied.length, 1);
  // Replace Pi with a shell function to verify quoting without launching an agent.
  const output = execFileSync(
    "/bin/sh",
    ["-c", `pi() { printf '%s\\n' "$PWD" "$@"; }; ${h.copied[0]}`],
    { encoding: "utf8" },
  );
  assert.deepEqual(output.trim().split("\n"), [h.cwd, "--fork", h.session]);
  assert.equal(h.notifications.at(-1)?.type, "info");
  assert.match(h.notifications.at(-1)!.message, /copied/);
});

test("agent menu uses the selected agent, including idle and failed sessions", async (t) => {
  const h = await harness(t);
  h.agents[1].status = "idle";
  h.agents.push({ ...h.agents[1], id: "agent-3", status: "failed" });
  h.answers[0] = 1;
  await copyAgentSnapshot(h.ctx, h.agents, h.copy);
  assert.equal(h.menus[0].options.length, 2);
  assert.match(h.menus[1].title, /^agent-3/);
  assert.equal(h.copied.length, 1);
});

test("cancelling either agent menu does not change the clipboard", async (t) => {
  for (const answers of [[undefined], [0, undefined]]) {
    const h = await harness(t);
    h.answers.splice(0, h.answers.length, ...answers);
    await copyAgentSnapshot(h.ctx, h.agents, h.copy);
    assert.deepEqual(h.copied, []);
    assert.deepEqual(h.notifications, []);
  }
});

test("empty and starting-only agent lists do not open a picker", async (t) => {
  const h = await harness(t);
  for (const agents of [[], [h.agents[0]], [{ ...h.agents[0], session_file: h.session }]]) {
    await copyAgentSnapshot(h.ctx, agents, h.copy);
  }
  assert.deepEqual(h.menus, []);
  assert.deepEqual(h.copied, []);
  assert.equal(h.notifications.length, 3);
  assert.ok(h.notifications.every(({ message }) => /No subagent sessions/.test(message)));
});

test("non-terminal modes never prompt or access the clipboard", async (t) => {
  const h = await harness(t);
  for (const mode of ["rpc", "print", "json"] as const) {
    await copyAgentSnapshot({ ...h.ctx, mode }, h.agents, h.copy);
  }
  assert.deepEqual(h.menus, []);
  assert.deepEqual(h.copied, []);
  assert.ok(h.notifications.every(({ type }) => type === "warning"));
});

test("missing session files report an error instead of copying a stale command", async (t) => {
  const h = await harness(t);
  await rm(h.session);
  await copyAgentSnapshot(h.ctx, h.agents, h.copy);
  assert.deepEqual(h.copied, []);
  assert.match(h.notifications[0].message, /no longer available/);
  assert.equal(h.notifications[0].type, "error");
});

test("clipboard failure shows the command for manual copying", async (t) => {
  const h = await harness(t);
  await copyAgentSnapshot(h.ctx, h.agents, async () => {
    throw new Error("Clipboard unavailable");
  });
  assert.equal(h.notifications[0].type, "error");
  assert.match(h.notifications[0].message, /Clipboard unavailable/);
  assert.match(h.notifications[0].message, /Copy it manually:\ncd .* && pi --fork /);
});
