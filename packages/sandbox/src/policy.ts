import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export function shouldPromptForWrite(path: string, allowWrite: string[]): boolean {
  return allowWrite.length === 0 || !matchesPattern(path, allowWrite);
}

export interface NetworkDestination {
  host: string;
  port: number;
}

export function extractDomainsFromCommand(command: string): NetworkDestination[] {
  const urlRegex =
    /\b(https?):\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::([0-9]{1,5}))?(?=[/?#\s"'`;)(|&<>]|$)/gi;
  const domains = new Map<string, NetworkDestination>();
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(command)) !== null) {
    const host = match[2].toLowerCase();
    const port =
      match[3] === undefined ? (match[1].toLowerCase() === "https" ? 443 : 80) : Number(match[3]);
    if (port < 1 || port > 65535) continue;
    domains.set(`${host}:${port}`, { host, port });
  }
  return [...domains.values()];
}

function splitPort(value: string): { host: string; port?: number } {
  const match = /^([^:]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) return { host: value };
  return { host: match[1], port: Number(match[2]) };
}

export function domainMatchesPattern(domain: string, pattern: string, port?: number): boolean {
  const target = port === undefined ? splitPort(domain) : { host: domain, port };
  const ruleTarget = splitPort(pattern);
  if (ruleTarget.port !== undefined && ruleTarget.port !== target.port) return false;
  const host = target.host.toLowerCase();
  const rule = ruleTarget.host.toLowerCase();
  if (rule.startsWith("*.")) {
    const base = rule.slice(2);
    return base.includes(".") && host.endsWith("." + base);
  }
  return rule !== "*" && host === rule;
}

export function domainIsAllowed(domain: string, allowedDomains: string[], port?: number): boolean {
  return allowedDomains.some((pattern) => domainMatchesPattern(domain, pattern, port));
}

function expandPath(filePath: string): string {
  return resolve(filePath.replace(/^~(?=$|\/)/, homedir()));
}

export function canonicalizePath(filePath: string): string {
  const absolutePath = expandPath(filePath);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return absolutePath;
    }
  }
}

export function matchesPattern(filePath: string, patterns: string[]): boolean {
  const absolutePath = canonicalizePath(filePath);
  return patterns.some((pattern) => {
    const absolutePattern = pattern.includes("*") ? expandPath(pattern) : canonicalizePath(pattern);
    if (pattern.includes("*")) {
      const escaped = absolutePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(absolutePath);
    }
    const separator = absolutePattern.endsWith("/") ? "" : "/";
    return absolutePath === absolutePattern || absolutePath.startsWith(absolutePattern + separator);
  });
}
