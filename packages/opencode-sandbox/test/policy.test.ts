import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "sandbox";
import { describe, expect, test } from "vitest";

import { absolutePath, locationConfig, toolAccesses, validateRule } from "../src/policy.ts";

describe("location policy", () => {
  test("anchors relative rules without changing the host cwd", () => {
    const cwd = process.cwd();
    const config = locationConfig(DEFAULT_CONFIG, "/project");
    expect(config.filesystem.allowWrite).toContain("/project");
    expect(config.filesystem.denyWrite).toContain("/project/*.key");
    expect(process.cwd()).toBe(cwd);
    expect(DEFAULT_CONFIG.filesystem.allowWrite).toContain(".");
  });
  test("canonicalizes a symlink and a not-yet-created destination", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-sandbox-policy-"));
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "link"));
    expect(absolutePath("link/new.txt", root)).toBe(absolutePath("outside/new.txt", root));
  });
  test("validates edited paths and destination ports", () => {
    expect(validateRule("write", "/project/src/file", "src", "/project")).toBe("/project/src");
    expect(validateRule("domain", "api.example.org:8443", "*.example.org:8443", "/project")).toBe(
      "*.example.org:8443",
    );
    expect(() =>
      validateRule("domain", "api.example.org:8443", "*.example.org:443", "/project"),
    ).toThrow();
    expect(() => validateRule("read", "/elsewhere/file", "src", "/project")).toThrow();
    expect(() => validateRule("domain", "example.org:443", "*", "/project")).toThrow();
  });
});

test("patch preflight includes reads/deletes and both rename paths", () => {
  expect(
    toolAccesses("patch", {
      patchText:
        "*** Begin Patch\n*** Update File: old.txt\n*** Move to: ../new.txt\n@@\n-x\n+y\n*** Delete File: remove.txt\n*** Add File: add.txt\n+*** Delete File: fake.txt\n*** End Patch",
    }),
  ).toEqual(
    ["old.txt", "../new.txt", "remove.txt", "add.txt"].map((path) => ({ kind: "write", path })),
  );
});

test("search defaults to Location root and invalid file input fails closed", () => {
  expect(toolAccesses("grep", { pattern: "abc" })).toEqual([{ kind: "read", path: "." }]);
  expect(() => toolAccesses("read", {})).toThrow();
  expect(() => toolAccesses("patch", { patchText: "bad" })).toThrow();
});
