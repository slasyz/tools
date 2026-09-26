import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { canonicalizePath, DEFAULT_CONFIG } from "sandbox";
import { test } from "vitest";

import {
  authorizeSandboxRequest,
  resolveSandboxFileAccesses,
  type SandboxAuthorizationPolicy,
} from "../src/policy.ts";

test("resolves and deduplicates filesystem accesses against the request cwd", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-apply-patch-")));
  assert.deepEqual(
    resolveSandboxFileAccesses(root, [
      { kind: "write", path: "new.txt" },
      { kind: "read", path: "old.txt" },
      { kind: "write", path: "src.ts" },
      { kind: "write", path: "src.ts" },
    ]),
    [
      { kind: "write", path: join(root, "new.txt") },
      { kind: "read", path: join(root, "old.txt") },
      { kind: "write", path: join(root, "src.ts") },
    ],
  );
});

function createPolicy(
  overrides: Partial<SandboxAuthorizationPolicy> = {},
): SandboxAuthorizationPolicy {
  return {
    sandboxEnabled: true,
    sandboxInitialized: true,
    config: DEFAULT_CONFIG,
    configPath: "/config/sandbox.json",
    sessionContextAvailable: true,
    effectiveReadPaths: () => [],
    effectiveWritePaths: () => [],
    promptRead: async (path) => ({ action: "abort", value: path }),
    promptWrite: async (path) => ({ action: "abort", value: path }),
    applyChoice: async () => {},
    ...overrides,
  };
}

test("rejects the complete request when any write matches denyWrite", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-denied-patch-")));
  let prompts = 0;
  const authorization = authorizeSandboxRequest(
    {
      source: "test",
      cwd: root,
      accesses: [
        { kind: "write", path: "allowed.txt" },
        { kind: "write", path: ".env" },
      ],
    },
    createPolicy({
      config: {
        ...DEFAULT_CONFIG,
        filesystem: {
          ...DEFAULT_CONFIG.filesystem,
          denyWrite: [join(root, ".env")],
        },
      },
      promptWrite: async (path) => {
        prompts += 1;
        return { action: "session", value: path };
      },
    }),
  );

  await assert.rejects(authorization, /in denyWrite/);
  assert.equal(prompts, 0);
});

test("allows reads and writes already covered by their allow lists without prompting", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-allowed-patch-")));
  let prompts = 0;

  await authorizeSandboxRequest(
    {
      source: "test",
      cwd: root,
      accesses: [
        { kind: "read", path: "old.txt" },
        { kind: "write", path: "new.txt" },
      ],
    },
    createPolicy({
      effectiveReadPaths: () => [root],
      effectiveWritePaths: () => [root],
      promptRead: async (path) => {
        prompts += 1;
        return { action: "abort", value: path };
      },
      promptWrite: async (path) => {
        prompts += 1;
        return { action: "abort", value: path };
      },
    }),
  );

  assert.equal(prompts, 0);
});

test("reuses a session-approved write rule for later paths in one request", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-session-patch-")));
  const sessionWritePaths: string[] = [];
  let prompts = 0;

  await authorizeSandboxRequest(
    {
      source: "test",
      cwd: root,
      accesses: [
        { kind: "write", path: "one.txt" },
        { kind: "write", path: "nested/two.txt" },
      ],
    },
    createPolicy({
      effectiveWritePaths: () => sessionWritePaths,
      promptWrite: async () => {
        prompts += 1;
        return { action: "session", value: root };
      },
      applyChoice: async (_choice, _kind, value) => {
        sessionWritePaths.push(value);
      },
    }),
  );

  assert.equal(prompts, 1);
  assert.deepEqual(sessionWritePaths, [root]);
});

test("blocks requests when the enabled sandbox is unavailable", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-unavailable-patch-")));

  await assert.rejects(
    authorizeSandboxRequest(
      {
        source: "test",
        cwd: root,
        accesses: [{ kind: "write", path: "new.txt" }],
      },
      createPolicy({ sandboxInitialized: false }),
    ),
    /Sandbox is unavailable; operation blocked/,
  );
});

test("treats an aborted write prompt as an authorization rejection", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-aborted-patch-")));
  let appliedChoices = 0;

  await assert.rejects(
    authorizeSandboxRequest(
      {
        source: "test",
        cwd: root,
        accesses: [{ kind: "write", path: "new.txt" }],
      },
      createPolicy({
        promptWrite: async (path) => ({ action: "abort", value: path }),
        applyChoice: async () => {
          appliedChoices += 1;
        },
      }),
    ),
    /not in allowWrite/,
  );
  assert.equal(appliedChoices, 0);
});

test("blocks requests while the sandbox is disabled", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-disabled-patch-")));
  let prompts = 0;

  await assert.rejects(
    authorizeSandboxRequest(
      {
        source: "test",
        cwd: root,
        accesses: [{ kind: "write", path: ".env" }],
      },
      createPolicy({
        sandboxEnabled: false,
        promptWrite: async (path) => {
          prompts += 1;
          return { action: "abort", value: path };
        },
      }),
    ),
    /Sandbox is inactive; operation blocked/,
  );

  assert.equal(prompts, 0);
});
