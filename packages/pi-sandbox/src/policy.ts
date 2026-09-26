import type { ApplyPatchMutation } from "pi-apply-patch/src/index.ts";

import { resolve } from "node:path";

import { canonicalizePath } from "sandbox";

export function resolveApplyPatchWritePaths(
  cwd: string,
  mutations: ApplyPatchMutation[],
): string[] {
  const paths = mutations.flatMap((mutation) =>
    mutation.operation === "update" && mutation.movePath
      ? [mutation.path, mutation.movePath]
      : [mutation.path],
  );
  return [...new Set(paths.map((filePath) => canonicalizePath(resolve(cwd, filePath))))];
}
