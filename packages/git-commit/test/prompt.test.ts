import { test } from "node:test";

import assert from "node:assert/strict";

import { compactDiff, firstSubject, makePrompt } from "../src/prompt.ts";

test("compact diff preserves filenames and hunk content only", () => {
  const diff = `diff --git a/one.ts b/one.ts
index 123..456 100644
--- a/one.ts
+++ b/one.ts
@@ -1,2 +1,2 @@
 context
-old
+new
\\ No newline at end of file
diff --git a/two.ts b/two.ts
new file mode 100644
--- /dev/null
+++ b/two.ts
@@ -0,0 +1 @@
+addition
`;
  assert.equal(
    compactDiff(diff),
    "a/one.ts b/one.ts\n context\n-old\n+new\na/two.ts b/two.ts\n+addition",
  );
});

test("prompt includes instructions, recent subjects, and the selected diff", () => {
  const prompt = makePrompt("Previous subject\n", "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n");
  assert.match(prompt, /under 100 characters/);
  assert.match(prompt, /style context\):\nPrevious subject\n/);
  assert.match(prompt, /Selected Git diff:\na\/a b\/a\n-old\n\+new\n$/);
});

test("only the first nonempty subject is used, including editor output", () => {
  assert.equal(firstSubject("\n \r\n Add feedback support \r\nExtra line"), "Add feedback support");
  assert.equal(firstSubject("\n \t\r\n"), "");
});
