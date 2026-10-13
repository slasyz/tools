import type { SandboxConfig, SessionAllowances } from "sandbox";

export interface SandboxStatus {
  enabled: boolean;
  configPath: string;
  config: SandboxConfig;
  allowances: SessionAllowances;
}

export function formatSandboxStatus(status: SandboxStatus): string {
  const list = (values: string[] | undefined) => values?.join(", ") || "(none)";
  return [
    `Sandbox: ${status.enabled ? "enabled" : "DISABLED"}`,
    `Config: ${status.configPath} (shared with Pi)`,
    "",
    `Allowed domains: ${list(status.config.network.allowedDomains)}`,
    `Denied domains: ${list(status.config.network.deniedDomains)}`,
    `Session domains: ${list(status.allowances.domains)}`,
    "",
    `Allow read: ${list(status.config.filesystem.allowRead)}`,
    `Deny read (OS): ${list(status.config.filesystem.denyRead)}`,
    `Allow write: ${list(status.config.filesystem.allowWrite)}`,
    `Deny write: ${list(status.config.filesystem.denyWrite)}`,
    `Session reads: ${list(status.allowances.readPaths)}`,
    `Session writes: ${list(status.allowances.writePaths)}`,
    "",
    "Write grants also grant reads. denyWrite and deniedDomains take precedence.",
    "Session grants expire when the plugin reloads; child sessions get their own grants.",
  ].join("\n");
}
