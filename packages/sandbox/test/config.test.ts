import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfig,
  mergeConfig,
} from "../src/config.ts";

test("mergeConfig uses configured arrays instead of defaults", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    network: {
      allowedDomains: ["example.com", "shared.example.com"],
      deniedDomains: ["blocked.example.com"],
      allowUnixSockets: ["/custom.sock"],
    },
    filesystem: { allowRead: ["/custom", "/shared"], denyWrite: ["custom.key"] },
  });

  assert.deepEqual(merged.network.allowedDomains, ["example.com", "shared.example.com"]);
  assert.deepEqual(merged.network.deniedDomains, ["blocked.example.com"]);
  assert.deepEqual(merged.network.allowUnixSockets, ["/custom.sock"]);
  assert.deepEqual(merged.filesystem.allowRead, ["/custom", "/shared"]);
  assert.deepEqual(merged.filesystem.denyWrite, ["custom.key"]);
});

test("mergeConfig ignores malformed permission arrays", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    filesystem: { denyWrite: "*.key" as unknown as string[] },
  });
  assert.deepEqual(merged.filesystem.denyWrite, DEFAULT_CONFIG.filesystem.denyWrite);
});

test("mergeConfig uses defaults for missing arrays", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { enabled: false, filesystem: { allowWrite: [] } });
  assert.equal(merged.enabled, false);
  assert.deepEqual(merged.filesystem.allowWrite, []);
  assert.deepEqual(merged.filesystem.allowRead, DEFAULT_CONFIG.filesystem.allowRead);
  assert.deepEqual(merged.network.allowedDomains, DEFAULT_CONFIG.network.allowedDomains);
});

test("permission writers only persist the property being changed", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-config-"));
  const configPath = join(root, "nested", "sandbox.json");
  addReadPathToConfig(configPath, "/read");
  addWritePathToConfig(configPath, "/write");
  addDomainToConfig(configPath, "example.com");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    network: { allowedDomains: ["example.com"] },
    filesystem: { allowRead: ["/read"], allowWrite: ["/write"] },
  });
  assert.equal(readFileSync(configPath, "utf8").endsWith("\n"), true);
});

test("loadConfig reads only ~/.agents/sandbox.json and ignores malformed JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-paths-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  try {
    process.env.HOME = root;
    process.chdir(root);
    const configPath = join(root, ".agents", "sandbox.json");
    assert.equal(getConfigPath(), configPath);
    mkdirSync(join(root, ".agents"));
    mkdirSync(join(root, ".pi"));
    writeFileSync(join(root, ".pi", "sandbox.json"), JSON.stringify({ enabled: false }));
    writeFileSync(
      configPath,
      JSON.stringify({ network: { allowedDomains: ["configured.example.com"] } }),
    );
    assert.equal(loadConfig().enabled, true);
    assert.deepEqual(loadConfig().network.allowedDomains, ["configured.example.com"]);
    writeFileSync(configPath, "not JSON");
    assert.deepEqual(loadConfig().network.allowedDomains, DEFAULT_CONFIG.network.allowedDomains);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
