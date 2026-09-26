import test from "node:test";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import {
  buildRuntimeConfig,
  extractBlockedWritePath,
  initializeSandbox,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/runtime.ts";

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
  });
  assert.equal(runtime.network.allowedDomains.includes("example.com"), true);
  assert.equal(runtime.filesystem.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem.allowWrite.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network.allowedDomains.includes("example.com"), false);
  assert.equal(SandboxRuntimeConfigSchema.safeParse(runtime).success, true);
  assert.equal("enabled" in runtime, false);
});

test("buildRuntimeConfig rejects wildcard allowlists from saved config and session allowances", () => {
  const legacyConfig = mergeConfig(DEFAULT_CONFIG, { network: { allowedDomains: ["*"] } });
  assert.throws(() => buildRuntimeConfig(legacyConfig), /Invalid domain pattern/);
  assert.throws(
    () => buildRuntimeConfig(DEFAULT_CONFIG, { domains: ["*"], readPaths: [], writePaths: [] }),
    /Invalid domain pattern/,
  );
});

test("initializeSandbox rejects a legacy wildcard allowlist before runtime initialization", async () => {
  const config = mergeConfig(DEFAULT_CONFIG, { network: { allowedDomains: ["*"] } });
  await assert.rejects(initializeSandbox(config), /Invalid domain pattern/);
});

test("buildRuntimeConfig strips obsolete properties before passing config to the runtime", () => {
  const config = {
    ...DEFAULT_CONFIG,
    network: { ...DEFAULT_CONFIG.network, legacyNetworkOption: true },
    legacyOption: true,
  };
  const runtime = buildRuntimeConfig(config);
  assert.equal("legacyOption" in runtime, false);
  assert.equal("legacyNetworkOption" in runtime.network, false);
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: { ...DEFAULT_CONFIG.filesystem, allowRead: [], allowWrite: ["/configured-write"] },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });
  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});
