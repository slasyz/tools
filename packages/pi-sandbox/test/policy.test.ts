import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { canonicalizePath, DEFAULT_CONFIG } from "sandbox";
import { test } from "vitest";

import {
  authorizeApplyPatchRequest,
  resolveApplyPatchWritePaths,
  type ApplyPatchAuthorizationPolicy,
} from "../src/policy.ts";

test("resolves every apply_patch write path against the request cwd once", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-apply-patch-")));
  assert.deepEqual(
    resolveApplyPatchWritePaths(root, [
      { operation: "add", path: "new.txt" },
      { operation: "delete", path: "old.txt" },
      { operation: "update", path: "src.ts" },
      { operation: "update", path: "before.ts", movePath: "nested/after.ts" },
      { operation: "update", path: "src.ts" },
    ]),
    [
      join(root, "new.txt"),
      join(root, "old.txt"),
      join(root, "src.ts"),
      join(root, "before.ts"),
      join(root, "nested", "after.ts"),
    ],
  );
});

function createPolicy(
  overrides: Partial<ApplyPatchAuthorizationPolicy> = {},
): ApplyPatchAuthorizationPolicy {
  return {
    sandboxEnabled: true,
    sandboxInitialized: true,
    config: DEFAULT_CONFIG,
    configPath: "/config/sandbox.json",
    sessionContextAvailable: true,
    effectiveWritePaths: () => [],
    promptWrite: async (path) => ({ action: "abort", value: path }),
    applyWriteChoice: async () => {},
    ...overrides,
  };
}

test("rejects the complete apply_patch request when any path matches denyWrite", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-denied-patch-")));
  let prompts = 0;
  const authorization = authorizeApplyPatchRequest(
    {
      cwd: root,
      patchText: "parsed patch",
      mutations: [
        { operation: "add", path: "allowed.txt" },
        { operation: "update", path: "source.txt", movePath: ".env" },
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

test("allows paths already covered by allowWrite without prompting", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-allowed-patch-")));
  let prompts = 0;

  await authorizeApplyPatchRequest(
    {
      cwd: root,
      patchText: "parsed patch",
      mutations: [
        { operation: "add", path: "new.txt" },
        { operation: "delete", path: "old.txt" },
        { operation: "update", path: "before.txt", movePath: "after.txt" },
      ],
    },
    createPolicy({
      effectiveWritePaths: () => [root],
      promptWrite: async (path) => {
        prompts += 1;
        return { action: "abort", value: path };
      },
    }),
  );

  assert.equal(prompts, 0);
});

test("reuses a session-approved write rule for later paths in the same patch", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-session-patch-")));
  const sessionWritePaths: string[] = [];
  let prompts = 0;

  await authorizeApplyPatchRequest(
    {
      cwd: root,
      patchText: "parsed patch",
      mutations: [
        { operation: "add", path: "one.txt" },
        { operation: "add", path: "nested/two.txt" },
      ],
    },
    createPolicy({
      effectiveWritePaths: () => sessionWritePaths,
      promptWrite: async () => {
        prompts += 1;
        return { action: "session", value: root };
      },
      applyWriteChoice: async (_choice, value) => {
        sessionWritePaths.push(value);
      },
    }),
  );

  assert.equal(prompts, 1);
  assert.deepEqual(sessionWritePaths, [root]);
});

test("blocks patches when the enabled sandbox is unavailable", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-unavailable-patch-")));

  await assert.rejects(
    authorizeApplyPatchRequest(
      {
        cwd: root,
        patchText: "parsed patch",
        mutations: [{ operation: "add", path: "new.txt" }],
      },
      createPolicy({ sandboxInitialized: false }),
    ),
    /Sandbox is unavailable; patch blocked/,
  );
});

test("treats an aborted write prompt as an authorization rejection", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-aborted-patch-")));
  let appliedChoices = 0;

  await assert.rejects(
    authorizeApplyPatchRequest(
      {
        cwd: root,
        patchText: "parsed patch",
        mutations: [{ operation: "add", path: "new.txt" }],
      },
      createPolicy({
        promptWrite: async (path) => ({ action: "abort", value: path }),
        applyWriteChoice: async () => {
          appliedChoices += 1;
        },
      }),
    ),
    /not in allowWrite/,
  );
  assert.equal(appliedChoices, 0);
});

test("does not enforce apply_patch policy while the sandbox is disabled", async () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-disabled-patch-")));
  let prompts = 0;

  await authorizeApplyPatchRequest(
    {
      cwd: root,
      patchText: "parsed patch",
      mutations: [{ operation: "add", path: ".env" }],
    },
    createPolicy({
      sandboxEnabled: false,
      promptWrite: async (path) => {
        prompts += 1;
        return { action: "abort", value: path };
      },
    }),
  );

  assert.equal(prompts, 0);
});
