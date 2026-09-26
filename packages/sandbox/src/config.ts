import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SandboxConfig = SandboxRuntimeConfig & { enabled?: boolean };
type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local", "Library"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  return {
    ...base,
    ...overrides,
    network: overrides.network ? { ...base.network, ...overrides.network } : base.network,
    filesystem: overrides.filesystem
      ? { ...base.filesystem, ...overrides.filesystem }
      : base.filesystem,
  } as SandboxConfig;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function configuredArray(fallback: string[] | undefined, value: unknown): string[] | undefined {
  return stringArray(value) ?? fallback;
}

export function mergeConfig(defaults: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  const merged = mergeObjects(defaults, overrides);
  return {
    ...merged,
    network: {
      ...merged.network,
      allowedDomains:
        configuredArray(defaults.network?.allowedDomains, overrides.network?.allowedDomains) ?? [],
      deniedDomains:
        configuredArray(defaults.network?.deniedDomains, overrides.network?.deniedDomains) ?? [],
      allowUnixSockets: configuredArray(
        defaults.network?.allowUnixSockets,
        overrides.network?.allowUnixSockets,
      ),
      allowMachLookup: configuredArray(
        defaults.network?.allowMachLookup,
        overrides.network?.allowMachLookup,
      ),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead:
        configuredArray(defaults.filesystem?.denyRead, overrides.filesystem?.denyRead) ?? [],
      allowRead: configuredArray(defaults.filesystem?.allowRead, overrides.filesystem?.allowRead),
      allowWrite:
        configuredArray(defaults.filesystem?.allowWrite, overrides.filesystem?.allowWrite) ?? [],
      denyWrite:
        configuredArray(defaults.filesystem?.denyWrite, overrides.filesystem?.denyWrite) ?? [],
    },
  };
}

function readJsonConfig(configPath: string, warn: boolean): SandboxConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    return parsed as SandboxConfigFile;
  } catch (error) {
    if (warn) console.error(`Warning: Could not parse ${configPath}: ${error}`);
    return {};
  }
}

export function getConfigPath(): string {
  return join(homedir(), ".agents", "sandbox.json");
}

export function loadConfig(): SandboxConfig {
  return mergeConfig(DEFAULT_CONFIG, readJsonConfig(getConfigPath(), true));
}

function writeConfigFile(configPath: string, config: SandboxConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addDomainToConfig(configPath: string, domain: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.network?.allowedDomains) ?? [];
  if (existing.includes(domain)) return;
  config.network = { ...config.network, allowedDomains: [...existing, domain] };
  writeConfigFile(configPath, config);
}

export function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowRead) ?? [];
  if (existing.includes(pathToAdd)) return;
  config.filesystem = { ...config.filesystem, allowRead: [...existing, pathToAdd] };
  writeConfigFile(configPath, config);
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowWrite) ?? [];
  if (existing.includes(pathToAdd)) return;
  config.filesystem = { ...config.filesystem, allowWrite: [...existing, pathToAdd] };
  writeConfigFile(configPath, config);
}
