import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  addSessionAccessRequests,
  assertAccessRequestsUnchanged,
  assertAccessRequestsWritable,
  formatAccessRequestMessage,
  formatAccessRequestTitle,
  matchesPattern,
  resolveAccessRequests,
  resolveAllowances,
  DEFAULT_CONFIG,
  type SessionAllowances,
} from "../index.ts";

const dirs: string[] = [];
function fixture() {
  const dir = realpathSync(
    execFileSync("mktemp", ["-d", "-p", "/tmp", "sandbox-access.XXXXXX"], {
      encoding: "utf8",
    }).trim(),
  );
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("normalizes and deduplicates requests without losing access types", () => {
  const cwd = fixture();
  const requests = resolveAccessRequests(
    {
      requests: [
        { path: "@file", access: "read" },
        { path: "./file", access: "read" },
        { path: "file", access: "write" },
      ],
    },
    cwd,
  );
  expect(requests).toEqual([
    { path: join(cwd, "file"), target: join(cwd, "file"), access: "read" },
    { path: join(cwd, "file"), target: join(cwd, "file"), access: "write" },
  ]);
  expect(resolveAccessRequests({ requests: [{ path: "~", access: "read" }] }, cwd)[0].path).toBe(
    homedir(),
  );
});

test("tidy prompts show arrows only for symlinks and list each batch access", () => {
  const normal = { path: "/project/config", target: "/project/config", access: "read" as const };
  const link = { ...normal, target: "/shared/config" };
  expect(formatAccessRequestTitle([normal])).toBe("Allow read access for this session?");
  expect(formatAccessRequestMessage([normal])).toBe("  /project/config");
  expect(formatAccessRequestMessage([link])).toBe("  /project/config → /shared/config");
  const batch = [link, { path: "/output", target: "/output", access: "write" as const }];
  expect(formatAccessRequestTitle(batch)).toBe("Allow filesystem access for this session?");
  expect(formatAccessRequestMessage(batch)).toBe(
    "  read  /project/config → /shared/config\n  write /output",
  );
});

test("resolves chained, parent, and dangling symlinks", () => {
  const cwd = fixture();
  mkdirSync(join(cwd, "real"));
  symlinkSync("real", join(cwd, "parent"));
  symlinkSync("parent/new", join(cwd, "first"));
  symlinkSync("first", join(cwd, "second"));
  const requests = resolveAccessRequests(
    {
      requests: [
        { path: "parent/new/child", access: "write" },
        { path: "second", access: "write" },
      ],
    },
    cwd,
  );
  expect(requests.map((request) => request.target)).toEqual([
    join(cwd, "real/new/child"),
    join(cwd, "real/new"),
  ]);
  assertAccessRequestsUnchanged(requests);
});

test("target changes require approval again and do not expand prior grants", () => {
  const cwd = fixture();
  writeFileSync(join(cwd, "first"), "");
  writeFileSync(join(cwd, "second"), "");
  symlinkSync("first", join(cwd, "link"));
  const requests = resolveAccessRequests({ requests: [{ path: "link", access: "read" }] }, cwd);
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };
  addSessionAccessRequests(allowances, requests);
  expect(matchesPattern(join(cwd, "link"), allowances.readPaths)).toBe(true);
  expect(matchesPattern(join(cwd, "first"), allowances.readPaths)).toBe(true);
  unlinkSync(join(cwd, "link"));
  symlinkSync("second", join(cwd, "link"));
  expect(() => assertAccessRequestsUnchanged(requests)).toThrow("target changed");
  expect(matchesPattern(join(cwd, "link"), allowances.readPaths)).toBe(false);
});

test("write grants imply reads and directory grants include descendants", () => {
  const cwd = fixture();
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };
  const requests = resolveAccessRequests({ requests: [{ path: "new", access: "write" }] }, cwd);
  addSessionAccessRequests(allowances, requests);
  addSessionAccessRequests(allowances, requests);
  expect(allowances.writePaths).toEqual([join(cwd, "new")]);
  const effective = resolveAllowances(
    {
      ...DEFAULT_CONFIG,
      filesystem: { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] },
    },
    allowances,
  );
  expect(matchesPattern(join(cwd, "new/child"), effective.readPaths)).toBe(true);
  expect(matchesPattern(join(cwd, "new/child"), effective.writePaths)).toBe(true);
  expect(matchesPattern(join(cwd, "newer"), effective.readPaths)).toBe(false);
});

test("hard write denies apply to requested names and resolved targets", () => {
  const cwd = fixture();
  writeFileSync(join(cwd, "secret"), "");
  symlinkSync("secret", join(cwd, "alias"));
  symlinkSync("secret", join(cwd, ".env.local"));
  const request = (path: string) =>
    resolveAccessRequests({ requests: [{ path, access: "write" }] }, cwd);
  expect(() => assertAccessRequestsWritable(request("alias"), ["secret"], cwd)).toThrow(
    "denyWrite",
  );
  expect(() => assertAccessRequestsWritable(request(".env.local"), [".env.*"], cwd)).toThrow(
    "denyWrite",
  );
  expect(() =>
    assertAccessRequestsWritable(
      resolveAccessRequests({ requests: [{ path: "alias", access: "read" }] }, cwd),
      ["secret"],
      cwd,
    ),
  ).not.toThrow();
});

test.each([
  {},
  { requests: [] },
  { requests: [{ path: "", access: "read" }] },
  { requests: [{ path: "file", access: "execute" }] },
  { requests: [{ path: "a\nb", access: "read" }] },
  { requests: [{ path: "*.ts", access: "read" }] },
  { requests: [{ path: "~/.ss?", access: "read" }] },
  { requests: [{ path: "[.]env-dir", access: "write" }] },
  { requests: [{ path: "dir]", access: "read" }] },
])("invalid input fails closed: %j", (input) => {
  expect(() => resolveAccessRequests(input, fixture())).toThrow();
});

test("symlinks to glob-like targets fail closed", () => {
  const cwd = fixture();
  mkdirSync(join(cwd, "dir?"));
  symlinkSync("dir?", join(cwd, "alias"));
  expect(() =>
    resolveAccessRequests({ requests: [{ path: "alias", access: "read" }] }, cwd),
  ).toThrow("unsupported characters");
});

test("dangling relative links resolve against the real parent", () => {
  const cwd = fixture();
  mkdirSync(join(cwd, "b", "c"), { recursive: true });
  symlinkSync(join(cwd, "b", "c"), join(cwd, "a"));
  symlinkSync("../x", join(cwd, "b", "c", "link"));
  expect(resolveAccessRequests({ requests: [{ path: "a/link", access: "read" }] }, cwd)).toEqual([
    { path: join(cwd, "a", "link"), target: join(cwd, "b", "x"), access: "read" },
  ]);
});

test("loops and oversized prompts fail rather than displaying partial paths", () => {
  const cwd = fixture();
  symlinkSync("loop", join(cwd, "loop"));
  expect(() =>
    resolveAccessRequests({ requests: [{ path: "loop", access: "read" }] }, cwd),
  ).toThrow();
  expect(() =>
    resolveAccessRequests(
      {
        requests: Array.from({ length: 32 }, (_, i) => ({
          path: `${i}/${"a/".repeat(130)}`,
          access: "read",
        })),
      },
      cwd,
    ),
  ).toThrow("smaller batch");
});
