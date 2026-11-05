import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SandboxConfig = SandboxRuntimeConfig & {
  enabled?: boolean;
  /**
   * When "." is in allowRead or allowWrite, grant the same access to the git
   * common dir (the main worktree's .git). Lets linked worktrees commit.
   */
  allowGitCommonDir?: boolean;
};
type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  allowGitCommonDir: false,
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
    allowGitCommonDir:
      typeof overrides.allowGitCommonDir === "boolean"
        ? overrides.allowGitCommonDir
        : defaults.allowGitCommonDir,
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

function readGitDirPointer(dotGit: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
  return match ? resolve(dirname(dotGit), match[1]) : undefined;
}

/**
 * Find the git common dir for `cwd` by reading `.git` and `commondir` files,
 * without running git. In a linked worktree this is the main worktree's .git.
 */
export function findGitCommonDir(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (!stat.isFile()) return undefined;
      const gitDir = readGitDirPointer(dotGit);
      if (!gitDir) return undefined;
      const commonDirFile = join(gitDir, "commondir");
      return existsSync(commonDirFile)
        ? resolve(gitDir, readFileSync(commonDirFile, "utf-8").trim())
        : gitDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function withPath(paths: string[] | undefined, path: string): string[] | undefined {
  if (!paths?.includes(".") || paths.includes(path)) return paths;
  return [...paths, path];
}

/** Apply `allowGitCommonDir`: copy "." grants to the git common dir of `cwd`. */
export function expandGitCommonDir(config: SandboxConfig, cwd: string): SandboxConfig {
  const filesystem = config.filesystem;
  if (config.allowGitCommonDir !== true || !filesystem) return config;
  if (!filesystem.allowRead?.includes(".") && !filesystem.allowWrite.includes(".")) return config;
  const commonDir = findGitCommonDir(cwd);
  if (!commonDir) return config;
  return {
    ...config,
    filesystem: {
      ...filesystem,
      allowRead: withPath(filesystem.allowRead, commonDir),
      allowWrite: withPath(filesystem.allowWrite, commonDir) ?? [],
    },
  };
}

export function loadConfig(cwd: string = process.cwd()): SandboxConfig {
  return expandGitCommonDir(
    mergeConfig(DEFAULT_CONFIG, readJsonConfig(getConfigPath(), true)),
    cwd,
  );
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
