import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import assert from "node:assert/strict";

import type { Action } from "../src/input.ts";

import { makePrompt, MODELS } from "../src/prompt.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function setup(t: TestContext, initialCommit = true) {
  const root = execFileSync("mktemp", ["-d", "-p", "/tmp", "git-commit-test.XXXXXX"], {
    encoding: "utf8",
  }).trim();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  if (initialCommit) {
    writeFileSync(join(repo, "staged.txt"), "original staged\n");
    writeFileSync(join(repo, "unstaged.txt"), "original unstaged\n");
    git("add", ".");
    git("commit", "-m", "Initial test commit");
  }
  writeFileSync(
    join(bin, "pi"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(fixtures, "pi.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "fzf"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(fixtures, "fzf.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  const log = join(root, "pi-log.jsonl");
  const editorLog = join(root, "editor-log.jsonl");
  const editor = `${shellQuote(process.execPath)} ${shellQuote(join(fixtures, "editor.ts"))} "argument with spaces"`;

  function invoke(
    actions: Action[],
    outputs = ["Generated subject"],
    extraEnv: NodeJS.ProcessEnv = {},
    args: string[] = [],
  ) {
    return spawnSync(process.execPath, [join(fixtures, "run.ts"), ...args], {
      cwd: repo,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        VISUAL: editor,
        EDITOR: "false",
        TEST_ACTIONS: JSON.stringify(actions),
        TEST_PI_OUTPUTS: JSON.stringify(outputs),
        TEST_PI_LOG: log,
        TEST_EDITOR_LOG: editorLog,
        ...extraEnv,
      },
    });
  }

  function requests(): {
    args: string[];
    session: string;
    request: string;
    history: { role: string; text: string }[];
  }[] {
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  }
  return { root, repo, bin, git, invoke, requests, editorLog };
}

test("the package executable and help use git-commit", (t) => {
  const { invoke, requests } = setup(t);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.bin, { "git-commit": "./dist/cli.js" });
  const result = invoke([], [], {}, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Usage: git-commit [-s]\n  -s  Select a listed or custom model with fzf\n",
  );
  assert.deepEqual(requests(), []);
});

test("staged changes take priority and feedback continues the same conversation", (t) => {
  const { repo, git, invoke, requests } = setup(t);
  writeFileSync(join(repo, "staged.txt"), "new staged 😀\n");
  git("add", "staged.txt");
  const diffLines = git("diff", "--color=never", "--unified=1", "--cached").split("\n").length;
  writeFileSync(join(repo, "unstaged.txt"), "new unstaged\n");
  writeFileSync(join(repo, "untracked.txt"), "never add\n");
  const feedback = "-Focus on the staged change, not @another-file";
  const result = invoke(
    [
      { type: "feedback", text: feedback },
      { type: "feedback", text: "Shorter" },
      { type: "accept" },
    ],
    ["First subject", "Second subject", "Final subject"],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("log", "-1", "--format=%s"), "Final subject");
  assert.equal(git("show", "--format=", "--name-only", "HEAD"), "staged.txt");
  assert.match(git("status", "--porcelain"), / M unstaged.txt/);
  assert.match(git("status", "--porcelain"), /\?\? untracked.txt/);
  const calls = requests();
  assert.equal(calls.length, 3);
  const headings = stripVTControlCharacters(result.stdout).match(/^Proposed commit message.*$/gm)!;
  assert.equal(headings.length, 3);
  assert.match(
    headings[0],
    new RegExp(
      `^Proposed commit message \\(${Array.from(calls[0].request).length.toLocaleString("en-US")} chars, ${diffLines.toLocaleString("en-US")} LoC, \\d+\\.\\d{2}s\\)$`,
    ),
  );
  assert.deepEqual(headings.slice(1), ["Proposed commit message", "Proposed commit message"]);
  assert.match(calls[0].request, /Initial test commit/);
  assert.match(calls[0].request, /\+new staged/);
  assert.doesNotMatch(calls[0].request, /new unstaged/);
  assert.equal(calls[1].request, feedback);
  assert.equal(calls[1].history[1].text, "First subject");
  assert.equal(calls[2].history[3].text, "Second subject");
  assert.equal(new Set(calls.map((call) => call.session)).size, 1);
  assert.ok(calls[0].args.includes("--no-tools"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], MODELS[0]);
  assert.equal(existsSync(dirname(calls[0].session)), false);
});

