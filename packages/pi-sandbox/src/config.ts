import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig as loadSandboxConfig, type SandboxConfig } from "sandbox";

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

export function loadConfig(cwd: string): SandboxConfig {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  return loadSandboxConfig(globalPath, projectPath);
}
