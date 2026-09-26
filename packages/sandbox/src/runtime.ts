import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import type { SandboxConfig } from "./config.ts";

import { domainIsAllowed } from "./policy.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

export interface EffectiveAllowances extends SessionAllowances {}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function resolveAllowances(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): EffectiveAllowances {
  const writePaths = unique([
    ...(config.filesystem?.allowWrite ?? []),
    ...(allowances?.writePaths ?? []),
  ]);
  return {
    domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
    readPaths: unique([
      ...(config.filesystem?.allowRead ?? []),
      ...(allowances?.readPaths ?? []),
      ...writePaths,
    ]),
    writePaths,
  };
}

export function createNetworkAskCallback(allowedDomains: string[]): SandboxAskCallback {
  return async ({ host }) => domainIsAllowed(host, allowedDomains);
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): SandboxRuntimeConfig {
  const effective = resolveAllowances(config, allowances);
  const { enabled: _enabled, ...runtimeOptions } = config;
  return SandboxRuntimeConfigSchema.parse({
    ...runtimeOptions,
    network: {
      ...config.network,
      allowedDomains: effective.domains,
      deniedDomains: config.network?.deniedDomains ?? [],
    },
    filesystem: {
      ...config.filesystem,
      denyRead: config.filesystem?.denyRead ?? [],
      allowRead: effective.readPaths,
      allowWrite: effective.writePaths,
      denyWrite: config.filesystem?.denyWrite ?? [],
    },
    enableWeakerNetworkIsolation: true,
  });
}

export async function initializeSandbox(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
  await SandboxManager.initialize(
    runtimeConfig,
    createNetworkAskCallback(runtimeConfig.network.allowedDomains),
  );
}

export async function resetSandbox(): Promise<void> {
  await SandboxManager.reset();
}

export async function reinitializeSandbox(
  config: SandboxConfig,
  allowances: SessionAllowances,
): Promise<void> {
  await resetSandbox();
  await initializeSandbox(config, allowances);
}

export async function wrapWithSandbox(command: string, shell: string): Promise<string> {
  return SandboxManager.wrapWithSandbox(command, shell);
}

export function cleanupAfterCommand(): void {
  SandboxManager.cleanupAfterCommand();
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): Operation not permitted/,
  );
  return match ? match[1] : null;
}