test("without staged changes, commits all tracked changes but not untracked files", (t) => {
  const { repo, git, invoke } = setup(t);
  writeFileSync(join(repo, "staged.txt"), "tracked update\n");
  writeFileSync(join(repo, "unstaged.txt"), "other tracked update\n");
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  const result = invoke([{ type: "accept" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("show", "--format=", "--name-only", "HEAD"), "staged.txt\nunstaged.txt");
  assert.equal(git("status", "--porcelain"), "?? untracked.txt");
});

test("colored output keeps the request plain and shows a full Git diff separately", (t) => {
  const { repo, git, invoke, requests } = setup(t);
  git("config", "color.ui", "always");
  writeFileSync(join(repo, "staged.txt"), "new staged\n");
  git("add", "staged.txt");
  const expectedPrompt = makePrompt(
    git("log", "--color=never", "-n", "5", "--format=%s"),
    `${git("diff", "--color=never", "--unified=1", "--cached")}\n`,
  );
  const result = invoke([{ type: "accept" }], ["Style CLI output"], {
    FORCE_COLOR: "1",
    NO_COLOR: undefined,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\u001b\[/);
  assert.match(result.stdout, /\u001b\[90mGenerate a Git commit message/);
  assert.match(result.stdout, /\u001b\[90m  • Initial test commit\u001b\[39m/);
  assert.ok(
    result.stdout.includes("\u001b[1m\u001b[36mGenerating commit message with\u001b[39m\u001b[22m"),
  );
  assert.ok(result.stdout.includes(`\u001b[1m\u001b[37m${MODELS[0]}\u001b[39m\u001b[22m`));
  const plainOutput = stripVTControlCharacters(result.stdout);
  assert.match(plainOutput, /Recent commits \(style context\)\n  • Initial test commit/);
  assert.match(plainOutput, /Git diff\ndiff --git/);
  assert.match(plainOutput, /@@ -1 \+1 @@/);
  for (const text of ["-original staged", "+new staged"]) {
    const line = result.stdout.split("\n").find((line) => stripVTControlCharacters(line) === text);
    assert.ok(line);
    assert.match(line, /\u001b\[/);
  }
  assert.equal(requests()[0].request, expectedPrompt);
  assert.doesNotMatch(requests()[0].request, /\u001b\[/);
});

test("NO_COLOR disables styling even when Git is configured to always use colors", (t) => {
  const { repo, git, invoke, requests } = setup(t);
  git("config", "color.ui", "always");
  writeFileSync(join(repo, "staged.txt"), "new staged\n");
  const result = invoke([], ["Style CLI output"], { NO_COLOR: "1", FORCE_COLOR: undefined });
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stdout, /Recent commits \(style context\)\n  • Initial test commit/);
  assert.match(result.stdout, /Git diff\ndiff --git/);
  assert.match(result.stdout, /@@ -1 \+1 @@\n-original staged\n\+new staged/);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
  assert.doesNotMatch(requests()[0].request, /\u001b\[/);
});

test("no selected changes returns without calling Pi", (t) => {
  const { repo, git, invoke, requests } = setup(t);
  writeFileSync(join(repo, "untracked.txt"), "untracked only\n");
  const result = invoke([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git-commit: no tracked unstaged changes/);
  assert.deepEqual(requests(), []);
  assert.equal(git("log", "-1", "--format=%s"), "Initial test commit");
});

test("supports an initial commit without existing history", (t) => {
  const { repo, git, invoke } = setup(t, false);
  writeFileSync(join(repo, "new.txt"), "first content\n");
  git("add", "new.txt");
  const result = invoke([{ type: "accept" }], ["Create project"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("log", "-1", "--format=%s"), "Create project");
});

test("Ctrl-G action uses VISUAL with quoted arguments, then reviews the edited subject", (t) => {
  const { repo, git, invoke, editorLog } = setup(t);
  writeFileSync(join(repo, "staged.txt"), "update\n");
  const result = invoke([{ type: "edit" }, { type: "accept" }], ["Original subject"], {
    TEST_EDITOR_MESSAGE: "\nEdited subject\nIgnored second line\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("log", "-1", "--format=%s"), "Edited subject");
  assert.match(result.stdout, /Edited subject/);
  const headings = stripVTControlCharacters(result.stdout).match(/^Proposed commit message.*$/gm)!;
  assert.equal(headings.length, 2);
  assert.match(headings[0], /\([\d,]+ chars, [\d,]+ LoC, \d+\.\d{2}s\)$/);
  assert.equal(headings[1], "Proposed commit message");
  const editorArgs: string[] = JSON.parse(readFileSync(editorLog, "utf8").trim());
  assert.equal(editorArgs[0], "argument with spaces");
  assert.equal(existsSync(editorArgs[1]), false);
});

test("empty or failed editor keeps the proposed subject", (t) => {
  for (const env of [
    { TEST_EDITOR_MESSAGE: "\n \n" },
    { TEST_EDITOR_MESSAGE: "Do not use", TEST_EDITOR_EXIT: "1" },
  ]) {
    const { repo, git, invoke } = setup(t);
    writeFileSync(join(repo, "staged.txt"), "update\n");
    const result = invoke([{ type: "edit" }, { type: "accept" }], ["Keep original"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("log", "-1", "--format=%s"), "Keep original");
    assert.match(result.stderr, /keeping the proposed message/);
  }
});

test("feedback after editing includes the current edited subject", (t) => {
  const { repo, git, invoke, requests } = setup(t);
  writeFileSync(join(repo, "staged.txt"), "update\n");
  const result = invoke(
    [{ type: "edit" }, { type: "feedback", text: "Make it shorter" }, { type: "accept" }],
    ["Original subject", "Refined subject"],
    { TEST_EDITOR_MESSAGE: "Locally edited subject\n" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(requests()[1].request, /Locally edited subject/);
  assert.match(requests()[1].request, /Make it shorter/);
  assert.equal(git("log", "-1", "--format=%s"), "Refined subject");
});

test("empty output, generation failure, and cancellation never commit and clean temporary files", (t) => {
  for (const [outputs, env, actions] of [
    [["\n \n"], {}, [{ type: "accept" }]],
    [["Unused"], { TEST_PI_FAIL: "1" }, [{ type: "accept" }]],
    [["Unused"], {}, []],
  ] as [string[], NodeJS.ProcessEnv, Action[]][]) {
    const { repo, git, invoke, requests } = setup(t);
    writeFileSync(join(repo, "staged.txt"), "update\n");
    const result = invoke(actions, outputs, env);
    assert.notEqual(result.status, 0);
    assert.equal(git("log", "-1", "--format=%s"), "Initial test commit");
    assert.equal(existsSync(dirname(requests()[0].session)), false);
  }
});

test("-s selects the model with fzf", (t) => {
  const { repo, git, invoke, requests } = setup(t);
  writeFileSync(join(repo, "staged.txt"), "update\n");
  const result = invoke(
    [{ type: "accept" }],
    ["Selected model subject"],
    { TEST_FZF_OUTPUT: `${MODELS[1]}\n` },
    ["-s"],
  );
  assert.equal(result.status, 0, result.stderr);
  const args = requests()[0].args;
  assert.equal(args[args.indexOf("--model") + 1], MODELS[1]);
  assert.equal(git("log", "-1", "--format=%s"), "Selected model subject");
});

test("-s accepts a custom model when the query matches no listed model", (t) => {
  const { repo, git, invoke, requests } = setup(t);
  writeFileSync(join(repo, "staged.txt"), "update\n");
  const model = "custom-provider/custom-model";
  const result = invoke(
    [{ type: "accept" }],
    ["Custom model subject"],
    { TEST_FZF_OUTPUT: `${model}\n` },
    ["-s"],
  );
  assert.equal(result.status, 0, result.stderr);
  const args = requests()[0].args;
  assert.equal(args[args.indexOf("--model") + 1], model);
  assert.equal(git("log", "-1", "--format=%s"), "Custom model subject");
});

test("-s rejects cancellation, empty custom names, and fzf errors without calling Pi", (t) => {
  for (const env of [
    { TEST_FZF_OUTPUT: "custom-provider/model\n", TEST_FZF_EXIT: "130" },
    { TEST_FZF_OUTPUT: "\n", TEST_FZF_EXIT: "0" },
    { TEST_FZF_OUTPUT: " \t \n", TEST_FZF_EXIT: "0" },
    { TEST_FZF_OUTPUT: "", TEST_FZF_EXIT: "1" },
    { TEST_FZF_OUTPUT: "custom-provider/model\n", TEST_FZF_EXIT: "2" },
  ]) {
    const { repo, git, invoke, requests } = setup(t);
    writeFileSync(join(repo, "staged.txt"), "update\n");
    const result = invoke([], [], env, ["-s"]);
    assert.equal(result.status, 130, result.stderr);
    assert.match(result.stderr, /model selection cancelled/);
    assert.deepEqual(requests(), []);
    assert.equal(git("log", "-1", "--format=%s"), "Initial test commit");
  }
});

test("reports invalid arguments and directories outside a Git work tree", (t) => {
  const { repo, invoke, requests } = setup(t);
  const invalid = invoke([], [], {}, ["--invalid"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /git-commit: Usage: git-commit \[-s\]/);
  rmSync(join(repo, ".git"), { recursive: true });
  const result = invoke([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git-commit: not inside a Git work tree/);
  assert.deepEqual(requests(), []);
});
