import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";
import { canonicalizePath } from "sandbox";

import { resolveApplyPatchWritePaths } from "../src/policy.ts";

test("resolves every apply_patch write path against the request cwd once", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-apply-patch-")));
  assert.deepEqual(
    resolveApplyPatchWritePaths(root, [
      { operation: "add", path: "new.txt" },
      { operation: "delete", path: "old.txt" },
      { operation: "update", path: "src.ts" },
      { operation: "update", path: "before.ts", movePath: "nested/after.ts" },
      { operation: "update", path: "src.ts" },
    ]),
    [
      join(root, "new.txt"),
      join(root, "old.txt"),
      join(root, "src.ts"),
      join(root, "before.ts"),
      join(root, "nested", "after.ts"),
    ],
  );
});
