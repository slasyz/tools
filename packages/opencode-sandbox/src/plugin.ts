import type { Context } from "@opencode/plugin/promise/plugin";
import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
import type { ToolContext } from "@opencode/plugin/promise/tool";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  domainIsAllowed,
  extractDomainsFromCommand,
  getConfigPath,
  loadConfig,
  matchesPattern,
  resolveAllowances,
  type SessionAllowances,
} from "sandbox";

import {
  absolutePath,
  absoluteRule,
  FILE_TOOLS,
  locationConfig,
  toolAccesses,
  validateRule,
  type AccessKind,
} from "./policy.ts";
import { Prompts, type PromptReply } from "./prompts.ts";
import { SandboxRpc } from "./rpc.ts";
import { createWorkerExecutables, sandboxShell, ShellTickets, workerRoot } from "./shell.ts";

// OpenCode V2 has no separate promptGuidelines field; tool descriptions carry
// tool-specific instructions to the model.
const UNSANDBOXED_DESCRIPTION = [
  "Execute a shell command outside the sandbox after explicit user approval for this invocation. Uses OpenCode's standard shell output limits, timeouts, cancellation, and background jobs.",
  "Use shell by default. Use shell_unsandboxed only when the user explicitly requests unsandboxed execution, shell fails due to a sandbox restriction, or clear evidence shows the command will hit one.",
  "When shell fails because of sandbox filesystem, permission, or network restrictions, use shell_unsandboxed for the same command without first asking in chat; this tool requests explicit user approval. Before retrying, check whether the failed command made partial changes and whether repeating it is safe. Do not use shell_unsandboxed for unrelated commands or ordinary command errors.",
  "Use shell_unsandboxed without a trial shell call when clear evidence shows the command will hit a sandbox filesystem, permission, or network restriction.",
].join("\n\n");

