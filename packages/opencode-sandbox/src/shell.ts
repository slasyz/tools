import type { ShellCreateBefore } from "@opencode/plugin/promise/shell";
import type { SandboxConfig } from "sandbox";

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_ENV = "OPENCODE_SANDBOX_WORKER";
export const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url));
export const workerRoot = () => join(homedir(), ".local", "share", "opencode-sandbox", "workers");
export interface ShellTicket {
  command: string;
  sessionID: string;
  unsandboxed: boolean;
  signal?: AbortSignal;
}

// One-use, server-generated tickets carry identity across the Promise/Effect
// boundary. Do not trust OPENCODE_SESSION_ID from a previous shell's environment.
export class ShellTickets {
  private tickets = new Map<string, ShellTicket>();
  issue(ticket: ShellTicket): { marker: string; dispose: () => void } {
    const marker = `# opencode-sandbox:${randomUUID()}`;
    this.tickets.set(marker, ticket);
    return { marker, dispose: () => this.tickets.delete(marker) };
  }
  take(command: string): ShellTicket | undefined {
    const ticket = this.tickets.get(command);
    this.tickets.delete(command);
    return ticket;
  }
}

export function createWorkerExecutables(root = workerRoot()) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, "opencode-sandbox-"));
  const names = new Set<string>();
  return {
    protectedRoot: root,
    forShell(shell: string) {
      const name = basename(shell);
      if (!["bash", "zsh", "sh", "dash", "ksh"].includes(name))
        throw new Error(`Unsupported sandbox shell: ${shell}`);
      const path = join(directory, name);
      if (!names.has(name)) {
        symlinkSync(workerPath, path);
        names.add(name);
      }
      return path;
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function sandboxShell(
  event: ShellCreateBefore,
  config: SandboxConfig,
  executable = workerPath,
): void {
  // Keep the original command visible to OpenCode's native scanner/permissions.
  // The executable accepts the same -c command convention as Unix shells.
  event.env[WORKER_ENV] = JSON.stringify({ config, shell: event.shell });
  event.shell = executable;
}
