import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  matchesPattern,
  shouldPromptForWrite,
} from "../src/policy.ts";

test("extracts and deduplicates literal HTTP destinations by host and port", () => {
  assert.deepEqual(
    extractDomainsFromCommand(
      "curl https://api.example.com/a https://api.example.com:443/b http://api.example.com/c http://api.example.com:8080/d",
    ),
    [
      { host: "api.example.com", port: 443 },
      { host: "api.example.com", port: 80 },
      { host: "api.example.com", port: 8080 },
    ],
  );
  assert.deepEqual(extractDomainsFromCommand("curl https://api.example.com:99999/"), []);
});

test("extracts HTTP destinations before shell operators", () => {
  assert.deepEqual(extractDomainsFromCommand("curl https://example.com|cat"), [
    { host: "example.com", port: 443 },
  ]);
  assert.deepEqual(extractDomainsFromCommand("curl https://example.com:8443&&echo done"), [
    { host: "example.com", port: 8443 },
  ]);
  assert.deepEqual(extractDomainsFromCommand("curl http://example.com; echo done"), [
    { host: "example.com", port: 80 },
  ]);
  assert.deepEqual(extractDomainsFromCommand("curl https://example.com>output.txt"), [
    { host: "example.com", port: 443 },
  ]);
});

test("matches exact and subdomain policies but not an all-domain wildcard", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("github.com", ["*.github.com"]), false);
  assert.equal(domainIsAllowed("API.GitHub.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(domainIsAllowed("github.com", ["*"]), false);
});

test("port-scoped rules match only the requested port", () => {
  assert.equal(domainIsAllowed("example.com", ["example.com:443"], 443), true);
  assert.equal(domainIsAllowed("example.com", ["example.com:443"], 80), false);
  assert.equal(domainIsAllowed("example.com", ["example.com:443"]), false);
  assert.equal(domainIsAllowed("example.com:443", ["example.com:443"]), true);
  assert.equal(domainIsAllowed("example.com:8443", ["example.com:443"]), false);
  assert.equal(domainIsAllowed("example.com:8443", ["example.com"]), true);
  assert.equal(domainIsAllowed("api.example.com", ["*.example.com:8443"], 8443), true);
  assert.equal(domainIsAllowed("api.example.com", ["*.example.com:8443"], 443), false);
  assert.equal(domainIsAllowed("example.com", ["*.example.com:8443"], 8443), false);
  assert.equal(domainIsAllowed("EXAMPLE.COM", ["example.com:443"], 443), true);
  assert.equal(domainIsAllowed("example.com", ["*:443"], 443), false);
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
