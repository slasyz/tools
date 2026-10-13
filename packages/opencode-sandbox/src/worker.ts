#!/usr/bin/env node
import { spawn } from "node:child_process";

import {
  initializeSandbox,
  wrapWithSandbox,
  cleanupAfterCommand,
  resetSandbox,
  type SandboxConfig,
} from "sandbox";

// This executable owns one runtime, proxy pair, and command. Never initialize
// SandboxManager in OpenCode's multi-location server process.
async function main(): Promise<number> {
  if (process.argv[2] !== "-c" || typeof process.argv[3] !== "string")
    throw new Error("Expected -c command");
  const raw = process.env.OPENCODE_SANDBOX_WORKER;
  delete process.env.OPENCODE_SANDBOX_WORKER;
  if (!raw) throw new Error("Missing sandbox policy; command blocked");
  const { config, shell } = JSON.parse(raw) as { config: SandboxConfig; shell: string };
  if (!config || typeof shell !== "string" || !shell.startsWith("/"))
    throw new Error("Invalid sandbox policy");
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await initializeSandbox(config);
    if (stopped) return 130;
    const command = await wrapWithSandbox(process.argv[3], shell);
    if (stopped) return 130;
    return await new Promise<number>((resolve, reject) => {
      // Inherit OpenCode's detached process group so its cancellation/timeout
      // kills worker, proxies, and all subprocesses together.
      const child = spawn(shell, ["-c", command], { stdio: "inherit", env: process.env });
      const forward = () => child.kill("SIGTERM");
      process.on("SIGTERM", forward);
      process.on("SIGINT", forward);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        process.off("SIGTERM", forward);
        process.off("SIGINT", forward);
        resolve(code ?? (signal ? 128 : 1));
      });
    });
  } finally {
    cleanupAfterCommand();
    await resetSandbox();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    `Sandbox unavailable; command blocked: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
