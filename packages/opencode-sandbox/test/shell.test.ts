import { DEFAULT_CONFIG } from "sandbox";
import { expect, test } from "vitest";

import { sandboxShell, ShellTickets, WORKER_ENV, workerPath } from "../src/shell.ts";

test("shell tickets are opaque, single-use, and disposable", () => {
  const tickets = new ShellTickets();
  const ticket = { command: "echo hi", sessionID: "a", unsandboxed: false };
  const issued = tickets.issue(ticket);
  expect(tickets.take("# opencode-sandbox:forged")).toBeUndefined();
  expect(tickets.take(issued.marker)).toEqual(ticket);
  expect(tickets.take(issued.marker)).toBeUndefined();
  const abandoned = tickets.issue(ticket);
  abandoned.dispose();
  expect(tickets.take(abandoned.marker)).toBeUndefined();
});

test("shell adapter preserves commands, timeouts, and environment for native permissions/jobs", () => {
  const event = {
    command: "echo hi",
    cwd: "/project",
    timeout: 123,
    shell: "/bin/bash",
    env: { EXISTING: "yes" } as Record<string, string>,
  };
  sandboxShell(event, DEFAULT_CONFIG);
  expect(event.command).toBe("echo hi");
  expect(event.timeout).toBe(123);
  expect(event.shell).toBe(workerPath);
  expect(event.env.EXISTING).toBe("yes");
  expect(JSON.parse(event.env[WORKER_ENV]).shell).toBe("/bin/bash");
});
