import { homedir } from "node:os";
import { resolve } from "node:path";

import { canonicalizePath, domainIsAllowed, matchesPattern, type SandboxConfig } from "sandbox";

export type AccessKind = "domain" | "read" | "write";
export type PromptKind = AccessKind | "unsandboxed" | "disable";
export type Choice = "abort" | "session" | "global";

export function absoluteRule(value: string, cwd: string): string {
  return resolve(cwd, value.replace(/^~(?=$|\/)/, homedir()));
}

export function absolutePath(value: string, cwd: string): string {
  return canonicalizePath(absoluteRule(value, cwd));
}

// Never chdir the shared OpenCode server: relative rules belong to this Location,
// not the server's cwd or a command's optional workdir.
export function locationConfig(config: SandboxConfig, cwd: string): SandboxConfig {
  const paths = (values: string[] | undefined) => values?.map((value) => absoluteRule(value, cwd));
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      denyRead: paths(config.filesystem.denyRead) ?? [],
      allowRead: paths(config.filesystem.allowRead),
      allowWrite: paths(config.filesystem.allowWrite) ?? [],
      denyWrite: paths(config.filesystem.denyWrite) ?? [],
    },
  };
}

export function validateRule(kind: AccessKind, target: string, value: string, cwd: string): string {
  const rule = value.trim();
  if (!rule || rule.includes("\n") || rule.includes("\0"))
    throw new Error("Invalid empty or multiline rule");
  const matches =
    kind === "domain"
      ? domainIsAllowed(target, [rule])
      : matchesPattern(target, [absoluteRule(rule, cwd)]);
  if (!matches) throw new Error(`Rule must match "${target}"`);
  return kind === "domain"
    ? rule
    : rule.includes("*")
      ? absoluteRule(rule, cwd)
      : absolutePath(rule, cwd);
}

export interface FileAccess {
  kind: "read" | "write";
  path: string;
}

export function toolAccesses(tool: string, input: unknown): FileAccess[] {
  const args = input as Record<string, unknown>;
  if (!args || typeof args !== "object") throw new Error("Invalid tool input");
  if (tool === "patch" || tool === "apply_patch") {
    const patch = args.patchText ?? args.patch;
    if (typeof patch !== "string") throw new Error("Missing patch text");
    // Inspect every source, delete, and move destination before the built-in tool
    // reads files to prepare its diff. Added/context lines cannot match headers.
    const paths = [
      ...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm),
    ].map((match) => match[1].trim());
    if (!paths.length) throw new Error("Patch contains no file operations");
    return [...new Set(paths)].map((path) => ({ kind: "write", path }));
  }
  const kind = ["write", "edit"].includes(tool) ? "write" : "read";
  const path = args.path ?? args.filePath ?? (tool === "glob" || tool === "grep" ? "." : undefined);
  if (typeof path !== "string" || !path) throw new Error(`Missing path for ${tool}`);
  return [{ kind, path }];
}

export const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "patch",
  "apply_patch",
  "glob",
  "grep",
]);
