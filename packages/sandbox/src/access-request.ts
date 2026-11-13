import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import type { SessionAllowances } from "./runtime.ts";

import { matchesPattern } from "./policy.ts";

export interface AccessRequest {
  path: string;
  access: "read" | "write";
}

export interface AccessRequestInput {
  requests: AccessRequest[];
}

export interface ResolvedAccessRequest extends AccessRequest {
  target: string;
}

export const ACCESS_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    requests: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      description: "File or directory access requests to approve together (up to 32).",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "File or directory path, not a glob.",
          },
          access: { type: "string", enum: ["read", "write"] },
        },
        required: ["path", "access"],
        additionalProperties: false,
      },
    },
  },
  required: ["requests"],
  additionalProperties: false,
};

export const ACCESS_REQUEST_DESCRIPTION = [
  "Request session-only read or write access to one or more files or directories. Prompts the user once to allow or deny the entire batch; do not ask for approval separately in chat. Never saves permanent rules.",
  "Use sandbox_request_access when an operation is blocked by sandbox filesystem restrictions, or you know it needs access outside current allowances. Prefer it to unsandboxed execution for grantable filesystem access. Request the narrowest paths and access types needed. Relative paths use the session working directory. Paths must be literal, not globs. Directory grants include descendants; write access also permits reads.",
  "Symlink requests show the requested path and resolved target. Approval covers access through the requested path and directly to that target. Hard write-deny rules cannot be overridden. Missing UI, denial, cancellation, or timeout grants nothing.",
  "Approval does not perform or retry the original operation. Before retrying, check for partial changes and whether repeating it is safe. If denied, do not retry or seek another way around the restriction.",
].join("\n\n");

// Control and bidi characters would hide the real path in the prompt. The
// runtime treats `*`, `?`, `[`, and `]` as globs, which would grant more than
// the literal path shown.
const UNSAFE_PATH_CHARS = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩*?[\]]/u;

function absolutePath(path: string, cwd: string): string {
  return resolve(cwd, path.replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()));
}

// Resolve missing children and dangling links too. A failed realpath must not
// turn a symlink into a dynamic allow rule for whatever it points to later.
function resolveTarget(path: string, links = 0): string {
  if (links > 40) throw new Error(`Sandbox: too many symlinks in "${path}"`);
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if (lstatSync(path).isSymbolicLink()) {
      // Resolve the parent first so `..` in the link text follows the real
      // directory, as the kernel does, not the alias spelling.
      const parent = resolveTarget(dirname(path), links + 1);
      return resolveTarget(resolve(parent, readlinkSync(path)), links + 1);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`Sandbox: cannot resolve "${path}"`);
  return resolve(resolveTarget(parent, links), basename(path));
}

export function resolveAccessRequests(input: unknown, cwd: string): ResolvedAccessRequest[] {
  const requests = (input as Partial<AccessRequestInput> | null)?.requests;
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 32) {
    throw new Error("Sandbox: requests must contain 1 to 32 paths");
  }
  const result: ResolvedAccessRequest[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (
      !request ||
      (request.access !== "read" && request.access !== "write") ||
      typeof request.path !== "string" ||
      !request.path.trim() ||
      UNSAFE_PATH_CHARS.test(request.path)
    ) {
      throw new Error("Sandbox: each request needs a literal path and read or write access");
    }
    const path = absolutePath(request.path, cwd);
    const target = resolveTarget(path);
    // Targets from symlinks must be just as safe to display and store as input.
    if (UNSAFE_PATH_CHARS.test(target)) {
      throw new Error("Sandbox: resolved path contains unsupported characters");
    }
    const key = `${request.access}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path, target, access: request.access });
  }
  if (formatAccessRequestMessage(result).length > 8000) {
    throw new Error("Sandbox: too many paths to display in full; request a smaller batch");
  }
  return result;
}

export function assertAccessRequestsUnchanged(requests: ResolvedAccessRequest[]): void {
  for (const request of requests) {
    if (resolveTarget(request.path) !== request.target) {
      throw new Error(`Sandbox: target changed for "${request.path}"; request approval again`);
    }
  }
}

export function assertAccessRequestsWritable(
  requests: ResolvedAccessRequest[],
  denyWrite: string[],
  cwd: string,
): void {
  const rules = denyWrite.map((rule) => absolutePath(rule, cwd));
  for (const request of requests) {
    if (request.access !== "write") continue;
    // Check the lexical alias too, so a symlink cannot hide a protected name.
    const deniedAlias = rules.some((rule) => {
      if (rule.includes("*")) {
        const escaped = rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`).test(request.path);
      }
      return (
        request.path === rule || request.path.startsWith(rule.endsWith("/") ? rule : `${rule}/`)
      );
    });
    if (deniedAlias || matchesPattern(request.target, rules)) {
      throw new Error(`Sandbox: write access denied for "${request.path}" (in denyWrite)`);
    }
  }
}

export function addSessionAccessRequests(
  allowances: SessionAllowances,
  requests: ResolvedAccessRequest[],
): void {
  for (const request of requests) {
    const list = request.access === "read" ? allowances.readPaths : allowances.writePaths;
    // Canonical checks grant access via the alias as well. Storing the alias
    // itself would silently authorize new targets if the symlink changed.
    if (!list.includes(request.target)) list.push(request.target);
  }
}

const plain = (value: string) => value;

export function formatAccessRequestTitle(
  requests: ResolvedAccessRequest[],
  styleAccess = plain,
): string {
  const access = requests.every((request) => request.access === requests[0].access)
    ? styleAccess(requests[0].access)
    : "filesystem";
  return `Allow ${access} access for this session?`;
}

export function formatAccessRequestMessage(
  requests: ResolvedAccessRequest[],
  stylePath = plain,
  styleAccess = plain,
): string {
  return requests
    .map((request) => {
      const access = requests.length > 1 ? `${styleAccess(request.access.padEnd(5))} ` : "";
      const path = stylePath(request.path);
      const target = request.path === request.target ? "" : ` → ${stylePath(request.target)}`;
      return `  ${access}${path}${target}`;
    })
    .join("\n");
}
