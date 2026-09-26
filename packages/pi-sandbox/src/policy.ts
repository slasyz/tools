import { resolve } from "node:path";

import {
  canonicalizePath,
  matchesPattern,
  shouldPromptForWrite,
  type SandboxConfig,
} from "sandbox";

import type { SandboxAuthorizationRequest, SandboxFileAccess } from "./api.ts";

export type SandboxAccessChoice = {
  action: "abort" | "session" | "global";
  value: string;
};

export type SandboxAuthorizationPolicy = {
  sandboxEnabled: boolean;
  sandboxInitialized: boolean;
  config: SandboxConfig;
  configPath: string;
  sessionContextAvailable: boolean;
  effectiveReadPaths: () => string[];
  effectiveWritePaths: () => string[];
  promptRead: (path: string) => Promise<SandboxAccessChoice>;
  promptWrite: (path: string) => Promise<SandboxAccessChoice>;
  applyChoice: (
    choice: Exclude<SandboxAccessChoice["action"], "abort">,
    kind: SandboxFileAccess["kind"],
    value: string,
  ) => Promise<void>;
};

export type ResolvedSandboxFileAccess = SandboxFileAccess;

export function resolveSandboxFileAccesses(
  cwd: string,
  accesses: readonly SandboxFileAccess[],
): ResolvedSandboxFileAccess[] {
  const resolved: ResolvedSandboxFileAccess[] = [];
  const seen = new Set<string>();
  for (const access of accesses) {
    const path = canonicalizePath(resolve(cwd, access.path));
    const key = `${access.kind}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ kind: access.kind, path });
  }
  return resolved;
}

export async function authorizeSandboxRequest(
  request: SandboxAuthorizationRequest,
  policy: SandboxAuthorizationPolicy,
): Promise<void> {
  if (!policy.sandboxEnabled || !policy.config.enabled) {
    throw new Error("Sandbox is inactive; operation blocked");
  }
  if (!policy.sandboxInitialized) throw new Error("Sandbox is unavailable; operation blocked");
  if (!policy.sessionContextAvailable) {
    throw new Error("Sandbox: session context is unavailable");
  }

  const accesses = resolveSandboxFileAccesses(request.cwd, request.accesses);
  const denyWrite = policy.config.filesystem?.denyWrite ?? [];
  const deniedAccess = accesses.find(
    (access) => access.kind === "write" && matchesPattern(access.path, denyWrite),
  );
  if (deniedAccess) {
    throw new Error(
      `Sandbox: write access denied for "${deniedAccess.path}" (in denyWrite). ` +
        `To change this, edit denyWrite in:\n  ${policy.configPath}`,
    );
  }

  for (const access of accesses) {
    const allowedPaths =
      access.kind === "read" ? policy.effectiveReadPaths() : policy.effectiveWritePaths();
    const needsPrompt =
      access.kind === "read"
        ? !matchesPattern(access.path, allowedPaths)
        : shouldPromptForWrite(access.path, allowedPaths);
    if (!needsPrompt) continue;
    const choice =
      access.kind === "read"
        ? await policy.promptRead(access.path)
        : await policy.promptWrite(access.path);
    if (choice.action === "abort") {
      const allowList = access.kind === "read" ? "allowRead" : "allowWrite";
      throw new Error(
        `Sandbox: ${access.kind} access denied for "${access.path}" (not in ${allowList})`,
      );
    }
    await policy.applyChoice(choice.action, access.kind, choice.value);
  }
}
