import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  createBashToolDefinition,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type ApplyPatchAuthorizationRequest,
  registerApplyPatchExtension,
} from "pi-apply-patch/src/index.ts";
import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  canonicalizePath,
  domainIsAllowed,
  extractBlockedWritePath,
  extractDomainsFromCommand,
  getConfigPath,
  initializeSandbox,
  loadConfig,
  matchesPattern,
  reinitializeSandbox,
  resetSandbox,
  resolveAllowances,
  shouldPromptForWrite,
  type SessionAllowances,
  supportsNodeEnvProxy,
} from "sandbox";

import { createSandboxedBashOps } from "./bash.ts";
import { resolveApplyPatchWritePaths } from "./policy.ts";
import {
  formatSandboxConfiguration,
  type PermissionPromptResult,
  promptDomainBlock,
  promptReadBlock,
  showPermissionPrompt,
  promptWriteBlock,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let sessionContext: ExtensionContext | undefined;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };

  const effectiveAllowances = () => resolveAllowances(loadConfig(), allowances);
  const effectiveDomains = () => effectiveAllowances().domains;
  const effectiveReadPaths = () => effectiveAllowances().readPaths;
  const effectiveWritePaths = () => effectiveAllowances().writePaths;

  async function refreshSandbox(): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      await reinitializeSandbox(loadConfig(), allowances);
    } catch (error) {
      sandboxInitialized = false;
      console.error(`Warning: Failed to reinitialize sandbox: ${error}`);
      throw new Error("Sandbox reinitialization failed; commands remain blocked", { cause: error });
    }
  }

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
  ): Promise<void> {
    const target = getConfigPath();

    if (kind === "domain") {
      if (!allowances.domains.includes(value)) allowances.domains.push(value);
      if (choice !== "session") addDomainToConfig(target, value);
    } else if (kind === "read") {
      if (!allowances.readPaths.includes(value)) allowances.readPaths.push(value);
      if (choice !== "session") addReadPathToConfig(target, value);
    } else {
      if (!allowances.writePaths.includes(value)) allowances.writePaths.push(value);
      if (choice !== "session") addWritePathToConfig(target, value);
    }
    await refreshSandbox();
  }

  async function enableSandbox(
    ctx: ExtensionContext,
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    const wasEnabled = sandboxEnabled;
    const config = loadConfig();
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    try {
      await initializeSandbox(config, allowances);
      if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      sandboxEnabled = true;
      sandboxInitialized = true;
      return true;
    } catch (error) {
      sandboxEnabled = wasEnabled;
      sandboxInitialized = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return false;
    }
  }

  async function authorizeApplyPatch(request: ApplyPatchAuthorizationRequest): Promise<void> {
    if (!sandboxEnabled) return;
    if (!sandboxInitialized) throw new Error("Sandbox is unavailable; patch blocked");

    const config = loadConfig();
    if (!config.enabled) return;
    if (!sessionContext) throw new Error("Sandbox: session context is unavailable");

    const paths = resolveApplyPatchWritePaths(request.cwd, request.mutations);
    const denyWrite = config.filesystem?.denyWrite ?? [];
    const deniedPath = paths.find((path) => matchesPattern(path, denyWrite));
    if (deniedPath) {
      throw new Error(
        `Sandbox: write access denied for "${deniedPath}" (in denyWrite). ` +
          `To change this, edit denyWrite in:\n  ${getConfigPath()}`,
      );
    }

    for (const path of paths) {
      if (!shouldPromptForWrite(path, effectiveWritePaths())) continue;
      const choice = await promptWriteBlock(pi, sessionContext, path);
      if (choice.action === "abort") {
        throw new Error(`Sandbox: write access denied for "${path}" (not in allowWrite)`);
      }
      await applyChoice(choice.action, "write", choice.value);
    }
  }

  registerApplyPatchExtension(pi, { authorize: authorizeApplyPatch });

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const runBash = () => {
        if (!sandboxEnabled) {
          return localBash.execute(id, params, signal, onUpdate, ctx);
        }
        if (!sandboxInitialized) throw new Error("Sandbox is unavailable; bash blocked");
        return createBashToolDefinition(localCwd, {
          operations: createSandboxedBashOps(userShellPath),
          shellPath: userShellPath,
        }).execute(id, params, signal, onUpdate, ctx);
      };

      let result: AgentToolResult<any>;
      try {
        result = await runBash();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Operation not permitted")) {
          throw error;
        }
        result = {
          content: [
            {
              type: "text",
              text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
            },
          ],
          details: {},
        };
      }

      if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
        const output = result.content
          .filter((content: any) => content.type === "text")
          .map((content: any) => content.text)
          .join("\n");
        const blockedPath = extractBlockedWritePath(output);
        if (blockedPath) {
          const choice = await promptWriteBlock(pi, ctx, blockedPath);
          if (choice.action !== "abort") {
            await applyChoice(choice.action, "write", choice.value);
            const config = loadConfig();
            if (matchesPattern(blockedPath, config.filesystem?.denyWrite ?? [])) {
              ctx.ui.notify(
                `⚠️ "${choice.value}" was added to allowWrite, but "${blockedPath}" is also in denyWrite and will remain blocked.\n` +
                  `Check denyWrite in:\n  ${getConfigPath()}`,
                "warning",
              );
              return result;
            }
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `\n--- Write access granted for "${choice.value}", retrying ---\n`,
                },
              ],
              details: {},
            });
            return runBash();
          }
        }
      }
      return result;
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled) return;
    if (!sandboxInitialized) {
      return {
        result: {
          output: "Sandbox is unavailable; command blocked.",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    for (const domain of extractDomainsFromCommand(event.command)) {
      if (!domainIsAllowed(domain, effectiveDomains())) {
        const choice = await promptDomainBlock(pi, ctx, domain);
        if (choice.action === "abort") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyChoice(choice.action, "domain", choice.value);
      }
    }
    return { operations: createSandboxedBashOps(userShellPath) };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;
    if (!sandboxInitialized) return { block: true, reason: "Sandbox is unavailable; tool blocked" };
    const config = loadConfig();
    if (!config.enabled) return;

    if (isToolCallEventType("bash", event)) {
      for (const domain of extractDomainsFromCommand(event.input.command)) {
        if (!domainIsAllowed(domain, effectiveDomains())) {
          const choice = await promptDomainBlock(pi, ctx, domain);
          if (choice.action === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyChoice(choice.action, "domain", choice.value);
        }
      }
    }

    if (isToolCallEventType("read", event)) {
      const path = canonicalizePath(event.input.path);
      if (!matchesPattern(path, effectiveReadPaths())) {
        const choice = await promptReadBlock(pi, ctx, path);
        if (choice.action === "abort") {
          return { block: true, reason: `Sandbox: read access denied for "${path}"` };
        }
        await applyChoice(choice.action, "read", choice.value);
        return;
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = canonicalizePath((event.input as { path: string }).path);
      const denyWrite = config.filesystem?.denyWrite ?? [];
      if (matchesPattern(path, denyWrite)) {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${getConfigPath()}`,
        };
      }
      if (shouldPromptForWrite(path, effectiveWritePaths())) {
        const choice = await promptWriteBlock(pi, ctx, path);
        if (choice.action === "abort") {
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
          };
        }
        await applyChoice(choice.action, "write", choice.value);
        return;
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    if (!loadConfig().enabled) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    if (!sandboxInitialized) {
      sandboxEnabled = false;
      return;
    }
    try {
      await resetSandbox();
    } catch {
      // Ignore cleanup errors.
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (sandboxEnabled && sandboxInitialized) {
        ctx.ui.notify("Sandbox is already enabled", "info");
        return;
      }
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is already disabled", "info");
        return;
      }
      if (sandboxInitialized) {
        try {
          await resetSandbox();
        } catch {
          // Ignore cleanup errors.
        }
      }
      sandboxEnabled = false;
      sandboxInitialized = false;
      ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Prompt to allow a domain or read/write access to a file path",
    handler: async (args, ctx) => {
      const [kind, ...targetParts] = args.trim().split(/\s+/);
      const targetArg = targetParts.join(" ");
      if ((kind !== "domain" && kind !== "read" && kind !== "write") || !targetArg) {
        ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <domain-or-path>", "error");
        return;
      }
      const target = kind === "domain" ? targetArg : canonicalizePath(targetArg);
      const configKey =
        kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
      const choice = await showPermissionPrompt(
        pi,
        ctx,
        `Add ${target} to ${configKey}?`,
        target,
        (value) => {
          if (!value) return "Rule cannot be empty.";
          const matches =
            kind === "domain" ? domainIsAllowed(target, [value]) : matchesPattern(target, [value]);
          return matches ? null : `Rule must match "${target}".`;
        },
      );
      if (choice.action === "abort") {
        ctx.ui.notify("Allow cancelled", "info");
        return;
      }
      await applyChoice(choice.action, kind, choice.value);
      ctx.ui.notify(`Added ${choice.value} to ${configKey}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }
      ctx.ui.notify(formatSandboxConfiguration(loadConfig(), getConfigPath(), allowances), "info");
    },
  });
}
