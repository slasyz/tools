import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  matchesPattern,
  shouldPromptForWrite,
} from "../src/policy.ts";

test("extracts and deduplicates literal HTTP domains", () => {
  assert.deepEqual(
    extractDomainsFromCommand("curl https://api.example.com/a http://api.example.com/b"),
    ["api.example.com"],
  );
});

test("matches exact and subdomain policies but not an all-domain wildcard", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("github.com", ["*.github.com"]), false);
  assert.equal(domainIsAllowed("API.GitHub.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(domainIsAllowed("github.com", ["*"]), false);
});

test("empty allowWrite prompts securely", () => {
  assert.equal(shouldPromptForWrite("/tmp/file", []), true);
  assert.equal(shouldPromptForWrite("/tmp/file", ["/tmp"]), false);
});

test("path patterns support directory prefixes and globs", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "sandbox-policy-")));
  assert.equal(matchesPattern(join(root, "nested", "file.txt"), [root]), true);
  assert.equal(matchesPattern(join(root, "file.pem"), [join(root, "*.pem")]), true);
  assert.equal(matchesPattern(join(root, "file.txt"), [join(root, "*.pem")]), false);
});

test("canonicalizes symlinks and nonexistent descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-canonical-"));
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(
    canonicalizePath(join(link, "new", "file")),
    join(canonicalizePath(real), "new", "file"),
  );
});
