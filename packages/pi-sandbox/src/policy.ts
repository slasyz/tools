import type { ApplyPatchAuthorizationRequest, ApplyPatchMutation } from "pi-apply-patch";

import { resolve } from "node:path";

import {
  canonicalizePath,
  matchesPattern,
  shouldPromptForWrite,
  type SandboxConfig,
} from "sandbox";

export type ApplyPatchWriteChoice = {
  action: "abort" | "session" | "global";
  value: string;
};

export type ApplyPatchAuthorizationPolicy = {
  sandboxEnabled: boolean;
  sandboxInitialized: boolean;
  config: SandboxConfig;
  configPath: string;
  sessionContextAvailable: boolean;
  effectiveWritePaths: () => string[];
  promptWrite: (path: string) => Promise<ApplyPatchWriteChoice>;
  applyWriteChoice: (
    choice: Exclude<ApplyPatchWriteChoice["action"], "abort">,
    value: string,
  ) => Promise<void>;
};

export function resolveApplyPatchWritePaths(
  cwd: string,
  mutations: ApplyPatchMutation[],
): string[] {
  const paths = mutations.flatMap((mutation) =>
    mutation.operation === "update" && mutation.movePath
      ? [mutation.path, mutation.movePath]
      : [mutation.path],
  );
  return [...new Set(paths.map((filePath) => canonicalizePath(resolve(cwd, filePath))))];
}

export async function authorizeApplyPatchRequest(
  request: ApplyPatchAuthorizationRequest,
  policy: ApplyPatchAuthorizationPolicy,
): Promise<void> {
  if (!policy.sandboxEnabled) return;
  if (!policy.sandboxInitialized) throw new Error("Sandbox is unavailable; patch blocked");
  if (!policy.config.enabled) return;
  if (!policy.sessionContextAvailable) {
    throw new Error("Sandbox: session context is unavailable");
  }

  const paths = resolveApplyPatchWritePaths(request.cwd, request.mutations);
  const denyWrite = policy.config.filesystem?.denyWrite ?? [];
  const deniedPath = paths.find((path) => matchesPattern(path, denyWrite));
  if (deniedPath) {
    throw new Error(
      `Sandbox: write access denied for "${deniedPath}" (in denyWrite). ` +
        `To change this, edit denyWrite in:\n  ${policy.configPath}`,
    );
  }

  for (const path of paths) {
    if (!shouldPromptForWrite(path, policy.effectiveWritePaths())) continue;
    const choice = await policy.promptWrite(path);
    if (choice.action === "abort") {
      throw new Error(`Sandbox: write access denied for "${path}" (not in allowWrite)`);
    }
    await policy.applyWriteChoice(choice.action, choice.value);
  }
}