export async function setupSandbox(ctx: Context) {
  if (ctx.location.workspaceID !== undefined)
    throw new Error("opencode-sandbox requires a local server Location, not a remote workspace");
  const cwd = ctx.location.directory;
  const config = () => {
    const current = locationConfig(loadConfig(), cwd);
    // Shared protection across all Location workers: a command must not replace
    // another Location's launcher or the launcher of its own next invocation.
    current.filesystem.denyWrite = [...current.filesystem.denyWrite, workerRoot()];
    return current;
  };
  const states = new Map<string, { enabled?: boolean; allowances: SessionAllowances }>();
  const prompts = new Prompts();
  const tickets = new ShellTickets();
  const shutdown = new AbortController();
  // Lazily create executable aliases so OpenCode still recognizes bash/zsh
  // syntax when it scans the original command for native permissions.
  let workers: ReturnType<typeof createWorkerExecutables> | undefined;
  const state = (sessionID: string) => {
    let value = states.get(sessionID);
    if (!value) {
      value = { allowances: { domains: [], readPaths: [], writePaths: [] } };
      states.set(sessionID, value);
    }
    return value;
  };
  const enabled = (sessionID: string) => state(sessionID).enabled ?? config().enabled !== false;
  const effective = (sessionID: string) => resolveAllowances(config(), state(sessionID).allowances);
  const checkSession = async (sessionID: string) => {
    const session = await ctx.session.get({ sessionID });
    if (session.location.directory !== cwd) {
      throw new Error("Sandbox request belongs to another Location");
    }
  };
  const status = (sessionID: string) => ({
    enabled: enabled(sessionID),
    configPath: getConfigPath(),
    // Shared config merging includes optional undefined fields, which are not
    // valid RPC JSON values. Return a detached, JSON-safe status snapshot.
    config: JSON.parse(JSON.stringify(config())),
    allowances: state(sessionID).allowances,
  });

  async function grant(sessionID: string, kind: AccessKind, target: string, signal?: AbortSignal) {
    if (kind === "write" && matchesPattern(target, config().filesystem.denyWrite)) {
      throw new Error(`Sandbox: "${target}" is in denyWrite; edit ${getConfigPath()} to change it`);
    }
    if (kind === "domain" && domainIsAllowed(target, config().network.deniedDomains)) {
      throw new Error(`Sandbox: "${target}" is in deniedDomains`);
    }
    const reply = await prompts.ask(
      { sessionID, kind, target, title: `${kind} access blocked: ${target}` },
      signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal,
    );
    if (signal?.aborted || shutdown.signal.aborted)
      throw new Error("Sandbox authorization cancelled");
    if (reply.action === "abort") throw new Error(`Sandbox: ${kind} access denied for "${target}"`);
    const value = validateRule(kind, target, reply.value, cwd);
    // Recheck hard denies after approval, which may have outlived a config edit.
    if (kind === "write" && matchesPattern(target, config().filesystem.denyWrite))
      throw new Error("Sandbox: write denied");
    if (kind === "domain" && domainIsAllowed(target, config().network.deniedDomains))
      throw new Error("Sandbox: domain denied");
    if (reply.action === "global") {
      if (!reply.confirmed) throw new Error("Global sandbox rule requires confirmation");
      const writer =
        kind === "domain"
          ? addDomainToConfig
          : kind === "read"
            ? addReadPathToConfig
            : addWritePathToConfig;
      writer(getConfigPath(), value);
    }
    const list =
      state(sessionID).allowances[
        kind === "domain" ? "domains" : kind === "read" ? "readPaths" : "writePaths"
      ];
    if (!list.includes(value)) list.push(value);
  }

  async function authorizeFile(
    sessionID: string,
    kind: "read" | "write",
    path: string,
    signal?: AbortSignal,
  ) {
    if (!enabled(sessionID)) return;
    const logical = absoluteRule(path, cwd);
    if (kind === "write" && (logical === workerRoot() || logical.startsWith(`${workerRoot()}/`))) {
      throw new Error("Sandbox: worker launchers are protected from writes");
    }
    const target = absolutePath(path, cwd);
    if (kind === "write" && matchesPattern(target, config().filesystem.denyWrite)) {
      throw new Error(`Sandbox: "${target}" is in denyWrite`);
    }
    const allowances = effective(sessionID);
    if (!matchesPattern(target, kind === "read" ? allowances.readPaths : allowances.writePaths)) {
      await grant(sessionID, kind, target, signal);
    }
  }

  const handlers: RpcHandlers<typeof SandboxRpc> = {
    status: async (input) => {
      const { sessionID } = input as { sessionID: string };
      await checkSession(sessionID);
      return status(sessionID);
    },
    poll: async (input) => {
      const { sessionID, clientID } = input as { sessionID: string; clientID: string };
      await checkSession(sessionID);
      return prompts.poll(sessionID, clientID);
    },
    claim: async (input) => {
      const { id, clientID } = input as { id: string; clientID: string };
      return prompts.claim(id, clientID);
    },
    reply: async (input) => {
      const { id, clientID, ...reply } = input as PromptReply & { id: string; clientID: string };
      prompts.reply(id, clientID, reply);
      return null;
    },
    control: async (input, rpcContext) => {
      const {
        sessionID,
        command,
        arguments: args,
      } = input as { sessionID: string; command: string; arguments: string };
      await checkSession(sessionID);
      if (command === "enable") state(sessionID).enabled = true;
      else if (command === "disable") {
        const reply = await prompts.ask(
          {
            sessionID,
            kind: "disable",
            target: cwd,
            title: "Disable sandbox for this session? Tool shell and file checks will be bypassed.",
          },
          rpcContext.signal,
        );
        if (rpcContext.signal.aborted || shutdown.signal.aborted)
          throw new Error("Sandbox disable cancelled");
        if (reply.action === "abort" || !reply.confirmed)
          throw new Error("Sandbox disable cancelled");
        state(sessionID).enabled = false;
      } else if (command === "allow") {
        const match = /^(domain|read|write)\s+(.+)$/.exec(args.trim());
        if (!match) throw new Error("Usage: /sandbox-allow <domain|read|write> <rule>");
        const kind = match[1] as AccessKind;
        await grant(
          sessionID,
          kind,
          kind === "domain" ? match[2] : absolutePath(match[2], cwd),
          rpcContext.signal,
        );
      } else throw new Error("Unknown sandbox command");
      return status(sessionID);
    },
  };
  // Declared RPC failures retain actionable denial/validation messages in the
  // TUI, instead of becoming an opaque "internal RPC error".
  const protectedHandlers = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      async (input: unknown, context: Parameters<typeof handler>[1]) => {
        try {
          return await handler(input, context);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return context.error("denied", reason, { reason });
        }
      },
    ]),
  ) as RpcHandlers<typeof SandboxRpc>;
  await ctx.rpc.register(SandboxRpc, protectedHandlers);

  // Preflight before the original executor prepares any diff or reads a file.
  // Wrapping executors also supplies cancellation, including Code Mode calls.
  await ctx.tool.transform((editor) => {
    for (const name of FILE_TOOLS)
      editor.update(name, (tool) => {
        const execute = tool.execute;
        tool.execute = async (input, context) => {
          if (enabled(context.sessionID))
            for (const access of toolAccesses(name, input)) {
              await authorizeFile(context.sessionID, access.kind, access.path, context.signal);
            }
          return execute(input, context);
        };
      });
  });
  await ctx.permission.hook("evaluate", async (event) => {
    // Native denies remain final; never auto-allow or replace OpenCode's asks.
    if (!["read", "edit", "write"].includes(event.action)) return;
    try {
      for (const path of event.resources)
        await authorizeFile(event.sessionID, event.action === "read" ? "read" : "write", path);
    } catch (error) {
      event.effect = "deny";
      event.message = error instanceof Error ? error.message : String(error);
    }
  });

  await ctx.tool.transform((editor) => {
    const shell = editor.get("shell");
    if (!shell) throw new Error("opencode-sandbox requires OpenCode V2's shell tool");
    const execute = shell.execute;
    const invoke = async (input: unknown, context: ToolContext, unsandboxed: boolean) => {
      const args = input as { command: string; workdir?: string };
      if (typeof args.command !== "string") throw new Error("Missing shell command");
      if (unsandboxed) {
        const reply = await prompts.ask(
          {
            sessionID: context.sessionID,
            kind: "unsandboxed",
            target: `Working directory: ${absolutePath(args.workdir ?? cwd, cwd)}\n\n${args.command}`,
            title: "Run this command OUTSIDE the sandbox?",
          },
          context.signal,
        );
        if (reply.action === "abort" || !reply.confirmed)
          throw new Error("Unsandboxed command denied");
      }
      if (context.signal.aborted || shutdown.signal.aborted)
        throw new Error("Shell invocation cancelled");
      const ticket = tickets.issue({
        command: args.command,
        sessionID: context.sessionID,
        unsandboxed,
        signal: context.signal,
      });
      try {
        return await execute({ ...(input as object), command: ticket.marker }, context);
      } finally {
        ticket.dispose();
      }
    };
    editor.update("shell", (tool) => {
      tool.execute = (input, context) => invoke(input, context, false);
    });
    editor.add({
      name: "shell_unsandboxed",
      input: shell.input,
      output: shell.output,
      description: UNSANDBOXED_DESCRIPTION,
      options: { permission: shell.options?.permission, codemode: false },
      execute: (input, context) => invoke(input, context, true),
    });
  });

  await ctx.shell.hook("create.before", async (event) => {
    const ticket = tickets.take(event.command);
    if (ticket) event.command = ticket.command;
    if (ticket?.unsandboxed || (ticket ? !enabled(ticket.sessionID) : config().enabled === false))
      return;
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Sandbox unsupported; command blocked");
    const current = config();
    const allowances = ticket ? effective(ticket.sessionID) : resolveAllowances(current);
    for (const destination of extractDomainsFromCommand(event.command)) {
      const target = `${destination.host}:${destination.port}`;
      if (domainIsAllowed(target, current.network.deniedDomains))
        throw new Error(`Sandbox: ${target} is in deniedDomains`);
      if (!domainIsAllowed(target, allowances.domains)) {
        if (!ticket)
          throw new Error(
            `Sandbox: network access denied for ${target}; no session associated with shell`,
          );
        await grant(ticket.sessionID, "domain", target, ticket.signal);
      }
    }
    const latest = ticket ? effective(ticket.sessionID) : allowances;
    workers ??= createWorkerExecutables();
    const executable = workers.forShell(event.shell);
    sandboxShell(
      event,
      {
        ...current,
        network: { ...current.network, allowedDomains: latest.domains },
        filesystem: {
          ...current.filesystem,
          allowRead: latest.readPaths,
          allowWrite: latest.writePaths,
        },
      },
      executable,
    );
  });

  await ctx.session.hook("context", (event) => {
    event.system.push({
      type: "text",
      text: enabled(event.sessionID)
        ? "Sandbox enabled: shell processes have OS filesystem/network restrictions; file tools have approval checks. Blocked access requires user approval. Never blindly retry a failed shell command: check for partial changes and whether repeating it is safe. shell_unsandboxed requests explicit user approval for every invocation; use it for sandbox restrictions as described in that tool's instructions."
        : "Sandbox disabled for this session. OpenCode's native permissions still apply.",
    });
  });

  return () => {
    shutdown.abort();
    prompts.close();
    states.clear();
    workers?.close();
  };
}
